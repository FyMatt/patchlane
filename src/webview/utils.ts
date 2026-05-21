import { WebviewCommand, WebviewMessage } from "./types";
import { getVsCodeApi } from "./vscode";

export function postCommand(type: WebviewCommand, payload: Omit<WebviewMessage, "type"> = {}): void {
  getVsCodeApi().postMessage({ type, ...payload });
}

export function classNames(...values: Array<string | false | null | undefined>): string {
  return values.filter(Boolean).join(" ");
}

export function formatProvider(providerId?: string): string {
  if (!providerId) {
    return "Provider";
  }
  const labels: Record<string, string> = {
    deepseek: "DeepSeek",
    openai: "OpenAI",
    anthropic: "Claude",
    custom: "Custom",
    doubao: "Doubao",
    ernie: "ERNIE",
    qwen: "Qwen",
    hunyuan: "Hunyuan",
    glm: "GLM",
    spark: "Spark",
    ollama: "Ollama",
    lmStudio: "LM Studio"
  };
  return labels[providerId] ?? providerId;
}

export function formatWebSearchProvider(providerId?: string): string {
  if (!providerId) {
    return "免费搜索（无需 Key）";
  }
  const labels: Record<string, string> = {
    free: "免费搜索（无需 Key）",
    custom: "自定义搜索",
    searxng: "SearXNG",
    tavily: "Tavily",
    brave: "Brave Search",
    bing: "Bing",
    serpapi: "SerpAPI"
  };
  return labels[providerId] ?? providerId;
}

export function formatTime(value?: string): string {
  if (!value) {
    return "";
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return "";
  }
  return date.toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit"
  });
}

export function extractCodeText(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map(extractCodeText).join("");
  }
  if (value && typeof value === "object" && "props" in value) {
    const props = (value as { props?: { children?: unknown } }).props;
    return extractCodeText(props?.children);
  }
  return "";
}

export function routePrompt(text: string, mode: "chat" | "agent", context: { skillIds?: string[]; toolIds?: string[] } = {}): void {
  const trimmed = text.trim();
  const lower = trimmed.toLowerCase();
  const rest = trimmed.replace(/^\/\S+\s*/, "").trim();

  if (lower === "/clear") {
    postCommand("clearTranscript");
    return;
  }
  if (lower === "/help") {
    postCommand("showHelp");
    return;
  }
  if (lower === "/verify") {
    postCommand("runVerify");
    return;
  }
  if (lower === "/index") {
    postCommand("indexWorkspace");
    return;
  }
  if (lower.startsWith("/web ")) {
    postCommand("runWebSearch", { query: rest || trimmed.replace(/^\/web\s*/i, "").trim() });
    return;
  }
  if (lower.startsWith("/docs ")) {
    postCommand("runWebSearch", { query: rest || trimmed.replace(/^\/docs\s*/i, "").trim(), sourceHint: "docs" });
    return;
  }
  if (lower.startsWith("/github ")) {
    postCommand("runWebSearch", { query: rest || trimmed.replace(/^\/github\s*/i, "").trim(), sourceHint: "github" });
    return;
  }
  if (lower.startsWith("/news ")) {
    postCommand("runWebSearch", { query: rest || trimmed.replace(/^\/news\s*/i, "").trim(), sourceHint: "news" });
    return;
  }
  if (lower === "/explain") {
    postCommand("explainSelection");
    return;
  }
  if (lower === "/fix") {
    postCommand("patchSelection");
    return;
  }
  if (lower.startsWith("/fix ")) {
    postCommand("generatePatch", { text: `修复这个问题：${rest}`, skillIds: context.skillIds, toolIds: context.toolIds });
    return;
  }
  if (lower.startsWith("/tests ")) {
    postCommand("generatePatch", { text: `添加或更新测试：${rest}`, skillIds: context.skillIds, toolIds: context.toolIds });
    return;
  }
  if (lower.startsWith("/patch ")) {
    postCommand("generatePatch", { text: rest, skillIds: context.skillIds, toolIds: context.toolIds });
    return;
  }

  if (mode === "agent") {
    postCommand("generatePatch", { text: trimmed, skillIds: context.skillIds, toolIds: context.toolIds });
    return;
  }

  postCommand("sendChat", { text: trimmed, mode, skillIds: context.skillIds, toolIds: context.toolIds });
}
