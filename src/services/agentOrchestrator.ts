import * as vscode from "vscode";
import { AgentCapabilityConfig, getAgentContextBudget } from "../config";
import { GitService } from "./gitService";
import { ChatTranscriptItem } from "./chatSessionService";
import { collectWorkspaceContext } from "./workspaceContext";
import {
  collectPromptFileReferences,
  getPreferredReferenceFiles,
  listWorkspaceFiles,
  readWorkspaceFile,
  WorkspaceFileReference,
  WorkspaceFileSummary
} from "./workspaceFiles";
import { FailureMemoryStore, formatFailureMemoryForPrompt } from "./failureMemory";
import { formatRepoProfileForPrompt, RepoProfileStore } from "./repoProfile";
import { buildWorkspaceCodeMap, formatCodeMapForPrompt } from "./workspaceCodeMap";

export type AgentOrchestratorStepKind = "think" | "tool" | "file" | "approval" | "model" | "patch" | "verify";
export type AgentOrchestratorStepStatus = "pending" | "running" | "done" | "error";

export interface AgentCapabilityContext {
  skills: AgentCapabilityConfig[];
  tools: AgentCapabilityConfig[];
}

export interface AgentOrchestratorRequest {
  prompt: string;
  transcript: ChatTranscriptItem[];
  capabilityContext: AgentCapabilityContext;
  signal?: AbortSignal;
  onProgress?: (label: string, status: AgentOrchestratorStepStatus, detail?: string, kind?: AgentOrchestratorStepKind) => void;
}

export interface AgentOrchestratorResult {
  contextBlock: string;
  candidateFiles: WorkspaceFileSummary[];
  referencedFiles: WorkspaceFileReference[];
}

interface ScoredFile {
  file: WorkspaceFileSummary;
  score: number;
  reasons: string[];
}

export class AgentOrchestrator {
  public constructor(
    private readonly gitService: GitService,
    private readonly repoProfileStore?: RepoProfileStore,
    private readonly failureMemoryStore?: FailureMemoryStore
  ) {}

  public async prepare(request: AgentOrchestratorRequest): Promise<AgentOrchestratorResult> {
    const progress = request.onProgress;
    const budget = getAgentContextBudget();
    assertNotAborted(request.signal);

    progress?.("分析任务和会话上下文", "running", "提取需求关键词、前文计划和已选择能力", "think");
    const keywords = extractKeywords([
      request.prompt,
      ...request.transcript.slice(-budget.historyItems).map((item) => item.content)
    ].join("\n"));
    const historyHint = summarizeRecentHistory(request.transcript, budget);
    progress?.("分析任务和会话上下文", "done", `${keywords.slice(0, 8).join("、") || "无明显关键词"}`, "think");

    assertNotAborted(request.signal);
    progress?.("扫描相关文件", "running", "优先当前文件、已打开标签页和文件名匹配项", "file");
    const [workspaceContext, preferredFiles, allFiles, explicitReferences, codeMap] = await Promise.all([
      collectWorkspaceContext(this.gitService).catch(() => undefined),
      getPreferredReferenceFiles(30),
      listWorkspaceFiles(220),
      collectPromptFileReferences(request.prompt, 8),
      buildWorkspaceCodeMap(Math.max(40, budget.candidateFiles * 6)).catch(() => undefined)
    ]);
    const candidates = rankCandidateFiles({
      activeFilePath: workspaceContext?.activeFilePath,
      preferredFiles,
      allFiles,
      explicitReferences,
      keywords,
      prompt: request.prompt
    }).slice(0, budget.candidateFiles);
    progress?.("扫描相关文件", "done", candidates.length > 0 ? candidates.map((item) => item.path).slice(0, 6).join("、") : "未发现明显候选文件", "file");

    assertNotAborted(request.signal);
    progress?.("读取关键文件", "running", "只读取最相关文件，避免一次性塞满上下文", "file");
    const referencedFiles = await readCandidateFiles(candidates, explicitReferences, budget, request.signal);
    progress?.("读取关键文件", "done", referencedFiles.length > 0 ? referencedFiles.map((file) => file.path).join("、") : "没有额外文件需要读取", "file");

    assertNotAborted(request.signal);
    progress?.("检查诊断信息", "running", "读取 VS Code 当前诊断，辅助定位报错和类型问题", "verify");
    const diagnostics = collectRelevantDiagnostics(candidates.map((file) => file.path));
    progress?.("检查诊断信息", "done", diagnostics.length > 0 ? `${diagnostics.length} 条相关诊断` : "当前候选文件暂无诊断", "verify");

    const repoProfile = codeMap
      ? await this.repoProfileStore?.updateFromCodeMap(codeMap).catch(() => undefined)
      : this.repoProfileStore?.get();
    const failureMemorySummary = formatFailureMemoryForPrompt(this.failureMemoryStore?.getRelevant({
      prompt: request.prompt,
      files: candidates.map((file) => file.path)
    }, 4) ?? [], Math.min(2200, Math.floor(budget.contextChars * 0.1)));
    const contextBlock = compactText(formatAgentContext({
      prompt: request.prompt,
      keywords,
      historyHint,
      capabilityContext: request.capabilityContext,
      workspaceRoot: workspaceContext?.workspaceRoot,
      activeFilePath: workspaceContext?.activeFilePath,
      activeSelection: workspaceContext?.activeSelection,
      changeSummary: workspaceContext?.changeSummary,
      diffContext: workspaceContext?.diffContext,
      candidates,
      referencedFiles,
      diagnostics,
      repoProfileSummary: repoProfile ? formatRepoProfileForPrompt(repoProfile, Math.min(2500, Math.floor(budget.contextChars * 0.12))) : undefined,
      failureMemorySummary,
      codeMapSummary: codeMap ? formatCodeMapForPrompt(codeMap, Math.min(5000, Math.floor(budget.contextChars * 0.22))) : undefined
    }), budget.contextChars);

    return {
      contextBlock,
      candidateFiles: candidates,
      referencedFiles
    };
  }
}

function rankCandidateFiles(input: {
  activeFilePath?: string;
  preferredFiles: WorkspaceFileSummary[];
  allFiles: WorkspaceFileSummary[];
  explicitReferences: WorkspaceFileReference[];
  keywords: string[];
  prompt: string;
}): WorkspaceFileSummary[] {
  const byPath = new Map<string, ScoredFile>();

  const add = (file: WorkspaceFileSummary, baseScore: number, reason: string): void => {
    const normalizedPath = normalizePath(file.path);
    const existing = byPath.get(normalizedPath);
    const keywordScore = scorePathByKeywords(normalizedPath, input.keywords);
    const mentionScore = input.prompt.includes(file.path) || input.prompt.includes(normalizedPath) ? 12 : 0;
    const nextScore = baseScore + keywordScore + mentionScore;
    if (existing) {
      existing.score += nextScore;
      existing.reasons.push(reason);
      return;
    }
    byPath.set(normalizedPath, {
      file: { ...file, path: normalizedPath },
      score: nextScore,
      reasons: [reason]
    });
  };

  for (const reference of input.explicitReferences) {
    add(reference, 80, "用户显式引用");
  }
  for (const file of input.preferredFiles) {
    const baseScore = file.path === input.activeFilePath ? 70 : file.source === "open" ? 45 : 20;
    add(file, baseScore, file.source === "active" ? "当前文件" : file.source === "open" ? "已打开标签页" : "工作区候选");
  }
  for (const file of input.allFiles) {
    add(file, 4, "文件名匹配");
  }

  return [...byPath.values()]
    .filter((item) => item.score > 4 || item.file.path === input.activeFilePath || input.explicitReferences.some((reference) => reference.path === item.file.path))
    .sort((left, right) => right.score - left.score || left.file.path.localeCompare(right.file.path))
    .map((item) => item.file);
}

async function readCandidateFiles(
  candidates: WorkspaceFileSummary[],
  explicitReferences: WorkspaceFileReference[],
  budget: ReturnType<typeof getAgentContextBudget>,
  signal?: AbortSignal
): Promise<WorkspaceFileReference[]> {
  const byPath = new Map<string, WorkspaceFileReference>();
  for (const reference of explicitReferences) {
    byPath.set(normalizePath(reference.path), trimReference(reference, budget.fileChars));
  }

  for (const file of candidates.slice(0, budget.readFiles)) {
    assertNotAborted(signal);
    const normalizedPath = normalizePath(file.path);
    if (byPath.has(normalizedPath)) {
      continue;
    }
    try {
      byPath.set(normalizedPath, await readWorkspaceFile(normalizedPath, budget.fileChars));
    } catch {
      // Candidate ranking is best-effort. Unreadable files are still listed as candidates.
    }
  }

  return [...byPath.values()].slice(0, budget.readFiles);
}

function collectRelevantDiagnostics(candidatePaths: string[]): string[] {
  const candidateSet = new Set(candidatePaths.map(normalizePath));
  const diagnostics: string[] = [];
  for (const [uri, items] of vscode.languages.getDiagnostics()) {
    const path = normalizePath(vscode.workspace.asRelativePath(uri, false));
    if (candidateSet.size > 0 && !candidateSet.has(path)) {
      continue;
    }
    for (const diagnostic of items.slice(0, 6)) {
      diagnostics.push([
        `${path}:${diagnostic.range.start.line + 1}:${diagnostic.range.start.character + 1}`,
        severityLabel(diagnostic.severity),
        diagnostic.message.replace(/\s+/g, " ").trim()
      ].join(" "));
      if (diagnostics.length >= 16) {
        return diagnostics;
      }
    }
  }
  return diagnostics;
}

function formatAgentContext(input: {
  prompt: string;
  keywords: string[];
  historyHint: string;
  capabilityContext: AgentCapabilityContext;
  workspaceRoot?: string;
  activeFilePath?: string;
  activeSelection?: string;
  changeSummary?: string;
  diffContext?: string;
  candidates: WorkspaceFileSummary[];
  referencedFiles: WorkspaceFileReference[];
  diagnostics: string[];
  repoProfileSummary?: string;
  failureMemorySummary?: string;
  codeMapSummary?: string;
}): string {
  const selectedSkills = input.capabilityContext.skills.map((item) => `${item.label}(${item.id})`).join("、") || "未选择";
  const selectedTools = input.capabilityContext.tools.map((item) => `${item.label}(${item.id})`).join("、") || "未选择";
  const candidateLines = input.candidates.length > 0
    ? input.candidates.map((file, index) => `${index + 1}. ${file.path} (${file.languageId}, ${file.lineCount} 行${file.source ? `, ${sourceLabel(file.source)}` : ""})`)
    : ["未找到候选文件"];
  const fileBlocks = input.referencedFiles.length > 0
    ? input.referencedFiles.flatMap((file) => [
      `文件：${file.path} (${file.languageId}, ${file.lineCount} 行)`,
      "```text",
      file.content,
      "```",
      ""
    ])
    : ["未读取额外文件内容"];

  return [
    "Agent 工具观察：",
    "",
    `用户任务：${input.prompt}`,
    `工作区：${input.workspaceRoot ?? "未知"}`,
    `当前文件：${input.activeFilePath ?? "无"}`,
    `关键词：${input.keywords.slice(0, 12).join("、") || "无"}`,
    `已选 Skill：${selectedSkills}`,
    `已选工具：${selectedTools}`,
    "",
    "前文可用线索：",
    input.historyHint || "无明显前文线索",
    "",
    "当前选区：",
    input.activeSelection ? compactText(input.activeSelection, 2400) : "无",
    "",
    "候选文件：",
    ...candidateLines,
    "",
    "Workspace code map summary:",
    input.codeMapSummary ?? "none",
    "",
    "Repo profile memory:",
    input.repoProfileSummary ?? "none",
    "",
    "Verification failure memory:",
    input.failureMemorySummary || "none",
    "",
    "已读取的关键文件：",
    ...fileBlocks,
    "",
    "VS Code 诊断：",
    ...(input.diagnostics.length > 0 ? input.diagnostics.map((item) => `- ${item}`) : ["- 暂无相关诊断"]),
    "",
    "Git 状态摘要：",
    compactText(input.changeSummary ?? "(无)", 3000),
    "",
    "当前未提交 diff：",
    "```diff",
    compactText(input.diffContext ?? "(无)", 5000),
    "```",
    "",
    "工程执行约束：",
    "- 优先沿用当前文件、已打开文件和候选文件中的项目风格。",
    "- 不要新建无关示例项目，不要忽略前文计划。",
    "- 如果用户要求按前文计划实现，必须以上方前文线索和候选文件为依据。",
    "- 只输出可审查、最小化的修改草稿；写入工作区必须等待用户确认。"
  ].join("\n");
}

function summarizeRecentHistory(transcript: ChatTranscriptItem[], budget: ReturnType<typeof getAgentContextBudget>): string {
  const useful = transcript
    .filter((item) => item.kind !== "agentProgress" && item.kind !== "webSearch")
    .slice(-budget.historyItems)
    .map((item) => {
      const role = item.role === "user" ? "用户" : "助手";
      return `${role}：${compactText(item.content.replace(/\s+/g, " "), item.role === "user" ? Math.min(900, budget.userHistoryChars) : Math.min(1800, budget.assistantHistoryChars))}`;
    });
  return compactText(useful.join("\n"), Math.min(6500, budget.historyChars));
}

function extractKeywords(value: string): string[] {
  const normalized = value.toLowerCase();
  const tokens = new Set<string>();
  for (const match of normalized.matchAll(/[a-z0-9_.:/-]{3,}|[\u4e00-\u9fa5]{2,}/g)) {
    const token = match[0].replace(/^@/, "").trim();
    if (token && !STOP_WORDS.has(token)) {
      tokens.add(token);
    }
  }
  return [...tokens].slice(0, 80);
}

function scorePathByKeywords(path: string, keywords: string[]): number {
  const lowerPath = path.toLowerCase();
  let score = 0;
  for (const keyword of keywords.slice(0, 40)) {
    if (keyword.length < 3) {
      continue;
    }
    if (lowerPath.includes(keyword)) {
      score += keyword.includes("/") || keyword.includes(".") ? 16 : 8;
    }
  }
  return score;
}

function trimReference(reference: WorkspaceFileReference, maxChars: number): WorkspaceFileReference {
  return {
    ...reference,
    path: normalizePath(reference.path),
    content: compactText(reference.content, maxChars)
  };
}

function severityLabel(severity: vscode.DiagnosticSeverity): string {
  switch (severity) {
    case vscode.DiagnosticSeverity.Error:
      return "错误";
    case vscode.DiagnosticSeverity.Warning:
      return "警告";
    case vscode.DiagnosticSeverity.Information:
      return "信息";
    case vscode.DiagnosticSeverity.Hint:
      return "提示";
    default:
      return "诊断";
  }
}

function sourceLabel(source: WorkspaceFileSummary["source"]): string {
  if (source === "active") {
    return "当前文件";
  }
  if (source === "open") {
    return "已打开";
  }
  return "工作区";
}

function normalizePath(value: string): string {
  return value.replace(/\\/g, "/").replace(/^@/, "");
}

function compactText(value: string, maxChars: number): string {
  const normalized = value.trim();
  if (normalized.length <= maxChars) {
    return normalized;
  }
  const head = Math.floor(maxChars * 0.7);
  const tail = maxChars - head;
  return `${normalized.slice(0, head)}\n\n[已截断 ${normalized.length - maxChars} 字符]\n\n${normalized.slice(-tail)}`;
}

function assertNotAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new DOMException("The operation was aborted.", "AbortError");
  }
}

const STOP_WORDS = new Set([
  "the",
  "and",
  "for",
  "with",
  "this",
  "that",
  "from",
  "into",
  "请帮我",
  "帮我",
  "实现",
  "修改",
  "优化",
  "这个",
  "那个",
  "当前",
  "文件",
  "代码",
  "功能",
  "问题"
]);
