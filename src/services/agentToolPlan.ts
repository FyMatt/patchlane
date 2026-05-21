import { AgentCapabilityConfig } from "../config";

export type AgentToolAction =
  | { type: "read_file"; path: string; reason?: string }
  | { type: "web_search"; query: string; reason?: string }
  | { type: "run_capability"; capabilityId: string; input?: string; reason?: string }
  | { type: "run_verify"; reason?: string }
  | { type: "finish"; reason?: string };

export interface ParsedToolPlan {
  summary?: string;
  actions: AgentToolAction[];
}

export interface AgentToolPlanCapabilityContext {
  skills: AgentCapabilityConfig[];
  tools: AgentCapabilityConfig[];
}

export function parsePlannerJson(content: string): unknown {
  const trimmed = content.trim();
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced?.[1]?.trim() ?? trimmed;
  try {
    return JSON.parse(candidate);
  } catch {
    const start = candidate.indexOf("{");
    const end = candidate.lastIndexOf("}");
    if (start !== -1 && end > start) {
      return JSON.parse(candidate.slice(start, end + 1));
    }
    return {};
  }
}

export function normalizeToolPlan(value: unknown, context: AgentToolPlanCapabilityContext): ParsedToolPlan {
  const capabilities = new Set([...context.skills, ...context.tools].map((item) => item.id));
  if (!value || typeof value !== "object") {
    return { actions: [{ type: "finish", reason: "模型没有返回可解析计划，沿用已有上下文。" }] };
  }
  const object = value as { summary?: unknown; actions?: unknown };
  const rawActions = Array.isArray(object.actions) ? object.actions : [];
  const actions: AgentToolAction[] = [];
  const seen = new Set<string>();

  for (const raw of rawActions) {
    if (!raw || typeof raw !== "object") {
      continue;
    }
    const action = normalizeAction(raw as Record<string, unknown>, capabilities);
    if (!action) {
      continue;
    }
    const key = getToolActionKey(action);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    actions.push(action);
  }

  return {
    summary: typeof object.summary === "string" ? object.summary.trim() : undefined,
    actions: actions.length > 0 ? actions.slice(0, 4) : [{ type: "finish", reason: "上下文已足够。" }]
  };
}

export function getToolActionKey(action: AgentToolAction): string {
  if (action.type === "read_file") {
    return `read_file:${normalizePath(action.path)}`;
  }
  if (action.type === "web_search") {
    return `web_search:${action.query.trim().toLowerCase()}`;
  }
  if (action.type === "run_capability") {
    return `run_capability:${action.capabilityId}:${(action.input ?? "").trim()}`;
  }
  return action.type;
}

export function compactText(value: string, maxChars: number): string {
  const normalized = value.trim();
  if (normalized.length <= maxChars) {
    return normalized;
  }
  const head = Math.floor(maxChars * 0.7);
  const tail = maxChars - head;
  return `${normalized.slice(0, head)}\n\n[已截断 ${normalized.length - maxChars} 字符]\n\n${normalized.slice(-tail)}`;
}

function normalizeAction(item: Record<string, unknown>, capabilities: Set<string>): AgentToolAction | undefined {
  const type = typeof item.type === "string" ? item.type : "";
  const reason = typeof item.reason === "string" ? item.reason : undefined;
  if (type === "read_file" && typeof item.path === "string" && item.path.trim()) {
    return { type, path: normalizePath(item.path), reason };
  }
  if (type === "web_search" && typeof item.query === "string" && item.query.trim()) {
    return { type, query: item.query.trim(), reason };
  }
  if (type === "run_capability" && typeof item.capabilityId === "string" && capabilities.has(item.capabilityId.trim())) {
    return {
      type,
      capabilityId: item.capabilityId.trim(),
      input: typeof item.input === "string" ? item.input : undefined,
      reason
    };
  }
  if (type === "run_verify") {
    return { type, reason };
  }
  if (type === "finish") {
    return { type, reason };
  }
  return undefined;
}

function normalizePath(value: string): string {
  return value.trim().replace(/^@/, "").replace(/\\/g, "/").replace(/^\/+/, "");
}
