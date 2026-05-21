import * as path from "path";
import * as vscode from "vscode";
import { getActiveModel, getCustomBaseUrl, getCustomModel, getCustomProviderProtocol, getLmStudioBaseUrl, getModelOptions, getOllamaBaseUrl, getOpenAIBaseUrl, getProviderBaseUrl, setActiveModel } from "./config";
import { AnthropicProvider } from "./providers/anthropic";
import { CustomProvider } from "./providers/custom";
import { DeepSeekProvider } from "./providers/deepseek";
import { OpenAICompatibleProvider } from "./providers/openaiCompatible";
import { ProviderRegistry } from "./providers/registry";
import { ApprovalService } from "./services/approvalService";
import { AgentOrchestrator } from "./services/agentOrchestrator";
import { AgentToolLoop } from "./services/agentToolLoop";
import { CapabilityRunner } from "./services/capabilityRunner";
import { ChatSessionService } from "./services/chatSessionService";
import { GitService } from "./services/gitService";
import { filterPatchHunks, getHunkChoices } from "./services/hunkSelector";
import { InlineExplainService } from "./services/inlineExplainService";
import { McpClientService } from "./services/mcpClient";
import { PatchService } from "./services/patchService";
import { PatchWorkflowService } from "./services/patchWorkflow";
import { SecretService } from "./services/secretService";
import { VerifyService } from "./services/verifyService";
import { WebSearchService } from "./services/webSearchService";
import { doesSearchProviderNeedApiKey, webSearchProviderLabel } from "./services/webSearchDefaults";
import { WorkspaceIndexService } from "./services/workspaceIndex";
import { ChatViewProvider } from "./views/chatViewProvider";

export function activate(context: vscode.ExtensionContext): void {
  const secrets = new SecretService(context.secrets);
  const gitService = new GitService();
  const verifyService = new VerifyService();
  const workspaceIndexService = new WorkspaceIndexService();
  const chatSessionService = new ChatSessionService(context.workspaceState);
  const approvalService = new ApprovalService();
  const mcpClientService = new McpClientService();
  const capabilityRunner = new CapabilityRunner(approvalService, mcpClientService);
  const webSearchService = new WebSearchService(secrets);
  const agentOrchestrator = new AgentOrchestrator(gitService);
  const providers = new ProviderRegistry();

  providers.register(new DeepSeekProvider(async () => secrets.getDeepSeekApiKey()));
  providers.register(new OpenAICompatibleProvider({
    id: "openai",
    name: "OpenAI",
    baseUrlProvider: getOpenAIBaseUrl,
    apiKeyProvider: async () => secrets.getProviderApiKey("openai"),
    requireApiKey: true,
    useResponsesApi: true
  }));
  providers.register(new AnthropicProvider({
    baseUrlProvider: () => getProviderBaseUrl("anthropic", "https://api.anthropic.com/v1"),
    apiKeyProvider: async () => secrets.getProviderApiKey("anthropic")
  }));
  providers.register(new CustomProvider({
    baseUrlProvider: getCustomBaseUrl,
    apiKeyProvider: async () => secrets.getProviderApiKey("custom")
  }));
  registerPresetProviders(providers, secrets);
  providers.register(new OpenAICompatibleProvider({
    id: "ollama",
    name: "Ollama",
    baseUrlProvider: getOllamaBaseUrl,
    requireApiKey: false
  }));
  providers.register(new OpenAICompatibleProvider({
    id: "lmStudio",
    name: "LM Studio",
    baseUrlProvider: getLmStudioBaseUrl,
    requireApiKey: false
  }));

  const patchService = new PatchService(context.globalStorageUri);
  const agentToolLoop = new AgentToolLoop(providers);
  const patchWorkflow = new PatchWorkflowService(providers, gitService, patchService);
  const chatViewProvider = new ChatViewProvider(context.extensionUri, providers, gitService, patchWorkflow, chatSessionService, approvalService, capabilityRunner, webSearchService, mcpClientService, agentOrchestrator, agentToolLoop, verifyService);
  const inlineExplainService = new InlineExplainService(providers);

  context.subscriptions.push(
    mcpClientService,
    inlineExplainService,
    vscode.window.onDidChangeActiveTextEditor(() => chatViewProvider.refreshState()),
    vscode.window.onDidChangeTextEditorSelection(() => chatViewProvider.refreshState()),
    vscode.window.registerWebviewViewProvider(ChatViewProvider.viewType, chatViewProvider),
    vscode.commands.registerCommand("codeAgent.setApiKey", async () => setDeepSeekApiKey(secrets)),
    vscode.commands.registerCommand("codeAgent.setActiveProviderApiKey", async () => setActiveProviderApiKey(secrets)),
    vscode.commands.registerCommand("codeAgent.configureCustomProvider", async () => configureCustomProvider(secrets, chatViewProvider)),
    vscode.commands.registerCommand("codeAgent.configureWebSearch", async () => configureWebSearch(secrets, chatViewProvider)),
    vscode.commands.registerCommand("codeAgent.createCapabilityTemplates", async () => {
      await createCapabilityTemplates();
      chatViewProvider.refreshState();
    }),
    vscode.commands.registerCommand("codeAgent.switchModel", async () => switchModel(chatViewProvider)),
    vscode.commands.registerCommand("codeAgent.openChat", async () => chatViewProvider.openChatSession()),
    vscode.commands.registerCommand("codeAgent.runVerify", async () => runVerify(verifyService, approvalService)),
    vscode.commands.registerCommand("codeAgent.generatePatch", async () => {
      const request = await vscode.window.showInputBox({
        title: "生成修改",
        prompt: "描述你想让 AI 修改什么。修改会先生成草稿，确认后才会写入文件。",
        ignoreFocusOut: true,
        validateInput: (value) => value.trim() ? undefined : "请输入修改需求。"
      });

      if (!request) {
        return;
      }

      await patchWorkflow.generatePatch(request.trim());
      chatViewProvider.refreshState();
    }),
    vscode.commands.registerCommand("codeAgent.applyPatch", async () => {
      const result = await patchWorkflow.applyPendingPatch();
      if (result.status === "repaired") {
        vscode.window.showWarningMessage("修改应用失败，请先查看修复后的草稿再重新应用。");
      }
      chatViewProvider.refreshState();
    }),
    vscode.commands.registerCommand("codeAgent.applySelectedPatchHunks", async () => {
      await applySelectedPatchHunks(patchWorkflow);
      chatViewProvider.refreshState();
    }),
    vscode.commands.registerCommand("codeAgent.rollbackPatch", async () => {
      await patchWorkflow.rollbackLastPatch();
      chatViewProvider.refreshState();
    }),
    vscode.commands.registerCommand("codeAgent.indexWorkspace", async () => {
      const indexed = await workspaceIndexService.buildIndex();
      await showOutputDocument("Workspace Index", workspaceIndexService.formatIndex(indexed), "text");
    }),
    vscode.commands.registerCommand("codeAgent.explainSelection", async () => inlineExplainService.explainSelection()),
    vscode.commands.registerCommand("codeAgent.patchSelection", async () => {
      const target = getSelectedTextForAgent();
      await patchWorkflow.generatePatch(`Modify the current file selection in ${target.path}:\n\n${target.content}`);
      chatViewProvider.refreshState();
    })
  );
}

export function deactivate(): void {
  // No background resources to dispose.
}

function registerPresetProviders(providers: ProviderRegistry, secrets: SecretService): void {
  const presets = [
    { id: "doubao", name: "Doubao", baseUrl: "https://ark.cn-beijing.volces.com/api/v3" },
    { id: "ernie", name: "ERNIE", baseUrl: "https://qianfan.baidubce.com/v2" },
    { id: "qwen", name: "Qwen", baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1" },
    { id: "hunyuan", name: "Hunyuan", baseUrl: "https://api.hunyuan.cloud.tencent.com/v1" },
    { id: "glm", name: "GLM", baseUrl: "https://open.bigmodel.cn/api/paas/v4" },
    { id: "spark", name: "Spark", baseUrl: "https://spark-api-open.xf-yun.com/x2" }
  ];

  for (const preset of presets) {
    providers.register(new OpenAICompatibleProvider({
      id: preset.id,
      name: preset.name,
      baseUrlProvider: () => getProviderBaseUrl(preset.id, preset.baseUrl),
      apiKeyProvider: async () => secrets.getProviderApiKey(preset.id),
      requireApiKey: true
    }));
  }
}

async function setDeepSeekApiKey(secrets: SecretService): Promise<void> {
  const apiKey = await vscode.window.showInputBox({
    title: "设置 DeepSeek API Key",
    prompt: "输入你的 DeepSeek API Key。密钥会保存在 VS Code SecretStorage 中。",
    password: true,
    ignoreFocusOut: true,
    validateInput: (value) => value.trim() ? undefined : "请输入 API Key。"
  });

  if (!apiKey) {
    return;
  }

  await secrets.setDeepSeekApiKey(apiKey.trim());
  vscode.window.showInformationMessage("DeepSeek API Key 已保存。");
}

async function setActiveProviderApiKey(secrets: SecretService): Promise<void> {
  const active = getActiveModel();
  if (active.providerId === "deepseek") {
    await setDeepSeekApiKey(secrets);
    return;
  }
  if (active.providerId === "custom") {
    const apiKey = await vscode.window.showInputBox({
      title: "设置自定义模型 API Key",
      prompt: "这里只更新自定义模型 API Key。如需修改协议、Base URL 或模型 ID，请使用“Patchlane: 配置自定义模型”。",
      password: true,
      ignoreFocusOut: true,
      validateInput: (value) => value.trim() ? undefined : "请输入 API Key。"
    });
    if (!apiKey) {
      return;
    }
    await secrets.setProviderApiKey("custom", apiKey.trim());
    vscode.window.showInformationMessage("自定义模型 API Key 已保存。");
    return;
  }
  if (active.providerId === "ollama" || active.providerId === "lmStudio") {
    vscode.window.showInformationMessage(`${active.providerId} 默认不需要 API Key。`);
    return;
  }

  const apiKey = await vscode.window.showInputBox({
    title: `设置 ${active.providerId} API Key`,
    prompt: `输入 ${active.providerId} 的 API Key。密钥会保存在 VS Code SecretStorage 中。`,
    password: true,
    ignoreFocusOut: true,
    validateInput: (value) => value.trim() ? undefined : "请输入 API Key。"
  });

  if (!apiKey) {
    return;
  }

  await secrets.setProviderApiKey(active.providerId, apiKey.trim());
  vscode.window.showInformationMessage(`${active.providerId} API Key 已保存。`);
}

async function configureCustomProvider(secrets: SecretService, chatViewProvider: ChatViewProvider): Promise<void> {
  const protocol = await vscode.window.showQuickPick(
    [
      {
        label: "OpenAI Compatible",
        description: "适用于 /chat/completions 或 OpenAI Responses 兼容接口",
        value: "openai" as const
      },
      {
        label: "Claude / Anthropic",
        description: "适用于 /messages 兼容接口",
        value: "anthropic" as const
      }
    ],
    {
      title: "选择自定义模型接口协议",
      placeHolder: getCustomProviderProtocol() === "anthropic" ? "Claude / Anthropic" : "OpenAI Compatible",
      ignoreFocusOut: true
    }
  );
  if (!protocol) {
    return;
  }

  const fallbackBaseUrl = protocol.value === "anthropic" ? "https://api.anthropic.com/v1" : "https://api.openai.com/v1";
  const baseUrl = await vscode.window.showInputBox({
    title: "设置自定义 Base URL",
    prompt: "填写接口根地址，例如 https://api.openai.com/v1、https://api.anthropic.com/v1 或第三方转发地址。",
    value: getCustomBaseUrl() || fallbackBaseUrl,
    ignoreFocusOut: true,
    validateInput: (value) => value.trim().startsWith("http") ? undefined : "请输入以 http 或 https 开头的 Base URL。"
  });
  if (!baseUrl) {
    return;
  }

  const model = await vscode.window.showInputBox({
    title: "设置自定义模型 ID",
    prompt: protocol.value === "anthropic" ? "例如 claude-sonnet-4" : "例如 gpt-5.4-mini、qwen3-coder-plus 或服务商模型名。",
    value: getCustomModel(),
    ignoreFocusOut: true,
    validateInput: (value) => value.trim() ? undefined : "请输入模型 ID。"
  });
  if (!model) {
    return;
  }

  const apiKey = await vscode.window.showInputBox({
    title: "设置自定义 API Key",
    prompt: "密钥会保存在 VS Code SecretStorage 中。留空则只更新协议、Base URL 和模型 ID。",
    password: true,
    ignoreFocusOut: true
  });

  const config = vscode.workspace.getConfiguration("codeAgent");
  await config.update("custom.protocol", protocol.value, vscode.ConfigurationTarget.Global);
  await config.update("custom.baseUrl", baseUrl.trim().replace(/\/+$/, ""), vscode.ConfigurationTarget.Global);
  await config.update("custom.model", model.trim(), vscode.ConfigurationTarget.Global);
  await setActiveModel("custom", model.trim());
  if (apiKey?.trim()) {
    await secrets.setProviderApiKey("custom", apiKey.trim());
  }

  chatViewProvider.refreshState();
  vscode.window.showInformationMessage(`已配置自定义模型：${protocol.label} / ${model.trim()}。`);
}

async function configureWebSearch(secrets: SecretService, chatViewProvider: ChatViewProvider): Promise<void> {
  const provider = await vscode.window.showQuickPick(
    [
      { label: "免费搜索（无需 Key）", description: "默认使用公开 SearXNG 实例；也可填写自建 SearXNG 地址", value: "free" },
      { label: "SearXNG（自建/团队）", description: "无需 API Key，但需要填写自己的 SearXNG Base URL", value: "searxng" },
      { label: "Tavily", description: "适合 Agent 检索的搜索 API，需要 API Key", value: "tavily" },
      { label: "Brave Search", description: "Brave Web Search API，需要 API Key", value: "brave" },
      { label: "Bing", description: "Bing Web Search API，需要 API Key", value: "bing" },
      { label: "SerpAPI", description: "Google 结果聚合 API，需要 API Key", value: "serpapi" },
      { label: "自定义搜索接口", description: "兼容 q/num 参数的搜索接口，通常需要自行提供 Base URL 和 Key", value: "custom" }
    ],
    {
      title: "选择联网搜索服务商",
      ignoreFocusOut: true
    }
  );
  if (!provider) {
    return;
  }

  const needsApiKey = doesSearchProviderNeedApiKey(provider.value);
  const needsBaseUrl = provider.value === "custom" || provider.value === "searxng";
  const optionalBaseUrl = provider.value === "free";
  const baseUrl = await vscode.window.showInputBox({
    title: "设置搜索 Base URL",
    prompt: optionalBaseUrl
      ? "可留空使用内置免费搜索实例；如果你有自建 SearXNG，可填入地址，仍然不需要 API Key。"
      : needsBaseUrl
        ? "请输入搜索服务 Base URL。"
        : "可留空使用该服务的默认地址。",
    value: "",
    ignoreFocusOut: true
  });
  if (baseUrl === undefined) {
    return;
  }
  if (needsBaseUrl && !baseUrl.trim()) {
    vscode.window.showWarningMessage(`${provider.label} 需要填写 Base URL。`);
    return;
  }

  let apiKey: string | undefined;
  if (needsApiKey) {
    apiKey = await vscode.window.showInputBox({
      title: "设置搜索 API Key",
      prompt: `${provider.label} 需要 API Key。密钥会保存到 VS Code SecretStorage，不会写入 settings.json。`,
      password: true,
      ignoreFocusOut: true,
      validateInput: (value) => value.trim() ? undefined : "请输入搜索服务 API Key，或返回选择“免费搜索（无需 Key）”。"
    });
    if (apiKey === undefined) {
      return;
    }
  }

  const config = vscode.workspace.getConfiguration("codeAgent");
  await config.update("webSearch.enabled", true, vscode.ConfigurationTarget.Global);
  await config.update("webSearch.provider", provider.value, vscode.ConfigurationTarget.Global);
  await config.update("webSearch.baseUrl", baseUrl.trim().replace(/\/+$/, ""), vscode.ConfigurationTarget.Global);
  if (apiKey?.trim()) {
    await secrets.setWebSearchApiKey(apiKey.trim());
  }

  chatViewProvider.refreshState();
  vscode.window.showInformationMessage(`已启用联网搜索：${webSearchProviderLabel(provider.value)}。`);
}

async function createCapabilityTemplates(): Promise<void> {
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (!folder) {
    throw new Error("请先打开一个工作区文件夹。");
  }

  const root = folder.uri;
  const templates = [
    {
      path: ".patchlane/skills/frontend-review/index.js",
      content: frontendReviewSkillTemplate()
    },
    {
      path: ".patchlane/tools/project-summary/index.js",
      content: projectSummaryToolTemplate()
    },
    {
      path: ".patchlane/mcp/example/server.js",
      content: exampleMcpServerTemplate()
    },
    {
      path: ".patchlane/patchlane.json",
      content: capabilityManifestTemplate()
    },
    {
      path: ".patchlane/README.md",
      content: capabilityTemplateReadme()
    }
  ];

  for (const template of templates) {
    const uri = workspaceUri(root, template.path);
    await vscode.workspace.fs.createDirectory(parentUri(uri));
    const exists = await fileExists(uri);
    if (!exists) {
      await vscode.workspace.fs.writeFile(uri, new TextEncoder().encode(template.content));
    }
  }

  const config = vscode.workspace.getConfiguration("codeAgent", root);
  await mergeWorkspaceConfigArray(config, "customSkills", [{
    id: "frontend-review",
    label: "前端体验审查",
    description: "检查布局、响应式、可访问性和交互细节",
    kind: "custom",
    runtime: "node",
    script: ".patchlane/skills/frontend-review/index.js"
  }]);
  await mergeWorkspaceConfigArray(config, "customTools", [{
    id: "project-summary",
    label: "项目摘要",
    description: "快速读取项目说明和脚本，给 Agent 提供轻量上下文",
    kind: "custom",
    runtime: "node",
    script: ".patchlane/tools/project-summary/index.js"
  }]);
  await mergeMcpServerConfig(config);

  const openReadme = "打开说明";
  const choice = await vscode.window.showInformationMessage("Patchlane 扩展模板已生成，并写入 .patchlane/patchlane.json 和当前工作区设置。", openReadme);
  if (choice === openReadme) {
    const doc = await vscode.workspace.openTextDocument(workspaceUri(root, ".patchlane/README.md"));
    await vscode.window.showTextDocument(doc, { preview: false, viewColumn: vscode.ViewColumn.Beside });
  }
}

async function switchModel(chatViewProvider: ChatViewProvider): Promise<void> {
  const selected = await vscode.window.showQuickPick(
    getModelOptions().map((option) => ({
      label: option.label,
      description: `${option.providerId} / ${option.modelId}`,
      detail: option.description,
      option
    })),
    {
      title: "切换 Patchlane 模型",
      placeHolder: getActiveModel().modelId
    }
  );

  if (!selected) {
    return;
  }

  await setActiveModel(selected.option.providerId, selected.option.modelId);
  chatViewProvider.refreshState();
  vscode.window.showInformationMessage(`已切换到 ${selected.option.label}。`);
}

async function runVerify(verifyService: VerifyService, approvalService: ApprovalService): Promise<void> {
  const configuredCommands = verifyService.getConfiguredCommands();
  const selected = await vscode.window.showQuickPick(
    [
      {
        label: "运行全部验证命令",
        description: `${configuredCommands.length} 条，失败即停止`,
        commands: configuredCommands
      },
      ...configuredCommands.map((command) => ({
        label: command,
        description: "只运行这一条命令",
        commands: [command]
      }))
    ],
    {
      title: "运行验证命令"
    }
  );

  if (!selected || selected.commands.length === 0) {
    return;
  }

  for (const command of selected.commands) {
    const approved = await approvalService.ensureCommandApproval({
      sessionId: "command-palette",
      toolId: "verify",
      label: "验证命令",
      command,
      cwd: verifyService.getWorkspaceRoot(),
      reason: "从命令面板运行工作区验证"
    });
    if (approved !== "approved") {
      return;
    }
  }

  const result = await verifyService.runSuite({
    commands: selected.commands,
    stopOnFailure: true
  });

  await showOutputDocument(
    "Verify Suite",
    [
      `Passed: ${result.passed}`,
      `Failure Kind: ${result.failureKind}`,
      `Duration: ${result.durationMs}ms`,
      "",
      ...result.results.flatMap((item) => [
        `$ ${item.command}`,
        `Exit Code: ${item.exitCode}`,
        item.summary ? `Summary: ${item.summary}` : "",
        item.output,
        ""
      ])
    ].filter(Boolean).join("\n"),
    "text"
  );
}

async function applySelectedPatchHunks(patchWorkflow: PatchWorkflowService): Promise<void> {
  const state = patchWorkflow.getState();
  if (!state.pendingPatch) {
    throw new Error("暂无待确认修改。");
  }

  const selected = await vscode.window.showQuickPick(
    getHunkChoices(state.pendingPatch.patchText).map((choice) => ({
      label: choice.label,
      description: choice.description,
      choice
    })),
    {
      canPickMany: true,
      title: "选择要保留的修改片段"
    }
  );

  if (!selected || selected.length === 0) {
    return;
  }

  const filteredPatch = filterPatchHunks(state.pendingPatch.patchText, selected.map((item) => item.choice));
  await patchWorkflow.replacePendingPatch(filteredPatch, `${state.pendingPatch.request} (selected hunks)`);
}

function workspaceUri(root: vscode.Uri, relativePath: string): vscode.Uri {
  return vscode.Uri.joinPath(root, ...relativePath.split("/"));
}

function parentUri(uri: vscode.Uri): vscode.Uri {
  return vscode.Uri.file(path.dirname(uri.fsPath));
}

async function fileExists(uri: vscode.Uri): Promise<boolean> {
  return Boolean(await vscode.workspace.fs.stat(uri).then(() => true, () => false));
}

async function mergeWorkspaceConfigArray(config: vscode.WorkspaceConfiguration, key: string, additions: Array<Record<string, unknown>>): Promise<void> {
  const current = config.get<Array<Record<string, unknown>>>(key, []);
  const existingIds = new Set(current.map((item) => String(item.id ?? "")));
  const merged = [...current];
  for (const addition of additions) {
    const id = String(addition.id ?? "");
    if (!existingIds.has(id)) {
      merged.push(addition);
    }
  }
  await config.update(key, merged, vscode.ConfigurationTarget.Workspace);
}

async function mergeMcpServerConfig(config: vscode.WorkspaceConfiguration): Promise<void> {
  const current = config.get<Record<string, unknown>>("mcp.servers", {});
  if (current.example) {
    return;
  }
  await config.update("mcp.servers", {
    ...current,
    example: {
      enabled: true,
      transport: "stdio",
      command: "node",
      args: [".patchlane/mcp/example/server.js"],
      cwd: "${workspaceFolder}",
      tools: [
        {
          name: "project_info",
          label: "项目基础信息",
          description: "读取 package.json 和 README 的轻量摘要"
        }
      ]
    }
  }, vscode.ConfigurationTarget.Workspace);
}

function frontendReviewSkillTemplate(): string {
  return `const fs = require("fs");
const path = require("path");

const input = readStdin();
const workspace = process.env.PATCHLANE_WORKSPACE || process.cwd();
const files = findFiles(workspace, [".tsx", ".jsx", ".css"], 40);

console.log("# 前端体验审查");
console.log("");
console.log("## 任务");
console.log(input.trim() || "未提供任务输入。");
console.log("");
console.log("## 可参考文件");
for (const file of files.slice(0, 20)) {
  console.log("- " + path.relative(workspace, file).replace(/\\\\/g, "/"));
}
console.log("");
console.log("## 审查重点");
console.log("- 检查布局密度、滚动区域、按钮状态、Markdown / 代码块渲染。");
console.log("- 优先引用当前文件和已打开文件，不要把整个项目塞给模型。");

function readStdin() {
  try {
    return fs.readFileSync(0, "utf8");
  } catch {
    return "";
  }
}

function findFiles(root, extensions, limit) {
  const results = [];
  const ignored = new Set(["node_modules", ".git", "dist", "out", "build", ".next", "coverage"]);
  walk(root);
  return results;

  function walk(dir) {
    if (results.length >= limit) {
      return;
    }
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (ignored.has(entry.name)) {
        continue;
      }
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (extensions.includes(path.extname(entry.name))) {
        results.push(full);
      }
    }
  }
}
`;
}

function projectSummaryToolTemplate(): string {
  return [
    'const fs = require("fs");',
    'const path = require("path");',
    "",
    "const workspace = process.env.PATCHLANE_WORKSPACE || process.cwd();",
    "const input = readStdin();",
    "",
    'console.log("# 项目摘要");',
    'console.log("");',
    'printFile("package.json", 12000);',
    'printFile("README.md", 12000);',
    'console.log("");',
    'console.log("## 当前任务");',
    'console.log(input.trim() || "未提供任务输入。");',
    "",
    "function printFile(name, maxChars) {",
    "  const file = path.join(workspace, name);",
    "  if (!fs.existsSync(file)) {",
    "    return;",
    "  }",
    '  const content = fs.readFileSync(file, "utf8").slice(0, maxChars);',
    '  console.log("## " + name);',
    '  console.log("```text");',
    "  console.log(content);",
    '  console.log("```");',
    "}",
    "",
    "function readStdin() {",
    "  try {",
    '    return fs.readFileSync(0, "utf8");',
    "  } catch {",
    '    return "";',
    "  }",
    "}",
    ""
  ].join("\n");
}

function exampleMcpServerTemplate(): string {
  return [
    'const fs = require("fs");',
    'const path = require("path");',
    'const readline = require("readline");',
    "",
    "const workspace = process.env.PATCHLANE_WORKSPACE || process.cwd();",
    "const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: false });",
    "",
    'rl.on("line", async (line) => {',
    "  if (!line.trim()) {",
    "    return;",
    "  }",
    "  const request = JSON.parse(line);",
    "  try {",
    '    if (request.method === "initialize") {',
    '      respond(request.id, { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "patchlane-example", version: "0.1.0" } });',
    "      return;",
    "    }",
    '    if (request.method === "tools/list") {',
    "      respond(request.id, {",
    "        tools: [{",
    '          name: "project_info",',
    '          description: "读取 package.json 和 README 的轻量摘要",',
    '          inputSchema: { type: "object", properties: {} }',
    "        }]",
    "      });",
    "      return;",
    "    }",
    '    if (request.method === "tools/call") {',
    "      const name = request.params && request.params.name;",
    '      if (name !== "project_info") {',
    '        throw new Error("未知工具：" + name);',
    "      }",
    "      respond(request.id, { content: [{ type: \"text\", text: projectInfo() }] });",
    "      return;",
    "    }",
    "    respond(request.id, {});",
    "  } catch (error) {",
    "    respondError(request.id, error.message || String(error));",
    "  }",
    "});",
    "",
    "function projectInfo() {",
    "  return [",
    '    "# MCP 项目基础信息",',
    '    readOptional("package.json", 12000),',
    '    readOptional("README.md", 12000)',
    '  ].filter(Boolean).join("\\n\\n");',
    "}",
    "",
    "function readOptional(name, maxChars) {",
    "  const file = path.join(workspace, name);",
    "  if (!fs.existsSync(file)) {",
    '    return "";',
    "  }",
    '  return "## " + name + "\\n\\n```text\\n" + fs.readFileSync(file, "utf8").slice(0, maxChars) + "\\n```";',
    "}",
    "",
    "function respond(id, result) {",
    '  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\\n");',
    "}",
    "",
    "function respondError(id, message) {",
    '  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, error: { code: -32000, message } }) + "\\n");',
    "}",
    ""
  ].join("\n");
}

function capabilityTemplateReadme(): string {
  return `# Patchlane 扩展模板

这里的文件用于扩展 Patchlane Agent 能力。

## 目录

- \`skills/frontend-review/index.js\`：示例 Skill。适合沉淀团队工作流、审查标准、提示词和脚本。
- \`tools/project-summary/index.js\`：示例工具。适合读取需求、Issue、文档、业务系统摘要。
- \`mcp/example/server.js\`：示例 stdio MCP Server。MCP 可以用 Node、Python、Go 等任意语言实现。
- \`patchlane.json\`：团队共享清单。提交到 Git 后，团队成员不需要手动复制 settings 也能看到同一批 Skill、Tool 和 MCP 服务。

## 如何使用

1. 在 Patchlane 设置页点击“发现 MCP 工具”。
2. 在输入框底部选择需要的 Skill 或 MCP。
3. 发送 Agent 任务。真正执行脚本、命令、联网搜索或文件写入前，页面里会出现审批卡片。

同一会话同一个 Skill / 工具审批一次即可；命令默认每次审批，也可以选择本会话记住同一条命令。

## 推荐协作方式

- 团队共用能力写在 \`patchlane.json\`，脚本放在当前目录下。
- 个人临时能力仍可以写在 VS Code 的 \`codeAgent.customSkills\`、\`codeAgent.customTools\`、\`codeAgent.mcp.servers\`。
- 如果同一个 ID 同时出现在 settings 和清单里，settings 优先生效，方便个人覆盖。
`;
}

function capabilityManifestTemplate(): string {
  return JSON.stringify({
    version: "1.0.0",
    skills: [
      {
        id: "frontend-review",
        label: "前端体验审查",
        description: "检查布局、响应式、可访问性和交互细节",
        kind: "custom",
        runtime: "node",
        script: ".patchlane/skills/frontend-review/index.js"
      }
    ],
    tools: [
      {
        id: "project-summary",
        label: "项目摘要",
        description: "快速读取项目说明和脚本，给 Agent 提供轻量上下文",
        kind: "custom",
        runtime: "node",
        script: ".patchlane/tools/project-summary/index.js"
      }
    ],
    mcpServers: {
      example: {
        enabled: true,
        transport: "stdio",
        command: "node",
        args: [".patchlane/mcp/example/server.js"],
        cwd: "${workspaceFolder}",
        tools: [
          {
            name: "project_info",
            label: "项目基础信息",
            description: "读取 package.json 和 README 的轻量摘要"
          }
        ]
      }
    }
  }, null, 2) + "\n";
}

function getSelectedTextForAgent(): { path?: string; content: string } {
  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    throw new Error("请先打开一个文件。");
  }

  const content = !editor.selection.isEmpty ? editor.document.getText(editor.selection) : editor.document.getText();
  return {
    path: vscode.workspace.asRelativePath(editor.document.uri, false),
    content
  };
}

async function showOutputDocument(title: string, content: string, language: string): Promise<void> {
  const document = await vscode.workspace.openTextDocument({
    content,
    language
  });
  await vscode.window.showTextDocument(document, {
    preview: false,
    viewColumn: vscode.ViewColumn.Beside
  });
  vscode.window.setStatusBarMessage(title, 3000);
}
