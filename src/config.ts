import * as path from "path";
import * as vscode from "vscode";
import { emptyCapabilityManifest, loadCapabilityManifestFromFile, type NormalizedCapabilityManifest } from "./services/capabilityManifest";

export interface ModelOption {
  label: string;
  providerId: string;
  modelId: string;
  description: string;
}

export interface ActiveModel {
  providerId: string;
  modelId: string;
  label: string;
}

export interface AgentCapabilityConfig {
  id: string;
  label: string;
  description: string;
  kind?: "builtin" | "custom" | "mcp";
  command?: string;
  server?: string;
  script?: string;
  runtime?: "node" | "python" | "shell" | "mcp" | "custom";
  args?: string[];
}

export interface McpServerToolConfig {
  name: string;
  label?: string;
  description?: string;
}

export interface McpServerConfig {
  transport?: "stdio" | "http";
  command?: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
  enabled?: boolean;
  tools?: McpServerToolConfig[];
}

export interface McpServerSummary {
  name: string;
  transport: "stdio" | "http";
  enabled: boolean;
  toolCount: number;
  discoveredToolCount?: number;
  discoveredResourceCount?: number;
  discoveredPromptCount?: number;
  status?: "notStarted" | "starting" | "running" | "stopped" | "error";
  lastError?: string;
  pid?: number;
  command?: string;
  url?: string;
  recentLogs?: McpServerLogEntry[];
}

export interface McpServerLogEntry {
  time: string;
  level: "info" | "warning" | "error";
  server: string;
  message: string;
  detail?: string;
}

export interface AgentCapabilityState {
  skills: AgentCapabilityConfig[];
  tools: AgentCapabilityConfig[];
}

export interface CapabilityManifestState {
  version?: string;
  skills: AgentCapabilityConfig[];
  tools: AgentCapabilityConfig[];
  mcpServers: Record<string, McpServerConfig>;
  diagnostics: NormalizedCapabilityManifest["diagnostics"];
}

export type ModelTask = "chat" | "commitMessage" | "patch" | "patchRepair";
export type CustomProviderProtocol = "openai" | "anthropic";
export type WebSearchProvider = "free" | "custom" | "searxng" | "tavily" | "brave" | "bing" | "serpapi";
export type AgentContextBudgetMode = "economy" | "balanced" | "quality";

export interface WebSearchSettings {
  enabled: boolean;
  provider: WebSearchProvider;
  baseUrl: string;
  maxResults: number;
  defaultRecencyDays?: number;
  allowedDomains: string[];
  blockedDomains: string[];
  requireApproval: boolean;
}

export interface AgentContextBudget {
  mode: AgentContextBudgetMode;
  candidateFiles: number;
  readFiles: number;
  fileChars: number;
  contextChars: number;
  historyItems: number;
  historyChars: number;
  userHistoryChars: number;
  assistantHistoryChars: number;
  planFileChars: number;
  patchFileChars: number;
  webResults: number;
  webSnippetChars: number;
  webPageChars: number;
  toolOutputChars: number;
  toolStdoutChars: number;
  toolStderrChars: number;
  verifyOutputChars: number;
}

const CONFIG_SECTION = "codeAgent";

export function getConfig(): vscode.WorkspaceConfiguration {
  return vscode.workspace.getConfiguration(CONFIG_SECTION);
}

export function getModelTemperature(): number {
  return getConfig().get<number>("modelParameters.temperature", 0.2);
}

export function getModelMaxTokens(): number | undefined {
  const value = getConfig().get<number>("modelParameters.maxTokens", 4096);
  return value > 0 ? value : undefined;
}

export function getModelTopP(): number | undefined {
  const value = getConfig().get<number>("modelParameters.topP", 1);
  return value > 0 ? value : undefined;
}

export function getDeepSeekBaseUrl(): string {
  return getConfig().get<string>("deepseek.baseUrl", "https://api.deepseek.com").replace(/\/+$/, "");
}

export function getOpenAIBaseUrl(): string {
  return getConfig().get<string>("openai.baseUrl", "https://api.openai.com/v1").replace(/\/+$/, "");
}

export function getProviderBaseUrl(providerId: string, fallback: string): string {
  return getConfig().get<string>(`${providerId}.baseUrl`, fallback).replace(/\/+$/, "");
}

export function getProviderModel(providerId: string, fallback: string): string {
  return getConfig().get<string>(`${providerId}.model`, fallback);
}

export function getOllamaBaseUrl(): string {
  return getConfig().get<string>("ollama.baseUrl", "http://localhost:11434/v1").replace(/\/+$/, "");
}

export function getLmStudioBaseUrl(): string {
  return getConfig().get<string>("lmStudio.baseUrl", "http://localhost:1234/v1").replace(/\/+$/, "");
}

export function getCustomProviderProtocol(): CustomProviderProtocol {
  const value = getConfig().get<string>("custom.protocol", "openai");
  return value === "anthropic" ? "anthropic" : "openai";
}

export function getCustomBaseUrl(): string {
  const fallback = getCustomProviderProtocol() === "anthropic" ? "https://api.anthropic.com/v1" : "https://api.openai.com/v1";
  return getConfig().get<string>("custom.baseUrl", fallback).replace(/\/+$/, "");
}

export function getCustomModel(): string {
  const fallback = getCustomProviderProtocol() === "anthropic" ? "claude-sonnet-4" : "gpt-5.4-mini";
  return getConfiguredString(getConfig(), "custom.model", [], fallback);
}

export function isWebSearchEnabled(): boolean {
  return getConfig().get<boolean>("webSearch.enabled", false);
}

export function getWebSearchProvider(): WebSearchProvider {
  const value = getConfig().get<string>("webSearch.provider", "free");
  return isWebSearchProvider(value) ? value : "free";
}

export function getWebSearchBaseUrl(): string {
  return getConfig().get<string>("webSearch.baseUrl", "").trim().replace(/\/+$/, "");
}

export function getWebSearchMaxResults(): number {
  const value = getConfig().get<number>("webSearch.maxResults", 6);
  return Math.max(1, Math.min(10, Number.isFinite(value) ? value : 6));
}

export function getWebSearchDefaultRecencyDays(): number | undefined {
  const value = getConfig().get<number>("webSearch.defaultRecencyDays", 30);
  if (!Number.isFinite(value) || value <= 0) {
    return undefined;
  }
  return Math.min(365, Math.floor(value));
}

export function getWebSearchAllowedDomains(): string[] {
  return normalizeDomainList(getConfig().get<string[]>("webSearch.allowedDomains", []));
}

export function getWebSearchBlockedDomains(): string[] {
  return normalizeDomainList(getConfig().get<string[]>("webSearch.blockedDomains", []));
}

export function doesWebSearchRequireApproval(): boolean {
  return getConfig().get<boolean>("webSearch.requireApproval", true);
}

export function getWebSearchSettings(): WebSearchSettings {
  return {
    enabled: isWebSearchEnabled(),
    provider: getWebSearchProvider(),
    baseUrl: getWebSearchBaseUrl(),
    maxResults: getWebSearchMaxResults(),
    defaultRecencyDays: getWebSearchDefaultRecencyDays(),
    allowedDomains: getWebSearchAllowedDomains(),
    blockedDomains: getWebSearchBlockedDomains(),
    requireApproval: doesWebSearchRequireApproval()
  };
}

export function getAgentMaxRepairAttempts(): number {
  const value = getConfig().get<number>("agent.maxRepairAttempts", 2);
  if (!Number.isFinite(value)) {
    return 2;
  }
  return Math.max(0, Math.min(4, Math.floor(value)));
}

export function getAgentMaxToolRounds(): number {
  const value = getConfig().get<number>("agent.maxToolRounds", 2);
  if (!Number.isFinite(value)) {
    return 2;
  }
  return Math.max(1, Math.min(4, Math.floor(value)));
}

export function getAgentContextBudgetMode(): AgentContextBudgetMode {
  const value = getConfig().get<string>("agent.contextBudget", "balanced");
  if (value === "economy" || value === "quality") {
    return value;
  }
  return "balanced";
}

export function getAgentContextBudget(): AgentContextBudget {
  const mode = getAgentContextBudgetMode();
  if (mode === "economy") {
    return {
      mode,
      candidateFiles: 10,
      readFiles: 3,
      fileChars: 2800,
      contextChars: 9000,
      historyItems: 4,
      historyChars: 5200,
      userHistoryChars: 900,
      assistantHistoryChars: 2200,
      planFileChars: 1500,
      patchFileChars: 5200,
      webResults: 4,
      webSnippetChars: 360,
      webPageChars: 5200,
      toolOutputChars: 7000,
      toolStdoutChars: 3200,
      toolStderrChars: 1400,
      verifyOutputChars: 7000
    };
  }
  if (mode === "quality") {
    return {
      mode,
      candidateFiles: 24,
      readFiles: 8,
      fileChars: 7600,
      contextChars: 24000,
      historyItems: 8,
      historyChars: 14000,
      userHistoryChars: 2200,
      assistantHistoryChars: 6800,
      planFileChars: 3600,
      patchFileChars: 11000,
      webResults: 8,
      webSnippetChars: 850,
      webPageChars: 12000,
      toolOutputChars: 18000,
      toolStdoutChars: 8000,
      toolStderrChars: 4000,
      verifyOutputChars: 16000
    };
  }
  return {
    mode,
    candidateFiles: 16,
    readFiles: 5,
    fileChars: 5000,
    contextChars: 16000,
    historyItems: 6,
    historyChars: 10000,
    userHistoryChars: 1600,
    assistantHistoryChars: 5000,
    planFileChars: 2400,
    patchFileChars: 8000,
    webResults: 6,
    webSnippetChars: 600,
    webPageChars: 9000,
    toolOutputChars: 12000,
    toolStdoutChars: 5000,
    toolStderrChars: 2500,
    verifyOutputChars: 12000
  };
}

export function getModelOptions(): ModelOption[] {
  const config = getConfig();
  const deepSeekDefaultModel = getConfiguredString(config, "deepseek.defaultModel", [], "deepseek-v4-flash");
  const deepSeekAdvancedModel = getConfiguredString(config, "deepseek.advancedModel", [], "deepseek-v4-pro");
  const openAIGpt55Model = getConfiguredString(config, "openai.gpt55Model", [], "gpt-5.5");
  const openAIGpt54Model = getConfiguredString(config, "openai.gpt54Model", [], "gpt-5.4");
  const openAIGpt54MiniModel = getConfiguredString(config, "openai.gpt54MiniModel", [], "gpt-5.4-mini");
  const openAIGpt54NanoModel = getConfiguredString(config, "openai.gpt54NanoModel", [], "gpt-5.4-nano");
  const openAIGpt41Model = getConfiguredString(config, "openai.gpt41Model", [], "gpt-4.1");
  const openAIGpt35LegacyModel = getConfig().get<string>("openai.gpt35Model", "gpt-3.5-turbo");
  const openAIGpt4LegacyModel = getConfig().get<string>("openai.gpt4Model", "gpt-4");
  const openAIGpt4oLegacyModel = getConfig().get<string>("openai.gpt4oModel", "gpt-4o");
  const openAIGpt4TurboLegacyModel = getConfig().get<string>("openai.gpt4TurboModel", "gpt-4-turbo");
  const customProtocol = getCustomProviderProtocol();
  const customModel = getCustomModel();
  const claudeOpusModel = getConfiguredString(config, "anthropic.opusModel", [], "claude-opus-4-1");
  const claudeSonnetModel = getConfiguredString(config, "anthropic.sonnetModel", [], "claude-sonnet-4");
  const claudeHaikuModel = getConfiguredString(config, "anthropic.haikuModel", [], "claude-3-5-haiku-latest");
  const doubaoModel = getConfiguredString(config, "doubao.model", [], "doubao-seed-code-preview-251028");
  const ernieModel = getConfiguredString(config, "ernie.model", [], "ernie-4.5-turbo-128k");
  const qwenModel = getConfiguredString(config, "qwen.model", [], "qwen3-coder-next");
  const hunyuanModel = getConfiguredString(config, "hunyuan.model", [], "hunyuan-turbos-latest");
  const glmModel = getConfiguredString(config, "glm.model", [], "glm-4.7");
  const sparkModel = getConfiguredString(config, "spark.model", [], "spark-x");
  const ollamaModel = getConfiguredString(config, "ollama.model", [], "qwen3-coder:latest");
  const lmStudioModel = config.get<string>("lmStudio.model", "local-model");

  return [
    {
      label: "DeepSeek V4 Flash",
      providerId: "deepseek",
      modelId: deepSeekDefaultModel,
      description: "适合聊天、解释和轻量代码任务的 DeepSeek 快速模型。"
    },
    {
      label: "DeepSeek V4 Pro",
      providerId: "deepseek",
      modelId: deepSeekAdvancedModel,
      description: "适合规划、重构和复杂工程任务的 DeepSeek 强能力模型。"
    },
    {
      label: "DeepSeek Chat (Legacy)",
      providerId: "deepseek",
      modelId: "deepseek-chat",
      description: "旧版兼容预设，对应 DeepSeek V4 Flash 的非思考模式。"
    },
    {
      label: "DeepSeek Reasoner (Legacy)",
      providerId: "deepseek",
      modelId: "deepseek-reasoner",
      description: "旧版兼容预设，对应 DeepSeek V4 Flash 的思考模式。"
    },
    {
      label: "OpenAI GPT-5.5",
      providerId: "openai",
      modelId: openAIGpt55Model,
      description: "适合复杂专业工作和高难度工程任务的 OpenAI 模型。"
    },
    {
      label: "OpenAI GPT-5.4",
      providerId: "openai",
      modelId: openAIGpt54Model,
      description: "适合代码和通用专业工作的均衡模型。"
    },
    {
      label: "OpenAI GPT-5.4 mini",
      providerId: "openai",
      modelId: openAIGpt54MiniModel,
      description: "适合代码、工具调用和子任务的轻量模型。"
    },
    {
      label: "OpenAI GPT-5.4 nano",
      providerId: "openai",
      modelId: openAIGpt54NanoModel,
      description: "适合简单高频任务的低成本模型。"
    },
    {
      label: "OpenAI GPT-4.1",
      providerId: "openai",
      modelId: openAIGpt41Model,
      description: "适合代码和通用任务的非推理模型。"
    },
    {
      label: "OpenAI GPT-3.5 Turbo (Legacy)",
      providerId: "openai",
      modelId: openAIGpt35LegacyModel,
      description: "旧版兼容预设。"
    },
    {
      label: "OpenAI GPT-4 (Legacy)",
      providerId: "openai",
      modelId: openAIGpt4LegacyModel,
      description: "旧版兼容预设。"
    },
    {
      label: "OpenAI GPT-4o (Legacy)",
      providerId: "openai",
      modelId: openAIGpt4oLegacyModel,
      description: "旧版兼容预设。"
    },
    {
      label: "OpenAI GPT-4 Turbo (Legacy)",
      providerId: "openai",
      modelId: openAIGpt4TurboLegacyModel,
      description: "旧版兼容预设。"
    },
    {
      label: customProtocol === "anthropic" ? "Custom Claude API" : "Custom OpenAI API",
      providerId: "custom",
      modelId: customModel,
      description: customProtocol === "anthropic"
        ? `自定义 Claude / Anthropic 兼容接口：${getCustomBaseUrl()}`
        : `自定义 OpenAI 兼容接口：${getCustomBaseUrl()}`
    },
    {
      label: "Claude Opus 4.1",
      providerId: "anthropic",
      modelId: claudeOpusModel,
      description: "适合复杂推理和高难度代码任务的 Claude 模型。"
    },
    {
      label: "Claude Sonnet 4",
      providerId: "anthropic",
      modelId: claudeSonnetModel,
      description: "推理能力和速度较均衡，适合日常工程任务。"
    },
    {
      label: "Claude Haiku 3.5",
      providerId: "anthropic",
      modelId: claudeHaikuModel,
      description: "适合快速聊天和轻量代码任务。"
    },
    {
      label: "Claude Sonnet 3.7 (Legacy)",
      providerId: "anthropic",
      modelId: "claude-3-7-sonnet-latest",
      description: "旧版兼容预设。"
    },
    {
      label: "Claude Sonnet 3.5 (Legacy)",
      providerId: "anthropic",
      modelId: "claude-3-5-sonnet-latest",
      description: "旧版兼容预设。"
    },
    {
      label: "Doubao Seed Code",
      providerId: "doubao",
      modelId: doubaoModel,
      description: "字节豆包代码模型，适合修复问题和前端任务。"
    },
    {
      label: "Doubao Seed 1.6",
      providerId: "doubao",
      modelId: "doubao-seed-1.6",
      description: "字节豆包通用模型，适合 Agent 类任务。"
    },
    {
      label: "ERNIE 4.5 Turbo 128K",
      providerId: "ernie",
      modelId: ernieModel,
      description: "百度文心通用模型，适合长上下文任务。"
    },
    {
      label: "ERNIE 4.5 Turbo 32K (Legacy)",
      providerId: "ernie",
      modelId: "ernie-4.5-turbo-32k",
      description: "旧版兼容预设。"
    },
    {
      label: "Qwen3 Coder Next",
      providerId: "qwen",
      modelId: qwenModel,
      description: "阿里通义代码模型，适合项目级 Agent 工作流。"
    },
    {
      label: "Qwen3 Coder Plus",
      providerId: "qwen",
      modelId: "qwen3-coder-plus",
      description: "阿里通义高质量代码模型预设。"
    },
    {
      label: "Qwen3.5 Plus (Legacy)",
      providerId: "qwen",
      modelId: "qwen3.5-plus",
      description: "旧版兼容预设。"
    },
    {
      label: "Qwen Plus (Legacy)",
      providerId: "qwen",
      modelId: "qwen-plus",
      description: "旧版兼容预设。"
    },
    {
      label: "Hunyuan TurboS Latest",
      providerId: "hunyuan",
      modelId: hunyuanModel,
      description: "腾讯混元通用模型，适合 Agent 和代码任务。"
    },
    {
      label: "Hunyuan 2.0 Instruct",
      providerId: "hunyuan",
      modelId: "hunyuan-2.0-instruct-20251111",
      description: "腾讯混元指令模型，适合明确任务执行。"
    },
    {
      label: "GLM 4.7",
      providerId: "glm",
      modelId: glmModel,
      description: "智谱 GLM 通用模型，适合代码和 Agent 任务。"
    },
    {
      label: "GLM 4.6",
      providerId: "glm",
      modelId: "glm-4.6",
      description: "旧版兼容预设。"
    },
    {
      label: "Spark X2",
      providerId: "spark",
      modelId: sparkModel,
      description: "科大讯飞星火推理模型。"
    },
    {
      label: "Spark Ultra (Legacy)",
      providerId: "spark",
      modelId: "generalv3.5",
      description: "旧版兼容预设。"
    },
    {
      label: "Ollama Local",
      providerId: "ollama",
      modelId: ollamaModel,
      description: "通过 OpenAI 兼容接口连接本地 Ollama 模型。"
    },
    {
      label: "LM Studio Local",
      providerId: "lmStudio",
      modelId: lmStudioModel,
      description: "通过 OpenAI 兼容接口连接本地 LM Studio 模型。"
    }
  ];
}

export function getActiveModel(): ActiveModel {
  const configuredModel = getConfig().get<string>("model", "deepseek-v4-flash");
  const configuredProvider = getConfig().get<string>("provider", "deepseek");
  const option = getModelOptions().find((item) => item.providerId === configuredProvider && item.modelId === configuredModel);

  return {
    providerId: configuredProvider,
    modelId: configuredModel,
    label: option?.label ?? configuredModel
  };
}

export function getModelForTask(task: ModelTask): ActiveModel {
  const strategyEnabled = getConfig().get<boolean>("modelPolicy.enabled", true);
  if (!strategyEnabled) {
    return getActiveModel();
  }

  const active = getActiveModel();
  if (active.providerId !== "deepseek") {
    return active;
  }

  const defaultModel = getConfiguredString(getConfig(), "deepseek.defaultModel", [], "deepseek-v4-flash");
  const advancedModel = getConfiguredString(getConfig(), "deepseek.advancedModel", [], "deepseek-v4-pro");
  const modelId = task === "patch" || task === "patchRepair" ? advancedModel : defaultModel;
  const option = getModelOptions().find((item) => item.providerId === "deepseek" && item.modelId === modelId);

  return {
    providerId: "deepseek",
    modelId,
    label: option?.label ?? modelId
  };
}

export async function setActiveModel(providerId: string, modelId: string): Promise<void> {
  await getConfig().update("provider", providerId, vscode.ConfigurationTarget.Global);
  await getConfig().update("model", modelId, vscode.ConfigurationTarget.Global);
}

export function getWorkspaceCapabilityManifest(): CapabilityManifestState {
  const manifest = loadWorkspaceCapabilityManifest();
  return {
    version: manifest.version,
    skills: manifest.skills,
    tools: manifest.tools,
    mcpServers: manifest.mcpServers,
    diagnostics: manifest.diagnostics
  };
}

export function getAgentCapabilities(extraTools: AgentCapabilityConfig[] = []): AgentCapabilityState {
  const config = getConfig();
  const manifest = loadWorkspaceCapabilityManifest();
  const customSkills = normalizeCapabilities(
    config.get<AgentCapabilityConfig[]>("customSkills", []),
    "custom"
  );
  const customTools = normalizeCapabilities(
    config.get<AgentCapabilityConfig[]>("customTools", []),
    "custom"
  );

  return {
    skills: dedupeCapabilities([...builtinSkills(), ...customSkills, ...manifest.skills]),
    tools: dedupeCapabilities([...builtinTools(), ...mcpServerTools(), ...extraTools, ...customTools, ...manifest.tools])
  };
}

export function getMcpServerSummaries(runtime: Record<string, Partial<McpServerSummary>> = {}): McpServerSummary[] {
  const servers = getMcpServerConfigs();
  return Object.entries(servers).map(([name, server]) => ({
    name,
    transport: server.transport ?? "stdio",
    enabled: server.enabled !== false,
    toolCount: server.tools?.length ?? 0,
    discoveredToolCount: runtime[name]?.discoveredToolCount,
    discoveredResourceCount: runtime[name]?.discoveredResourceCount,
    discoveredPromptCount: runtime[name]?.discoveredPromptCount,
    status: runtime[name]?.status ?? "notStarted",
    lastError: runtime[name]?.lastError,
    pid: runtime[name]?.pid,
    command: server.command,
    url: server.url,
    recentLogs: runtime[name]?.recentLogs
  }));
}

export function getMcpServerConfigs(): Record<string, McpServerConfig> {
  const manifest = loadWorkspaceCapabilityManifest();
  const raw = getConfig().get<Record<string, McpServerConfig>>("mcp.servers", {});
  const servers: Record<string, McpServerConfig> = { ...manifest.mcpServers };
  if (!raw || typeof raw !== "object") {
    return servers;
  }

  for (const [name, value] of Object.entries(raw)) {
    if (!value || typeof value !== "object") {
      continue;
    }
    const serverName = name.trim();
    if (!serverName) {
      continue;
    }
    servers[serverName] = {
      transport: value.transport === "http" ? "http" : "stdio",
      command: typeof value.command === "string" ? value.command.trim() : undefined,
      args: Array.isArray(value.args) ? value.args.filter((arg) => typeof arg === "string").map((arg) => arg.trim()) : undefined,
      cwd: typeof value.cwd === "string" ? value.cwd.trim() : undefined,
      env: value.env && typeof value.env === "object" ? value.env : undefined,
      url: typeof value.url === "string" ? value.url.trim() : undefined,
      headers: value.headers && typeof value.headers === "object" ? normalizeHeaders(value.headers as Record<string, string>) : undefined,
      enabled: value.enabled !== false,
      tools: Array.isArray(value.tools)
        ? value.tools
            .filter((tool) => tool && typeof tool.name === "string" && tool.name.trim())
            .map((tool) => ({
              name: tool.name.trim(),
              label: typeof tool.label === "string" ? tool.label.trim() : undefined,
              description: typeof tool.description === "string" ? tool.description.trim() : undefined
            }))
        : undefined
    };
  }
  return servers;
}

function loadWorkspaceCapabilityManifest(): NormalizedCapabilityManifest {
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (!folder) {
    return emptyCapabilityManifest();
  }
  return loadCapabilityManifestFromFile(path.join(folder.uri.fsPath, ".patchlane", "patchlane.json"));
}

function getConfiguredString(
  config: vscode.WorkspaceConfiguration,
  key: string,
  legacyKeys: string[],
  fallback: string
): string {
  const keys = [key, ...legacyKeys];
  for (const candidate of keys) {
    const value = config.get<string>(candidate);
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }
  return fallback;
}

function isWebSearchProvider(value: string): value is WebSearchProvider {
  return ["free", "custom", "searxng", "tavily", "brave", "bing", "serpapi"].includes(value);
}

function normalizeDomainList(value: string[] | undefined): string[] {
  return [...new Set((value ?? [])
    .filter((item) => typeof item === "string")
    .map((item) => item.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/.*$/, ""))
    .filter(Boolean))];
}

function normalizeCapabilities(
  items: AgentCapabilityConfig[] | undefined,
  defaultKind: "custom" | "mcp"
): AgentCapabilityConfig[] {
  return (items ?? [])
    .filter((item) => item && typeof item.id === "string" && typeof item.label === "string" && typeof item.description === "string")
    .map((item) => ({
      id: item.id.trim(),
      label: item.label.trim(),
      description: item.description.trim(),
      kind: item.kind ?? defaultKind,
      command: item.command?.trim(),
      server: item.server?.trim(),
      script: item.script?.trim(),
      runtime: item.runtime,
      args: Array.isArray(item.args) ? item.args.filter((arg) => typeof arg === "string" && arg.trim()).map((arg) => arg.trim()) : undefined
    }))
    .filter((item) => Boolean(item.id) && Boolean(item.label) && Boolean(item.description));
}

function normalizeHeaders(value: Record<string, string>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key, headerValue]) => typeof key === "string" && key.trim() && typeof headerValue === "string" && headerValue.trim())
      .map(([key, headerValue]) => [key.trim(), headerValue.trim()])
  );
}

function dedupeCapabilities(items: AgentCapabilityConfig[]): AgentCapabilityConfig[] {
  const seen = new Set<string>();
  const result: AgentCapabilityConfig[] = [];
  for (const item of items) {
    if (seen.has(item.id)) {
      continue;
    }
    seen.add(item.id);
    result.push(item);
  }
  return result;
}

function builtinSkills(): AgentCapabilityConfig[] {
  return [
    { id: "review", label: "代码审查", description: "检查可读性、边界条件和潜在缺陷", kind: "builtin" },
    { id: "debug", label: "调试分析", description: "围绕报错、日志和复现路径定位问题", kind: "builtin" },
    { id: "tests", label: "测试生成", description: "补充单元测试、集成测试或验证步骤", kind: "builtin" },
    { id: "docs", label: "文档生成", description: "生成注释、README 或使用说明", kind: "builtin" },
    { id: "perf", label: "性能优化", description: "分析热点路径和资源消耗", kind: "builtin" },
    { id: "security", label: "安全检查", description: "检查输入校验、权限和敏感信息风险", kind: "builtin" }
  ];
}

function builtinTools(): AgentCapabilityConfig[] {
  return [
    { id: "files", label: "文件读写", description: "允许 Agent 基于工作区文件生成修改草稿", kind: "builtin" },
    { id: "terminal", label: "终端命令", description: "用于构建、测试、格式化和诊断", kind: "builtin" },
    { id: "search", label: "搜索分析", description: "用于检索代码、日志和上下文线索", kind: "builtin" },
    { id: "web-search", label: "联网搜索", description: "搜索最新官方文档、错误信息、Release 和网页资料", kind: "builtin" },
    { id: "docs-search", label: "官方文档搜索", description: "优先搜索官方文档、API Reference 和 SDK 说明", kind: "builtin" },
    { id: "github-search", label: "GitHub 搜索", description: "优先搜索仓库、Issue、Release 和 Discussion", kind: "builtin" },
    { id: "news-search", label: "最新消息搜索", description: "优先搜索 Release、Changelog 和近期公告", kind: "builtin" },
    { id: "tests", label: "测试运行器", description: "执行配置好的验证命令", kind: "builtin" },
    { id: "mcp", label: "MCP 工具", description: "连接 MCP 协议的外部工具", kind: "builtin" },
    { id: "custom", label: "自定义工具", description: "预留团队内部工具或业务系统入口", kind: "builtin" }
  ];
}

function mcpServerTools(): AgentCapabilityConfig[] {
  const servers = getMcpServerConfigs();
  const tools: AgentCapabilityConfig[] = [];
  for (const [serverName, server] of Object.entries(servers)) {
    if (server.enabled === false || !server.tools?.length) {
      continue;
    }
    for (const tool of server.tools) {
      tools.push({
        id: `mcp:${serverName}:${tool.name}`,
        label: tool.label || `${serverName}/${tool.name}`,
        description: tool.description || `调用 MCP 服务 ${serverName} 的工具 ${tool.name}`,
        kind: "mcp",
        server: serverName,
        command: tool.name,
        runtime: "mcp"
      });
    }
  }
  return tools;
}
