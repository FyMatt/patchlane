import { ChatTranscriptItem } from "./chatSessionService";

export interface AgentMemoryBudget {
  historyItems: number;
  historyChars: number;
  assistantHistoryChars: number;
  userHistoryChars: number;
}

export interface AgentMemoryContext {
  shouldFollowPreviousPlan: boolean;
  planBlock?: string;
  recentHistory: string;
}

const PLAN_FOLLOW_PROMPT_PATTERN = /按(?:照)?(?:上面|上述|前面|之前|刚才)?(?:的)?计划|根据(?:上面|上述|前面|之前|刚才)?.{0,12}计划|继续(?:完成|实现|执行|迭代)?|逐一(?:完成|实现|执行)?|剩余任务|未完成(?:任务)?|接下来的任务|全部任务|计划(?:实现|执行|落地)/i;
const PLAN_CONTENT_PATTERN = /计划|步骤|阶段|任务|待办|验收|验证|风险|假设|范围|文件|实现|未完成|下一步|Phase|Plan|TODO|Roadmap|Checklist|Acceptance/i;
const PLAN_HEADING_PATTERN = /^\s{0,3}(#{1,6}\s*)?(项目计划|执行计划|实施计划|任务计划|开发计划|计划书|下一步|未完成|剩余任务|阶段|Phase|Roadmap|TODO|验收|验证|风险|涉及文件|修改文件|步骤|Checklist)(?:[:：\s]|$)/i;
const LIST_LINE_PATTERN = /^\s{0,6}(?:[-*+]\s+|\d{1,2}[.)、]\s+|\[[ xX]\]\s+)/;

export function buildAgentMemoryContext(prompt: string, transcript: ChatTranscriptItem[], budget: AgentMemoryBudget): AgentMemoryContext {
  const previous = withoutCurrentUserMessage(prompt, transcript)
    .filter((item) => item.kind !== "agentProgress" && item.kind !== "taskInterrupted");
  const recentHistory = collectRecentHistory(previous, budget);
  const shouldFollowPreviousPlan = shouldFollowPlan(prompt);
  const planBlock = shouldFollowPreviousPlan
    ? extractPreviousPlanBlock(previous, Math.max(2400, Math.min(budget.historyChars, 8000)))
    : undefined;

  return {
    shouldFollowPreviousPlan,
    planBlock,
    recentHistory
  };
}

export function shouldFollowPlan(prompt: string): boolean {
  return PLAN_FOLLOW_PROMPT_PATTERN.test(prompt);
}

export function extractPreviousPlanBlock(transcript: ChatTranscriptItem[], maxChars: number): string | undefined {
  const candidates = [...transcript]
    .reverse()
    .filter((item) => item.role === "assistant" || item.role === "user")
    .filter((item) => PLAN_CONTENT_PATTERN.test(item.content))
    .slice(0, 8)
    .map((item) => formatPlanCandidate(item))
    .filter(Boolean);

  if (candidates.length === 0) {
    return undefined;
  }

  return compactText(candidates.join("\n\n"), maxChars);
}

function collectRecentHistory(transcript: ChatTranscriptItem[], budget: AgentMemoryBudget): string {
  const items = transcript
    .slice(-budget.historyItems)
    .filter((item) => item.role === "assistant" || item.role === "user");

  const lines: string[] = [];
  for (const item of items) {
    const role = item.role === "assistant" ? `assistant${item.model ? `/${item.model}` : ""}` : "user";
    lines.push(`--- ${role} ---`);
    lines.push(compactText(item.content, item.role === "assistant" ? budget.assistantHistoryChars : budget.userHistoryChars));
  }

  return compactText(lines.join("\n"), budget.historyChars);
}

function withoutCurrentUserMessage(prompt: string, transcript: ChatTranscriptItem[]): ChatTranscriptItem[] {
  const last = transcript.at(-1);
  if (last?.role === "user" && normalizePrompt(last.content) === normalizePrompt(prompt)) {
    return transcript.slice(0, -1);
  }
  return transcript;
}

function formatPlanCandidate(item: ChatTranscriptItem): string {
  const extracted = extractPlanLines(item.content);
  if (!extracted) {
    return "";
  }
  const role = item.role === "assistant" ? `assistant${item.model ? `/${item.model}` : ""}` : "user";
  return [
    `--- ${role} · ${item.createdAt} ---`,
    extracted
  ].join("\n");
}

function extractPlanLines(content: string): string {
  const lines = content.split(/\r?\n/);
  const selected: string[] = [];
  let inFence = false;
  let includeWindow = 0;

  for (const rawLine of lines) {
    const line = rawLine.trimEnd();
    if (/^\s*```/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) {
      continue;
    }

    const trimmed = line.trim();
    if (!trimmed) {
      if (selected.length > 0 && selected.at(-1) !== "") {
        selected.push("");
      }
      continue;
    }

    if (PLAN_HEADING_PATTERN.test(trimmed)) {
      selected.push(trimmed);
      includeWindow = 14;
      continue;
    }

    if (includeWindow > 0 && (LIST_LINE_PATTERN.test(trimmed) || PLAN_CONTENT_PATTERN.test(trimmed) || trimmed.length <= 180)) {
      selected.push(trimmed);
      includeWindow -= 1;
      continue;
    }

    if (PLAN_CONTENT_PATTERN.test(trimmed) && trimmed.length <= 220) {
      selected.push(trimmed);
      includeWindow = Math.max(includeWindow, 4);
    }
  }

  const compacted = selected
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  if (compacted) {
    return compactText(compacted, 2600);
  }

  return PLAN_CONTENT_PATTERN.test(content) ? compactText(stripCodeFences(content), 1600) : "";
}

function stripCodeFences(content: string): string {
  return content.replace(/```[\s\S]*?```/g, "[代码块已省略]");
}

function compactText(value: string, maxChars: number): string {
  const normalized = value.trim();
  if (!normalized || normalized.length <= maxChars) {
    return normalized;
  }
  const notice = `\n\n[已截断 ${normalized.length} 字符，仅保留计划开头和结尾]\n\n`;
  const contentBudget = Math.max(120, maxChars - notice.length);
  const head = Math.max(60, Math.floor(contentBudget * 0.68));
  const tail = Math.max(40, contentBudget - head);
  return `${normalized.slice(0, head)}\n\n[已截断 ${normalized.length - head - tail} 字符]\n\n${normalized.slice(-tail)}`;
}

function normalizePrompt(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}
