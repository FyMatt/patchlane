import { AgentCapabilityConfig, getAgentContextBudget, getAgentMaxToolRounds, getModelForTask, getModelMaxTokens, getModelTemperature, getModelTopP } from "../config";
import { ProviderRegistry } from "../providers/registry";
import { ChatTranscriptItem } from "./chatSessionService";
import { AgentToolAction, compactText, getToolActionKey, normalizeToolPlan, parsePlannerJson, ParsedToolPlan } from "./agentToolPlan";
import { readWorkspaceFile } from "./workspaceFiles";

export type AgentToolLoopStepStatus = "running" | "done" | "error";
export type AgentToolLoopStepKind = "think" | "tool" | "file" | "verify";

export interface AgentToolLoopCapabilityContext {
  skills: AgentCapabilityConfig[];
  tools: AgentCapabilityConfig[];
}

export interface AgentToolLoopRequest {
  prompt: string;
  transcript: ChatTranscriptItem[];
  capabilityContext: AgentToolLoopCapabilityContext;
  baseContext?: string;
  previousPlanContext?: string;
  webContext?: string;
  runWebSearch?: (query: string) => Promise<string | undefined>;
  runCapability?: (capability: AgentCapabilityConfig, input: string) => Promise<string | undefined>;
  runVerify?: () => Promise<string | undefined>;
  signal?: AbortSignal;
  onProgress?: (label: string, status: AgentToolLoopStepStatus, detail?: string, kind?: AgentToolLoopStepKind) => void;
}

export interface AgentToolLoopResult {
  contextBlock?: string;
  actions: AgentToolAction[];
}

const MAX_ACTIONS = 6;

export class AgentToolLoop {
  public constructor(private readonly providers: ProviderRegistry) {}

  public async run(request: AgentToolLoopRequest): Promise<AgentToolLoopResult> {
    const budget = getAgentContextBudget();
    const observations: string[] = [];
    const planSummaries: string[] = [];
    const actions: AgentToolAction[] = [];
    const executed = new Set<string>();
    const capabilities = new Map([...request.capabilityContext.skills, ...request.capabilityContext.tools].map((item) => [item.id, item] as const));
    const maxRounds = getAgentMaxToolRounds();

    for (let round = 1; round <= maxRounds && actions.length < MAX_ACTIONS; round += 1) {
      const plan = await this.createPlan(request, observations, round, maxRounds);
      if (plan.summary) {
        planSummaries.push(`第 ${round} 轮：${plan.summary}`);
      }
      request.onProgress?.("制定工具调用计划", "done", plan.summary || `第 ${round}/${maxRounds} 轮，${plan.actions.length} 个动作`, "think");
      let usefulActions = 0;

      for (const action of plan.actions.slice(0, MAX_ACTIONS - actions.length)) {
        assertNotAborted(request.signal);
        const actionKey = getToolActionKey(action);
        if (executed.has(actionKey)) {
          continue;
        }
        executed.add(actionKey);
        actions.push(action);
        if (action.type === "finish") {
          observations.push(`## 工具循环结束\n${action.reason ?? "上下文已足够"}`);
          usefulActions = 0;
          break;
        }
        usefulActions += 1;
        if (action.type === "read_file") {
          const label = `读取文件 ${action.path}`;
          request.onProgress?.(label, "running", action.reason, "file");
          try {
            const file = await readWorkspaceFile(action.path, budget.fileChars);
            observations.push([
              `## ${label}`,
              action.reason ? `原因：${action.reason}` : "",
              `语言：${file.languageId}，行数：${file.lineCount}`,
              "```text",
              file.content,
              "```"
            ].filter(Boolean).join("\n"));
            request.onProgress?.(label, "done", `${file.lineCount} 行`, "file");
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            observations.push(`## ${label}\n失败：${message}`);
            request.onProgress?.(label, "error", message, "file");
          }
          continue;
        }
        if (action.type === "web_search") {
          const label = `联网搜索 ${action.query}`;
          request.onProgress?.(label, "running", action.reason, "tool");
          const result = await request.runWebSearch?.(action.query);
          observations.push(`## ${label}\n${result ?? "未获得搜索结果或用户拒绝授权。"}`);
          request.onProgress?.(label, result ? "done" : "error", result ? "已获取搜索摘要" : "无结果", "tool");
          continue;
        }
        if (action.type === "run_capability") {
          const capability = capabilities.get(action.capabilityId);
          if (!capability) {
            observations.push(`## 执行扩展能力\n找不到能力：${action.capabilityId}`);
            request.onProgress?.(`执行扩展能力 ${action.capabilityId}`, "error", "未找到能力", "tool");
            continue;
          }
          const label = `执行 ${capability.label}`;
          request.onProgress?.(label, "running", action.reason, "tool");
          const result = await request.runCapability?.(capability, action.input || request.prompt);
          observations.push(`## ${label}\n${result ?? "未获得输出或用户拒绝授权。"}`);
          request.onProgress?.(label, result ? "done" : "error", result ? "已获得输出" : "无输出", "tool");
          continue;
        }
        if (action.type === "run_verify") {
          const label = "运行验证命令";
          request.onProgress?.(label, "running", action.reason, "verify");
          const result = await request.runVerify?.();
          observations.push(`## ${label}\n${result ?? "验证未运行或用户拒绝授权。"}`);
          request.onProgress?.(label, result ? "done" : "error", result ? "已获得验证结果" : "无结果", "verify");
        }
      }

      if (plan.actions.some((action) => action.type === "finish") || usefulActions === 0) {
        break;
      }
    }

    const contextBlock = observations.length > 0
      ? compactText([
          "模型驱动工具循环观察：",
          planSummaries.length > 0 ? `计划摘要：\n${planSummaries.join("\n")}` : "",
          ...observations
        ].filter(Boolean).join("\n\n"), budget.toolOutputChars)
      : undefined;

    return {
      contextBlock,
      actions
    };
  }

  private async createPlan(request: AgentToolLoopRequest, observations: string[], round: number, maxRounds: number): Promise<ParsedToolPlan> {
    const budget = getAgentContextBudget();
    request.onProgress?.("制定工具调用计划", "running", `第 ${round}/${maxRounds} 轮，根据已有观察决定是否继续调用工具`, "think");
    const activeModel = getModelForTask("chat");
    const response = await this.providers.get(activeModel.providerId).chat({
      model: activeModel.modelId,
      messages: [
        {
          role: "system",
          content: [
            "You are Patchlane's tool planning engine.",
            "Choose a minimal set of tool actions before code patch generation.",
            "Return JSON only. No markdown fences.",
            "Prefer fewer actions. Do not read files already present in context unless necessary.",
            "Use tools only when they materially improve correctness.",
            "Never request file writes. Patch generation is handled later.",
            "Use Simplified Chinese in reasons."
          ].join(" ")
        },
        {
          role: "user",
          content: buildPlannerPrompt(request, observations, round, maxRounds)
        }
      ],
      temperature: Math.min(getModelTemperature(), 0.15),
      maxTokens: Math.min(getModelMaxTokens() ?? 1600, 1600),
      topP: getModelTopP()
    }, {
      signal: request.signal
    });

    return normalizeToolPlan(parsePlannerJson(response.content), request.capabilityContext);
  }
}

function buildPlannerPrompt(request: AgentToolLoopRequest, observations: string[], round: number, maxRounds: number): string {
  const budget = getAgentContextBudget();
  const capabilityLines = [...request.capabilityContext.skills, ...request.capabilityContext.tools]
    .map((item) => `- ${item.id}: ${item.label} (${item.kind ?? "builtin"}) ${item.description}`)
    .join("\n") || "- 无";
  const recent = request.transcript
    .filter((item) => item.kind !== "agentProgress")
    .slice(-budget.historyItems)
    .map((item) => `${item.role}: ${compactText(item.content, item.role === "assistant" ? budget.assistantHistoryChars : budget.userHistoryChars)}`)
    .join("\n");
  return [
    `用户任务：${request.prompt}`,
    "",
    "已有工作区上下文：",
    compactText(request.baseContext ?? "无", budget.contextChars),
    "",
    request.previousPlanContext ? [
      "前文计划摘录：",
      compactText(request.previousPlanContext, Math.min(8000, budget.historyChars)),
      "",
      "如果用户要求继续、按计划实现或逐一完成，必须优先围绕上面的计划选择工具动作。"
    ].join("\n") : "",
    "",
    request.webContext ? ["已有联网搜索上下文：", compactText(request.webContext, budget.toolOutputChars)].join("\n") : "",
    "",
    "已有工具观察：",
    observations.length > 0 ? compactText(observations.join("\n\n"), budget.toolOutputChars) : "无",
    "",
    "最近对话：",
    recent || "无",
    "",
    "可用能力：",
    capabilityLines,
    "",
    "请返回 JSON：",
    "{",
    '  "summary": "中文说明为什么选择这些动作",',
    '  "actions": [',
    '    { "type": "read_file", "path": "src/example.ts", "reason": "中文原因" },',
    '    { "type": "web_search", "query": "关键词", "reason": "中文原因" },',
    '    { "type": "run_capability", "capabilityId": "mcp:server:tool", "input": "{...}", "reason": "中文原因" },',
    '    { "type": "run_verify", "reason": "中文原因" },',
    '    { "type": "finish", "reason": "上下文已足够" }',
    "  ]",
    "}",
    "",
    "规则：",
    `- 这是第 ${round}/${maxRounds} 轮。最多 4 个动作；如果上下文已足够，请只返回 finish。`,
    "- 默认优先 read_file，其次 web_search，只有用户选择了具体 Skill/MCP/工具时才 run_capability。",
    "- 只有任务明显需要测试反馈时才 run_verify。",
    "- 不要输出写文件动作。"
  ].filter(Boolean).join("\n");
}

function assertNotAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new DOMException("The operation was aborted.", "AbortError");
  }
}
