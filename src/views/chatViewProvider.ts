import * as path from "path";
import * as vscode from "vscode";
import { AgentCapabilityConfig, AgentCapabilityState, CapabilityManifestState, doesWebSearchRequireApproval, getActiveModel, getAgentCapabilities, getAgentContextBudget, getAgentMaxRepairAttempts, getAgentMaxToolRounds, getModelForTask, getModelMaxTokens, getModelOptions, getModelTemperature, getModelTopP, getMcpServerSummaries, McpServerSummary, getWebSearchAllowedDomains, getWebSearchProvider, getWebSearchSettings, getWorkspaceCapabilityManifest, setActiveModel } from "../config";
import { formatProviderErrorForUser } from "../providers/errors";
import { ProviderRegistry } from "../providers/registry";
import { ApprovalDecision, ApprovalPromptRequest, ApprovalService } from "../services/approvalService";
import { createFailureStrategyFromVerify, formatFailureStrategyForPrompt } from "../services/agentFailureStrategy";
import { AgentMemoryContext, buildAgentMemoryContext } from "../services/agentMemory";
import { AgentOrchestrator } from "../services/agentOrchestrator";
import { AgentToolLoop } from "../services/agentToolLoop";
import { CapabilityRunner, CapabilityRunResult } from "../services/capabilityRunner";
import { CapabilityRunRecord, CapabilityRunStatus, ChatMode, ChatSession, ChatSessionService, ChatSessionTaskState, ChatTranscriptItem } from "../services/chatSessionService";
import { GitService } from "../services/gitService";
import { McpClientService, McpDiscoveredServerCatalog } from "../services/mcpClient";
import { PatchWorkflowService } from "../services/patchWorkflow";
import { VerifyResult, VerifyService, VerifySuiteResult } from "../services/verifyService";
import { WebSearchResponse, WebSearchService } from "../services/webSearchService";
import { formatWebSearchError } from "../services/webSearchErrors";
import { collectWorkspaceContext, WorkspaceContext } from "../services/workspaceContext";
import { collectPromptFileReferences, getPreferredReferenceFiles, openWorkspaceFile, readWorkspaceFile, WorkspaceFileSummary } from "../services/workspaceFiles";

type WebviewKind = "sessions" | "chat";

type WebviewMessageType =
  | "ready"
  | "newSession"
  | "openSession"
  | "deleteSession"
  | "renameSession"
  | "sendChat"
  | "switchModel"
  | "clearTranscript"
  | "stopGeneration"
  | "copyMessage"
  | "copyText"
  | "openUrl"
  | "fetchUrl"
  | "insertText"
  | "resendMessage"
  | "editMessage"
  | "showHelp"
  | "runVerify"
  | "runSessionVerify"
  | "verifyAndFix"
  | "setApiKey"
  | "configureCustomProvider"
  | "configureWebSearch"
  | "createCapabilityTemplates"
  | "createSkillFromTemplate"
  | "openSettingsTarget"
  | "runWebSearch"
  | "openSettings"
  | "indexWorkspace"
  | "explainSelection"
  | "patchSelection"
  | "explainInline"
  | "generatePatch"
  | "applyPatch"
  | "applySelectedPatchHunks"
  | "rollbackPatch"
  | "discardPatch"
  | "previewPatch"
  | "runCapability"
  | "discoverMcpTools"
  | "restartMcpServer"
  | "stopMcpServer"
  | "clearMcpLogs"
  | "readMcpResource"
  | "useMcpPrompt"
  | "listWorkspaceFiles"
  | "openWorkspaceFile"
  | "readWorkspaceFile"
  | "resolveApproval";

interface WebviewMessage {
  type: WebviewMessageType;
  text?: string;
  mode?: ChatMode;
  skillIds?: string[];
  toolIds?: string[];
  providerId?: string;
  modelId?: string;
  messageIndex?: number;
  sessionId?: string;
  title?: string;
  path?: string;
  query?: string;
  settingKey?: string;
  skillName?: string;
  skillDescription?: string;
  skillRuntime?: "node" | "python" | "shell";
  capabilityId?: string;
  capabilityType?: "skill" | "tool";
  serverName?: string;
  resourceUri?: string;
  promptName?: string;
  promptArguments?: Record<string, string>;
  approvalId?: string;
  approvalDecision?: ApprovalDecision;
  language?: string;
  sourceHint?: "general" | "docs" | "news" | "github";
}

interface EditorContextSummary {
  file?: string;
  selection?: string;
  language?: string;
  hasFile: boolean;
  hasSelection: boolean;
  workspace?: string;
}

interface CapabilityContext {
  skills: AgentCapabilityConfig[];
  tools: AgentCapabilityConfig[];
}

interface RunningSessionTask {
  controller: AbortController;
  label: string;
  kind: ChatSessionTaskState["kind"];
}

type CapabilityDiagnosticSeverity = "info" | "warning" | "error";

interface CapabilityDiagnostic {
  id: string;
  severity: CapabilityDiagnosticSeverity;
  scope: "skill" | "tool" | "mcp";
  title: string;
  detail: string;
  target?: string;
  targetKind?: "setting" | "file";
  action?: string;
  actionLabel?: string;
}

type ProgressStepKind = NonNullable<NonNullable<ChatTranscriptItem["progressSteps"]>[number]["kind"]>;

const COMMAND_MESSAGES: Partial<Record<WebviewMessageType, string>> = {
  indexWorkspace: "codeAgent.indexWorkspace",
  explainSelection: "codeAgent.explainSelection",
  patchSelection: "codeAgent.patchSelection",
  applySelectedPatchHunks: "codeAgent.applySelectedPatchHunks"
};

export class ChatViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = "codeAgent.chatView";

  private view?: vscode.WebviewView;
  private readonly panels = new Set<ChatPanel>();
  private readonly runningTasks = new Map<string, RunningSessionTask>();

  public constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly providers: ProviderRegistry,
    private readonly gitService: GitService,
    private readonly patchWorkflow: PatchWorkflowService,
    private readonly sessions: ChatSessionService,
    private readonly approvals: ApprovalService,
    private readonly capabilityRunner: CapabilityRunner,
    private readonly webSearch: WebSearchService,
    private readonly mcpClient: McpClientService,
    private readonly agentOrchestrator: AgentOrchestrator,
    private readonly agentToolLoop: AgentToolLoop,
    private readonly verifyService: VerifyService
  ) {}

  public resolveWebviewView(webviewView: vscode.WebviewView): void {
    this.view = webviewView;
    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [
        this.extensionUri,
        vscode.Uri.joinPath(this.extensionUri, "media")
      ]
    };

    webviewView.webview.html = getHtml(webviewView.webview, this.extensionUri, "sessions");
    webviewView.webview.onDidReceiveMessage((message: WebviewMessage) => this.handleSidebarMessage(message));
  }

  public refreshState(): void {
    void this.refreshStateAsync();
  }

  public async sendPrompt(prompt: string): Promise<void> {
    const panel = await this.openChatSession();
    await panel.sendPrompt(prompt);
  }

  public async openChatSession(sessionId?: string): Promise<ChatPanel> {
    if (sessionId) {
      const existing = [...this.panels].find((panel) => panel.sessionId === sessionId);
      if (existing) {
        await existing.refreshFromStorage();
        existing.reveal();
        this.postSidebarState();
        return existing;
      }
    }

    const session = sessionId ? this.sessions.getSession(sessionId) ?? await this.sessions.createSession() : await this.sessions.createSession();
    const panel = new ChatPanel(
      this.extensionUri,
      this.providers,
      this.gitService,
      this.patchWorkflow,
      this.sessions,
      this.approvals,
      this.capabilityRunner,
      this.webSearch,
      this.mcpClient,
      this.agentOrchestrator,
      this.agentToolLoop,
      this.verifyService,
      this.runningTasks,
      session,
      () => this.refreshState(),
      () => this.panels.delete(panel)
    );
    this.panels.add(panel);
    panel.reveal();
    this.postSidebarState();
    return panel;
  }

  private async refreshStateAsync(): Promise<void> {
    this.postSidebarState();
    for (const panel of this.panels) {
      await panel.refreshFromStorage();
    }
  }

  private async handleSidebarMessage(message: WebviewMessage): Promise<void> {
    try {
      if (message.type === "ready") {
        this.postSidebarState();
        return;
      }

      if (message.type === "newSession") {
        await this.openChatSession();
        return;
      }

      if (message.type === "openSession" && message.sessionId) {
        await this.openChatSession(message.sessionId);
        return;
      }

      if (message.type === "deleteSession" && message.sessionId) {
        await this.sessions.deleteSession(message.sessionId);
        this.approvals.clearSession(message.sessionId);
        this.postSidebarState();
        return;
      }

      if (message.type === "renameSession" && message.sessionId && typeof message.title === "string") {
        await this.sessions.renameSession(message.sessionId, message.title);
        this.postSidebarState();
        return;
      }

      if (message.type === "switchModel" && message.providerId && message.modelId) {
        await setActiveModel(message.providerId, message.modelId);
        this.refreshState();
        return;
      }

      if (message.type === "setApiKey") {
        const active = getActiveModel();
        if (active.providerId === "deepseek") {
          await vscode.commands.executeCommand("codeAgent.setApiKey");
        } else if (active.providerId === "custom") {
          await vscode.commands.executeCommand("codeAgent.configureCustomProvider");
        } else {
          await vscode.commands.executeCommand("codeAgent.setActiveProviderApiKey");
        }
        this.refreshState();
        return;
      }

      if (message.type === "configureCustomProvider") {
        await vscode.commands.executeCommand("codeAgent.configureCustomProvider");
        this.refreshState();
        return;
      }

      if (message.type === "createCapabilityTemplates") {
        await vscode.commands.executeCommand("codeAgent.createCapabilityTemplates");
        this.refreshState();
        return;
      }

      if (message.type === "openSettings") {
        await vscode.commands.executeCommand("workbench.action.openSettings", "@ext:local-dev.patchlane");
        return;
      }

      if (message.type === "openSettingsTarget") {
        await vscode.commands.executeCommand("workbench.action.openSettings", normalizeSettingsTarget(message.settingKey));
        return;
      }
    } catch (error) {
      vscode.window.showErrorMessage(error instanceof Error ? error.message : String(error));
    }
  }

  private postSidebarState(): void {
    const capabilities = this.getCapabilities();
    const mcpServers = getMcpServerSummaries(this.mcpClient.getRuntimeSummary());
    const mcpCatalog = this.mcpClient.getDiscoveredCatalog();
    const capabilityManifest = getWorkspaceCapabilityManifest();
    this.view?.webview.postMessage({
      type: "state",
      view: "sessions",
      sessions: this.sessions.getSessions(),
      activeModel: getActiveModel(),
      models: getModelOptions(),
      capabilities,
      mcpServers,
      mcpCatalog,
      capabilityDiagnostics: buildCapabilityDiagnostics(capabilities, mcpServers, mcpCatalog, capabilityManifest),
      webSearch: getWebSearchSettings(),
      agentSettings: {
        contextBudget: getAgentContextBudget().mode,
        maxRepairAttempts: getAgentMaxRepairAttempts(),
        maxToolRounds: getAgentMaxToolRounds()
      },
      context: getEditorContextSummary()
    });
  }

  private getCapabilities(): AgentCapabilityState {
    return getAgentCapabilities(this.mcpClient.getDiscoveredToolCapabilities());
  }
}

class ChatPanel {
  private readonly panel: vscode.WebviewPanel;
  private busyLabel?: string;
  private progressMessageId?: string;
  private activeAbortController?: AbortController;
  private transcript: ChatTranscriptItem[];
  private workspaceFiles: WorkspaceFileSummary[] = [];
  private readonly pendingApprovals: ApprovalPromptRequest[] = [];
  private readonly approvalResolvers = new Map<string, (decision: ApprovalDecision) => void>();
  private readonly approvalPromptDisposable: vscode.Disposable;
  private disposed = false;

  public constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly providers: ProviderRegistry,
    private readonly gitService: GitService,
    private readonly patchWorkflow: PatchWorkflowService,
    private readonly sessions: ChatSessionService,
    private readonly approvals: ApprovalService,
    private readonly capabilityRunner: CapabilityRunner,
    private readonly webSearch: WebSearchService,
    private readonly mcpClient: McpClientService,
    private readonly agentOrchestrator: AgentOrchestrator,
    private readonly agentToolLoop: AgentToolLoop,
    private readonly verifyService: VerifyService,
    private readonly runningTasks: Map<string, RunningSessionTask>,
    private session: ChatSession,
    private readonly onStateChange: () => void,
    onDispose: () => void
  ) {
    this.transcript = [...session.messages];
    this.panel = vscode.window.createWebviewPanel(
      "codeAgent.chatPanel",
      `Patchlane: ${session.title}`,
      vscode.ViewColumn.Beside,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [
          this.extensionUri,
          vscode.Uri.joinPath(this.extensionUri, "media")
        ]
      }
    );
    this.panel.webview.html = getHtml(this.panel.webview, this.extensionUri, "chat");
    this.panel.webview.onDidReceiveMessage((message: WebviewMessage) => this.handleMessage(message));
    this.approvalPromptDisposable = this.approvals.registerPromptHandler(this.session.id, (request) => this.requestPageApproval(request));
    this.panel.onDidDispose(() => {
      this.disposed = true;
      void this.handlePanelDispose();
      this.approvalPromptDisposable.dispose();
      for (const resolve of this.approvalResolvers.values()) {
        resolve("reject");
      }
      this.approvalResolvers.clear();
      this.pendingApprovals.splice(0, this.pendingApprovals.length);
      onDispose();
    });
  }

  public reveal(): void {
    this.panel.reveal(vscode.ViewColumn.Beside);
  }

  public get sessionId(): string {
    return this.session.id;
  }

  public postState(): void {
    if (this.disposed) {
      return;
    }

    const capabilities = this.getCapabilities();
    const mcpServers = getMcpServerSummaries(this.mcpClient.getRuntimeSummary());
    const mcpCatalog = this.mcpClient.getDiscoveredCatalog();
    const capabilityManifest = getWorkspaceCapabilityManifest();
    this.panel.title = `Patchlane: ${this.session.title}`;
    this.panel.webview.postMessage({
      type: "state",
      view: "chat",
      session: this.session,
      sessions: this.sessions.getSessions(),
      activeModel: getActiveModel(),
      models: getModelOptions(),
      transcript: this.transcript,
      patch: this.patchWorkflow.getState(),
      context: getEditorContextSummary(),
      workspaceFiles: this.workspaceFiles,
      capabilities,
      mcpServers,
      mcpCatalog,
      capabilityDiagnostics: buildCapabilityDiagnostics(capabilities, mcpServers, mcpCatalog, capabilityManifest),
      webSearch: getWebSearchSettings(),
      agentSettings: {
        contextBudget: getAgentContextBudget().mode,
        maxRepairAttempts: getAgentMaxRepairAttempts(),
        maxToolRounds: getAgentMaxToolRounds()
      },
      approvals: this.approvals.getSnapshot(this.session.id),
      pendingApprovals: this.pendingApprovals,
      busy: Boolean(this.busyLabel ?? this.runningTasks.get(this.session.id)),
      busyLabel: this.busyLabel ?? this.runningTasks.get(this.session.id)?.label
    });
  }

  private getCapabilities(): AgentCapabilityState {
    return getAgentCapabilities(this.mcpClient.getDiscoveredToolCapabilities());
  }

  public async refreshFromStorage(): Promise<void> {
    if (!this.busyLabel) {
      const latest = this.sessions.getSession(this.session.id);
      if (latest) {
        this.session = latest;
        this.transcript = [...latest.messages];
        if (latest.taskState && !this.runningTasks.has(this.session.id)) {
          await this.markStaleTask(latest.taskState);
        }
      }
    }
    await this.refreshWorkspaceFiles();
    this.postState();
  }

  public async sendPrompt(prompt: string): Promise<void> {
    await this.handleChat(prompt, "chat");
  }

  private async handleMessage(message: WebviewMessage): Promise<void> {
    try {
      if (message.type === "ready") {
        await this.refreshWorkspaceFiles();
        this.postState();
        return;
      }

      if (message.type === "clearTranscript") {
        this.transcript.splice(0, this.transcript.length);
        await this.persistTranscript();
        this.postState();
        return;
      }

      if (message.type === "stopGeneration") {
        const runningTask = this.runningTasks.get(this.session.id);
        (this.activeAbortController ?? runningTask?.controller)?.abort();
        this.activeAbortController = undefined;
        this.busyLabel = undefined;
        this.runningTasks.delete(this.session.id);
        await this.sessions.updateTaskState(this.session.id, undefined);
        await this.failProgressMessage("已手动停止。");
        this.postState();
        return;
      }

      if (message.type === "copyMessage" && typeof message.messageIndex === "number") {
        const item = this.transcript[message.messageIndex];
        if (item) {
          await vscode.env.clipboard.writeText(item.content);
          vscode.window.showInformationMessage("消息已复制。");
        }
        return;
      }

      if (message.type === "copyText" && typeof message.text === "string") {
        await vscode.env.clipboard.writeText(message.text);
        vscode.window.showInformationMessage("已复制。");
        return;
      }

      if (message.type === "openUrl" && typeof message.text === "string") {
        await vscode.env.openExternal(vscode.Uri.parse(message.text));
        return;
      }

      if (message.type === "fetchUrl" && typeof message.text === "string") {
        await this.handleWebFetch(message.text);
        return;
      }

      if (message.type === "insertText" && typeof message.text === "string") {
        const approved = await this.approvals.ensureToolApproval({
          sessionId: this.session.id,
          toolId: "editor-insert",
          label: "插入编辑器",
          reason: "把代码块内容插入当前编辑器"
        });
        if (approved !== "approved") {
          this.postState();
          return;
        }
        await insertTextIntoActiveEditor(message.text);
        vscode.window.showInformationMessage("内容已插入到当前代码光标。");
        this.postState();
        return;
      }

      if (message.type === "resendMessage" && typeof message.messageIndex === "number") {
        const item = this.transcript[message.messageIndex];
        if (item?.role === "user") {
          this.transcript.splice(message.messageIndex);
          const mode = normalizeMode(item.mode);
          if (mode === "agent") {
            await this.handleAgentPatch(item.content, { skillIds: item.skillIds, toolIds: item.toolIds });
          } else {
            await this.handleChat(item.content, mode, { skillIds: item.skillIds, toolIds: item.toolIds });
          }
        }
        return;
      }

      if (message.type === "editMessage" && typeof message.messageIndex === "number" && typeof message.text === "string") {
        const item = this.transcript[message.messageIndex];
        if (item?.role === "user") {
          this.transcript.splice(message.messageIndex);
          const mode = normalizeMode(item.mode ?? message.mode);
          if (mode === "agent") {
            await this.handleAgentPatch(message.text.trim(), { skillIds: item.skillIds, toolIds: item.toolIds });
          } else {
            await this.handleChat(message.text.trim(), mode, { skillIds: item.skillIds, toolIds: item.toolIds });
          }
        }
        return;
      }

      if (message.type === "showHelp") {
        await this.appendAssistant(buildHelpText(), "local");
        return;
      }

      if (message.type === "runVerify" || message.type === "runSessionVerify") {
        await this.handleSessionVerify(false);
        return;
      }

      if (message.type === "verifyAndFix") {
        await this.handleSessionVerify(true);
        return;
      }

      if (message.type === "explainInline") {
        await this.explainSelectionInline();
        return;
      }

      if (message.type === "resolveApproval" && message.approvalId && message.approvalDecision) {
        this.resolvePageApproval(message.approvalId, message.approvalDecision);
        return;
      }

      if (message.type === "sendChat" && message.text) {
        const mode = normalizeMode(message.mode);
        const capabilityIds = {
          skillIds: sanitizeIds(message.skillIds),
          toolIds: sanitizeIds(message.toolIds)
        };
        if (mode === "agent") {
          await this.handleAgentPatch(message.text, capabilityIds);
        } else {
          await this.handleChat(message.text, mode, capabilityIds);
        }
        return;
      }

      if (message.type === "switchModel" && message.providerId && message.modelId) {
        await setActiveModel(message.providerId, message.modelId);
        this.postState();
        this.onStateChange();
        this.postState();
        return;
      }

      if (message.type === "setApiKey") {
        await this.handleApiKeyCommand();
        return;
      }

      if (message.type === "configureCustomProvider") {
        await vscode.commands.executeCommand("codeAgent.configureCustomProvider");
        this.postState();
        this.onStateChange();
        return;
      }

      if (message.type === "createCapabilityTemplates") {
        await vscode.commands.executeCommand("codeAgent.createCapabilityTemplates");
        this.postState();
        this.onStateChange();
        return;
      }

      if (message.type === "createSkillFromTemplate") {
        await this.handleCreateSkillFromTemplate(message.skillName, message.skillDescription, message.skillRuntime);
        return;
      }

      if (message.type === "configureWebSearch") {
        await vscode.commands.executeCommand("codeAgent.configureWebSearch");
        this.postState();
        this.onStateChange();
        return;
      }

      if (message.type === "openSettings") {
        await vscode.commands.executeCommand("workbench.action.openSettings", "@ext:local-dev.patchlane");
        return;
      }

      if (message.type === "openSettingsTarget") {
        await vscode.commands.executeCommand("workbench.action.openSettings", normalizeSettingsTarget(message.settingKey));
        return;
      }

      if (message.type === "runWebSearch") {
        await this.handleWebSearch(message.query ?? message.text ?? "", message.sourceHint);
        return;
      }

      if (message.type === "discoverMcpTools") {
        await this.handleDiscoverMcpTools();
        return;
      }

      if (message.type === "restartMcpServer" && message.serverName) {
        await this.handleRestartMcpServer(message.serverName);
        return;
      }

      if (message.type === "stopMcpServer" && message.serverName) {
        await this.handleStopMcpServer(message.serverName);
        return;
      }

      if (message.type === "clearMcpLogs" && message.serverName) {
        this.mcpClient.clearServerLogs(message.serverName);
        this.postState();
        this.onStateChange();
        return;
      }

      if (message.type === "readMcpResource" && message.serverName && message.resourceUri) {
        await this.handleReadMcpResource(message.serverName, message.resourceUri);
        return;
      }

      if (message.type === "useMcpPrompt" && message.serverName && message.promptName) {
        await this.handleUseMcpPrompt(message.serverName, message.promptName, message.promptArguments ?? message.text);
        return;
      }

      if (message.type === "runCapability" && message.capabilityId && message.capabilityType) {
        const capability = this.findCapability(message.capabilityType, message.capabilityId);
        if (!capability) {
          await this.appendAssistant(`找不到可运行能力：${message.capabilityId}`, "local");
          return;
        }

        if (message.capabilityType === "tool" && capability.id === "web-search") {
          await this.handleWebSearch(message.text ?? "");
          return;
        }

        this.beginProgressMessage(`正在运行 ${capability.label}`, [
          { label: `请求 ${capability.label} 授权`, kind: message.capabilityType === "skill" ? "approval" : "tool" },
          { label: "等待命令审批", kind: "approval" },
          { label: `执行 ${capability.label}`, kind: message.capabilityType === "skill" ? "tool" : capability.kind === "mcp" ? "tool" : "tool" },
          { label: "整理执行结果", kind: "verify" }
        ]);
        this.updateProgressMessage(`请求 ${capability.label} 授权`, "等待页面审批", message.capabilityType === "skill" ? "approval" : "tool");
        const abortController = new AbortController();
        await this.beginRunningTask("capability", `正在运行 ${capability.label}`, abortController);
        try {
          await this.runLocalTask(`正在运行 ${capability.label}`, async () => {
            const result = await this.runCapabilityWithHistory(message.capabilityType!, capability, message.text, "settings", abortController.signal);
            if (!result) {
              await this.failProgressMessage("用户拒绝授权或命令未执行。");
              this.postState();
              return;
            }
            this.appendProgressEvent(`执行 ${capability.label}`, "done", result.command, "tool");
            this.appendProgressEvent("整理执行结果", result.exitCode === 0 ? "done" : "error", `exit ${result.exitCode ?? "error"}`, "verify");
            await this.completeProgressMessage(`${capability.label} 执行完成`, result.command);
            await this.appendAssistant(formatCapabilityRunResult(result), "local");
          });
        } finally {
          await this.clearRunningTask(abortController);
          this.postState();
        }
        return;
      }

      if (message.type === "generatePatch" && message.text) {
        await this.handleAgentPatch(message.text, {
          skillIds: sanitizeIds(message.skillIds),
          toolIds: sanitizeIds(message.toolIds)
        });
        return;
      }

      if (message.type === "previewPatch") {
        const approved = await this.approvals.ensureToolApproval({
          sessionId: this.session.id,
          toolId: "files",
          label: "文件读写",
          reason: "打开待确认修改的完整 diff 预览"
        });
        if (approved !== "approved") {
          this.postState();
          return;
        }
        this.postState();
        await this.previewPendingPatch();
        return;
      }

      if (message.type === "applyPatch") {
        const approved = await this.approvals.ensureToolApproval({
          sessionId: this.session.id,
          toolId: "files",
          label: "文件读写",
          reason: "把已确认的修改写入工作区文件"
        });
        if (approved !== "approved") {
          this.postState();
          return;
        }
        this.beginProgressMessage("正在应用修改", [
          { label: "确认文件写入授权", kind: "approval" },
          { label: "写入工作区文件", kind: "file" },
          { label: "整理应用结果", kind: "patch" }
        ]);
        this.appendProgressEvent("确认文件写入授权", "done", "本会话已允许写入工作区文件", "approval");
        const applyAbortController = new AbortController();
        await this.beginRunningTask("apply", "正在应用修改", applyAbortController);
        try {
          await this.runLocalTask("正在应用修改", async () => {
            const result = await this.patchWorkflow.applyPendingPatch({
              requireConfirmation: false,
              signal: applyAbortController.signal
            });
            if (result.status === "applied") {
              this.appendProgressEvent("写入工作区文件", "done", `${result.appliedFiles ?? 0} 个文件`, "file");
              await this.completeProgressMessage("修改已应用", `${result.appliedFiles ?? 0} 个文件`);
              await this.appendAssistant(`修改已应用到 ${result.appliedFiles ?? 0} 个文件。`, "local");
              await this.runPostApplyVerificationIfConfigured(applyAbortController.signal, result.appliedDraft);
            } else if (result.status === "repaired" && result.repairedDraft) {
              this.appendProgressEvent("整理应用结果", "error", result.error, "patch");
              await this.failProgressMessage("应用失败，已生成修复草稿。");
              await this.appendAssistant([
                "修改应用失败，已自动生成一份修复后的草稿，请重新确认。",
                "",
                `错误信息：${result.error}`,
                "",
                `修复草稿包含 ${result.repairedDraft.fileCount} 个文件：`,
                result.repairedDraft.files.join("\n")
              ].join("\n"), "local");
            } else {
              await this.failProgressMessage("已取消应用修改。");
            }
          });
        } finally {
          await this.clearRunningTask(applyAbortController);
          this.postState();
        }
        return;
      }

      if (message.type === "rollbackPatch") {
        const approved = await this.approvals.ensureToolApproval({
          sessionId: this.session.id,
          toolId: "files",
          label: "文件读写",
          reason: "撤回上一次由 Patchlane 应用的文件修改"
        });
        if (approved !== "approved") {
          this.postState();
          return;
        }
        this.beginProgressMessage("正在撤回修改", [
          { label: "确认撤回授权", kind: "approval" },
          { label: "恢复备份文件", kind: "file" }
        ]);
        this.appendProgressEvent("确认撤回授权", "done", "本会话已允许撤回修改", "approval");
        await this.runLocalTask("正在撤回修改", async () => {
          await this.patchWorkflow.rollbackLastPatch();
          await this.completeProgressMessage("已撤回上一次修改", "工作区已恢复到应用前状态");
          await this.appendAssistant("已恢复到上一次应用修改前的状态。", "local");
        });
        return;
      }

      if (message.type === "discardPatch") {
        this.patchWorkflow.discardPendingPatch();
        await this.appendAssistant("已放弃当前待确认的修改。", "local");
        this.postState();
        return;
      }

      if (message.type === "listWorkspaceFiles") {
        await this.refreshWorkspaceFiles();
        this.postState();
        return;
      }

      if (message.type === "openWorkspaceFile" && message.path) {
        await openWorkspaceFile(message.path);
        return;
      }

      if (message.type === "readWorkspaceFile" && message.path) {
        const approved = await this.approvals.ensureToolApproval({
          sessionId: this.session.id,
          toolId: "files",
          label: "文件读写",
          reason: `读取 ${message.path}`
        });
        if (approved !== "approved") {
          this.postState();
          return;
        }
        this.beginProgressMessage("正在读取文件", [
          { label: "确认文件读取授权", kind: "approval" },
          { label: `读取 ${message.path}`, kind: "file" }
        ]);
        this.appendProgressEvent("确认文件读取授权", "done", "本会话已允许读取工作区文件", "approval");
        const file = await readWorkspaceFile(message.path);
        await this.completeProgressMessage("文件读取完成", file.path);
        await this.appendAssistant([
          `工作区文件：${file.path}`,
          "",
          `\`\`\`${file.languageId}`,
          file.content,
          "```"
        ].join("\n"), "local");
        return;
      }

      const command = COMMAND_MESSAGES[message.type];
      if (command) {
        const approved = await this.approvals.ensureCommandApproval({
          sessionId: this.session.id,
          toolId: "vscode-command",
          label: "VS Code 命令",
          command,
          reason: "从 Patchlane 会话执行内置命令"
        });
        if (approved !== "approved") {
          this.postState();
          return;
        }
        this.postState();
        await this.runLocalTask("正在执行命令", async () => {
          await vscode.commands.executeCommand(command);
        });
      }
    } catch (error) {
      this.busyLabel = undefined;
      this.activeAbortController = undefined;
      await this.clearSessionTaskState();
      if (error instanceof Error && error.name === "AbortError") {
        await this.failProgressMessage("已手动停止。");
        await this.appendAssistant("已停止当前 Agent 任务。", "local");
        return;
      }
      const message = formatUserFacingError(error);
      await this.failProgressMessage(message);
      await this.appendAssistant(`任务失败：${message}`, "local");
    }
  }

  private async handleApiKeyCommand(): Promise<void> {
    const providerId = getActiveModel().providerId;
    if (providerId === "deepseek") {
      await vscode.commands.executeCommand("codeAgent.setApiKey");
    } else if (providerId === "custom") {
      await vscode.commands.executeCommand("codeAgent.configureCustomProvider");
    } else if (providerId !== "ollama" && providerId !== "lmStudio") {
      await vscode.commands.executeCommand("codeAgent.setActiveProviderApiKey");
    } else {
      vscode.window.showInformationMessage(`${providerId} 默认不需要 API Key。`);
    }
    this.postState();
  }

  private async handleCreateSkillFromTemplate(name?: string, description?: string, runtime: "node" | "python" | "shell" = "node"): Promise<void> {
    const label = name?.trim();
    if (!label) {
      await this.appendAssistant("请先填写 Skill 名称。", "local");
      return;
    }

    const workspace = vscode.workspace.workspaceFolders?.[0];
    if (!workspace) {
      await this.appendAssistant("请先打开一个工作区文件夹，再创建 Skill。", "local");
      return;
    }

    const skillId = await createUniqueSkillId(workspace.uri, label);
    const skillRuntime = normalizeSkillRuntime(runtime);
    const scriptPath = `.patchlane/skills/${skillId}/index.${skillExtension(skillRuntime)}`;
    const approved = await this.approvals.ensureToolApproval({
      sessionId: this.session.id,
      toolId: "skill-create",
      label: "创建 Skill",
      reason: `写入 ${scriptPath} 并更新当前工作区的 codeAgent.customSkills。`
    });
    if (approved !== "approved") {
      this.postState();
      return;
    }

    const commandApproved = await this.approvals.ensureCommandApproval({
      sessionId: this.session.id,
      toolId: "skill-create",
      label: "创建 Skill",
      command: `patchlane://skill/create/${skillId}`,
      cwd: workspace.uri.fsPath,
      reason: "在工作区生成 Skill 脚本模板和设置项。"
    });
    if (commandApproved !== "approved") {
      this.postState();
      return;
    }

    this.beginProgressMessage("正在创建 Skill", [
      { label: "确认工作区写入授权", kind: "approval" },
      { label: "写入 Skill 脚本", kind: "file" },
      { label: "更新 Skill 设置", kind: "file" }
    ]);
    this.appendProgressEvent("确认工作区写入授权", "done", scriptPath, "approval");
    const abortController = new AbortController();
    await this.beginRunningTask("capability", "正在创建 Skill", abortController);

    try {
      await this.runLocalTask("正在创建 Skill", async () => {
        assertNotAborted(abortController.signal);
        const scriptUri = workspaceRelativeUri(workspace.uri, scriptPath);
        await vscode.workspace.fs.createDirectory(parentUri(scriptUri));
        await vscode.workspace.fs.writeFile(scriptUri, new TextEncoder().encode(buildSkillTemplate(label, description?.trim(), skillRuntime)));
        this.appendProgressEvent("写入 Skill 脚本", "done", scriptPath, "file");

        const config = vscode.workspace.getConfiguration("codeAgent", workspace.uri);
        const current = config.get<AgentCapabilityConfig[]>("customSkills", []);
        const next = [
          ...current.filter((item) => item.id !== skillId),
          {
            id: skillId,
            label,
            description: description?.trim() || "自定义 Patchlane Skill。",
            kind: "custom" as const,
            runtime: skillRuntime,
            script: scriptPath
          }
        ];
        await config.update("customSkills", next, vscode.ConfigurationTarget.Workspace);
        this.appendProgressEvent("更新 Skill 设置", "done", "codeAgent.customSkills", "file");
        await this.completeProgressMessage("Skill 已创建", scriptPath);
        await this.appendAssistant([
          `Skill 已创建：${label}`,
          "",
          `- ID：\`${skillId}\``,
          `- 脚本：\`${scriptPath}\``,
          "- 位置：当前工作区 `.patchlane/skills`",
          "",
          "你可以在输入框底部的 Skill 菜单里选择它。执行前仍会在页面内请求审批。"
        ].join("\n"), "local");
      });
    } finally {
      await this.clearRunningTask(abortController);
      this.postState();
      this.onStateChange();
    }
  }

  private async handleDiscoverMcpTools(): Promise<void> {
    const approved = await this.approvals.ensureToolApproval({
      sessionId: this.session.id,
      toolId: "mcp-discovery",
      label: "MCP 能力发现",
      reason: "启动已配置的 MCP 服务并读取工具、资源和 Prompt 清单。"
    });
    if (approved !== "approved") {
      this.postState();
      return;
    }

    const commandApproved = await this.approvals.ensureCommandApproval({
      sessionId: this.session.id,
      toolId: "mcp-discovery",
      label: "MCP 能力发现",
      command: "mcp://discover",
      reason: "调用已配置 MCP 服务的 list 接口。"
    });
    if (commandApproved !== "approved") {
      this.postState();
      return;
    }

    this.beginProgressMessage("正在发现 MCP 工具", [
      { label: "启动 MCP 服务", kind: "tool" },
      { label: "读取工具清单", kind: "tool" },
      { label: "读取资源和 Prompt", kind: "tool" },
      { label: "更新工具选择器", kind: "think" }
    ]);
    const abortController = new AbortController();
    await this.beginRunningTask("capability", "正在发现 MCP 工具", abortController);

    try {
      await this.runLocalTask("正在发现 MCP 工具", async () => {
        this.appendProgressEvent("启动 MCP 服务", "running", "按 settings.json 中的 codeAgent.mcp.servers 启动", "tool");
        const discovered = await this.mcpClient.discoverCatalog();
        const totals = summarizeMcpCatalog(Object.values(discovered));
        this.appendProgressEvent("启动 MCP 服务", "done", `${Object.keys(discovered).length} 个服务`, "tool");
        this.appendProgressEvent("读取工具清单", "done", `${totals.tools} 个工具`, "tool");
        this.appendProgressEvent("读取资源和 Prompt", "done", `${totals.resources} 个资源，${totals.prompts} 个 Prompt`, "tool");
        this.appendProgressEvent("更新工具选择器", "done", "发现结果已合并到 MCP 选择器和设置页目录", "think");
        await this.completeProgressMessage("MCP 能力发现完成", `${totals.tools} 个工具，${totals.resources} 个资源，${totals.prompts} 个 Prompt`);
        await this.appendAssistant(formatMcpDiscoveryResult(discovered), "local");
      });
    } finally {
      await this.clearRunningTask(abortController);
      this.postState();
      this.onStateChange();
    }
  }

  private async handleRestartMcpServer(serverName: string): Promise<void> {
    const approved = await this.approvals.ensureToolApproval({
      sessionId: this.session.id,
      toolId: `mcp-admin:${serverName}`,
      label: `MCP 服务管理：${serverName}`,
      reason: "重连 MCP 服务并刷新工具、资源和 Prompt 清单。"
    });
    if (approved !== "approved") {
      this.postState();
      return;
    }

    const commandApproved = await this.approvals.ensureCommandApproval({
      sessionId: this.session.id,
      toolId: `mcp-admin:${serverName}`,
      label: `重连 MCP：${serverName}`,
      command: `mcp://${serverName}/restart`,
      reason: "停止当前 MCP 连接后重新启动服务。"
    });
    if (commandApproved !== "approved") {
      this.postState();
      return;
    }

    this.beginProgressMessage(`正在重连 MCP：${serverName}`, [
      { label: "确认服务管理授权", kind: "approval" },
      { label: "重启 MCP 服务", kind: "tool" },
      { label: "刷新 MCP 能力", kind: "tool" }
    ]);
    this.appendProgressEvent("确认服务管理授权", "done", "已允许本次 MCP 服务重连", "approval");
    const abortController = new AbortController();
    await this.beginRunningTask("capability", `正在重连 MCP：${serverName}`, abortController);

    try {
      await this.runLocalTask(`正在重连 MCP：${serverName}`, async () => {
        this.appendProgressEvent("重启 MCP 服务", "running", serverName, "tool");
        await this.mcpClient.restartServer(serverName);
        this.appendProgressEvent("重启 MCP 服务", "done", serverName, "tool");
        this.appendProgressEvent("刷新 MCP 能力", "running", "读取 tools/list、resources/list 和 prompts/list", "tool");
        const discovered = await this.mcpClient.discoverCatalog(serverName);
        const totals = summarizeMcpCatalog(Object.values(discovered));
        this.appendProgressEvent("刷新 MCP 能力", "done", `${totals.tools} 个工具，${totals.resources} 个资源，${totals.prompts} 个 Prompt`, "tool");
        await this.completeProgressMessage(`MCP 已重连：${serverName}`, `${totals.tools} 个工具，${totals.resources} 个资源，${totals.prompts} 个 Prompt`);
        await this.appendAssistant(formatMcpDiscoveryResult(discovered), "local");
      });
    } finally {
      await this.clearRunningTask(abortController);
      this.postState();
      this.onStateChange();
    }
  }

  private async handleStopMcpServer(serverName: string): Promise<void> {
    const approved = await this.approvals.ensureToolApproval({
      sessionId: this.session.id,
      toolId: `mcp-admin:${serverName}`,
      label: `MCP 服务管理：${serverName}`,
      reason: "停止 MCP 服务连接。"
    });
    if (approved !== "approved") {
      this.postState();
      return;
    }

    const commandApproved = await this.approvals.ensureCommandApproval({
      sessionId: this.session.id,
      toolId: `mcp-admin:${serverName}`,
      label: `停止 MCP：${serverName}`,
      command: `mcp://${serverName}/stop`,
      reason: "停止当前 MCP 服务进程或断开 HTTP MCP 连接。"
    });
    if (commandApproved !== "approved") {
      this.postState();
      return;
    }

    this.beginProgressMessage(`正在停止 MCP：${serverName}`, [
      { label: "确认服务管理授权", kind: "approval" },
      { label: "停止 MCP 服务", kind: "tool" }
    ]);
    this.appendProgressEvent("确认服务管理授权", "done", "已允许本次 MCP 服务停止", "approval");
    const abortController = new AbortController();
    await this.beginRunningTask("capability", `正在停止 MCP：${serverName}`, abortController);

    try {
      await this.runLocalTask(`正在停止 MCP：${serverName}`, async () => {
        this.mcpClient.stopServer(serverName);
        this.appendProgressEvent("停止 MCP 服务", "done", serverName, "tool");
        await this.completeProgressMessage(`MCP 已停止：${serverName}`, "可以在设置页重新连接。");
        await this.appendAssistant(`MCP 服务已停止：${serverName}`, "local");
      });
    } finally {
      await this.clearRunningTask(abortController);
      this.postState();
      this.onStateChange();
    }
  }

  private async handleReadMcpResource(serverName: string, resourceUri: string): Promise<void> {
    const approved = await this.approvals.ensureToolApproval({
      sessionId: this.session.id,
      toolId: `mcp-resource:${serverName}:${resourceUri}`,
      label: `MCP 资源：${serverName}`,
      reason: `读取 MCP 资源 ${resourceUri}`
    });
    if (approved !== "approved") {
      this.postState();
      return;
    }

    const commandText = `mcp://${serverName}/resources/read?uri=${encodeURIComponent(resourceUri)}`;
    const commandApproved = await this.approvals.ensureCommandApproval({
      sessionId: this.session.id,
      toolId: `mcp-resource:${serverName}`,
      label: `读取 MCP 资源：${serverName}`,
      command: commandText,
      reason: "读取 MCP Resource 内容并加入当前会话上下文。"
    });
    if (commandApproved !== "approved") {
      this.postState();
      return;
    }

    const abortController = new AbortController();
    await this.beginRunningTask("capability", `正在读取 MCP 资源 ${serverName}`, abortController);
    try {
      await this.runLocalTask("正在读取 MCP 资源", async () => {
        const result = await this.mcpClient.readResource(serverName, resourceUri, { signal: abortController.signal });
        await this.appendAssistant(formatMcpResourceResult(result.server, result.uri, result.content), "local");
      });
    } finally {
      await this.clearRunningTask(abortController);
      this.postState();
    }
  }

  private async handleUseMcpPrompt(serverName: string, promptName: string, input?: string | Record<string, string>): Promise<void> {
    const approved = await this.approvals.ensureToolApproval({
      sessionId: this.session.id,
      toolId: `mcp-prompt:${serverName}:${promptName}`,
      label: `MCP Prompt：${serverName}`,
      reason: `获取 MCP Prompt ${promptName}`
    });
    if (approved !== "approved") {
      this.postState();
      return;
    }

    const commandText = `mcp://${serverName}/prompts/get?name=${encodeURIComponent(promptName)}`;
    const commandApproved = await this.approvals.ensureCommandApproval({
      sessionId: this.session.id,
      toolId: `mcp-prompt:${serverName}`,
      label: `获取 MCP Prompt：${serverName}`,
      command: commandText,
      reason: "获取 MCP Prompt 内容并加入当前会话上下文。"
    });
    if (commandApproved !== "approved") {
      this.postState();
      return;
    }

    const abortController = new AbortController();
    await this.beginRunningTask("capability", `正在获取 MCP Prompt ${promptName}`, abortController);
    try {
      await this.runLocalTask("正在获取 MCP Prompt", async () => {
        const result = await this.mcpClient.getPrompt(serverName, promptName, input, { signal: abortController.signal });
        await this.appendAssistant(formatMcpPromptResult(result.server, result.prompt, result.content), "local");
      });
    } finally {
      await this.clearRunningTask(abortController);
      this.postState();
    }
  }

  private async handleWebSearch(query: string, sourceHint?: "general" | "docs" | "news" | "github"): Promise<WebSearchResponse | undefined> {
    const trimmed = query.trim();
    if (!trimmed) {
      await this.appendAssistant("请输入要搜索的关键词。", "local");
      return undefined;
    }
    if (!this.webSearch.isEnabled()) {
      await this.appendAssistant("联网搜索尚未启用。请到设置页打开联网搜索并配置搜索服务。", "local");
      return undefined;
    }

    const provider = getWebSearchProvider();
    const resolvedSourceHint = sourceHint ?? inferSearchSourceHint(trimmed);
    if (doesWebSearchRequireApproval()) {
      const approved = await this.approvals.ensureWebSearchApproval({
        sessionId: this.session.id,
        toolId: "web-search",
        label: "联网搜索",
        query: trimmed,
        provider,
        allowDomains: getWebSearchAllowedDomains(),
        reason: "搜索公开网页资料，可能会把查询词发送给搜索服务。"
      });
      if (approved !== "approved") {
        this.postState();
        return undefined;
      }
    }

    this.beginProgressMessage("正在联网搜索", [
      { label: "请求联网搜索授权", kind: "approval" },
      { label: "发送搜索请求", kind: "tool" },
      { label: "整理搜索结果", kind: "think" }
    ]);
    this.appendProgressEvent("请求联网搜索授权", "done", `${provider} · ${trimmed}`, "approval");

    let response: WebSearchResponse | undefined;
    const abortController = new AbortController();
    await this.beginRunningTask("web", "正在联网搜索", abortController);
    try {
      await this.runLocalTask("正在联网搜索", async () => {
        response = await this.webSearch.search({
          sessionId: this.session.id,
          query: trimmed,
          sourceHint: resolvedSourceHint
        }, {
          signal: abortController.signal,
          onStatus: (status) => this.appendProgressEvent("发送搜索请求", "running", status, "tool")
        });
        this.appendProgressEvent("发送搜索请求", "done", `${response.results.length} 条结果`, "tool");
        this.appendProgressEvent("整理搜索结果", "done", "已加入当前会话上下文", "think");
        await this.completeProgressMessage("联网搜索完成", response.results.map((item) => item.source ?? item.url).join("、"));
        await this.appendWebSearchResult(response);
      });
    } catch (error) {
      if (isAbortError(error)) {
        throw error;
      }
      const message = formatWebSearchError(error, provider);
      this.appendProgressEvent("发送搜索请求", "error", message, "tool");
      await this.failProgressMessage(`联网搜索失败：${message}`);
      await this.appendAssistant(`联网搜索失败：${message}`, "local");
      return undefined;
    } finally {
      await this.clearRunningTask(abortController);
    }
    return response;
  }

  private async appendWebSearchResult(response: WebSearchResponse): Promise<void> {
    const lines = [
      `联网搜索：${response.query}`,
      `来源：${response.provider}`,
      `倾向：${searchSourceHintLabel(response.sourceHint)}`,
      `时间：${formatLocalTime(response.fetchedAt)}`,
      "",
      ...response.results.flatMap((item, index) => [
        `${index + 1}. ${item.title}`,
        `URL: ${item.url}`,
        item.source ? `来源站点：${item.source}` : "",
        item.updatedAt ? `更新时间：${item.updatedAt}` : item.publishedAt ? `发布时间：${item.publishedAt}` : "",
        item.snippet ? `摘要：${item.snippet}` : "",
        ""
      ])
    ].filter(Boolean);

    await this.appendTranscriptItem({
      role: "assistant",
      content: lines.join("\n"),
      model: response.provider,
      createdAt: new Date().toISOString(),
      kind: "webSearch",
      title: "联网搜索结果",
      sources: response.results.map((item) => ({
        title: item.title,
        url: item.url,
        snippet: item.snippet,
        source: item.source
      }))
    });
  }

  private async handleWebFetch(url: string): Promise<void> {
    const trimmed = url.trim();
    if (!trimmed) {
      await this.appendAssistant("请输入要读取的网页地址。", "local");
      return;
    }
    if (!this.webSearch.isEnabled()) {
      await this.appendAssistant("联网搜索尚未启用，无法读取网页正文。请先配置联网搜索。", "local");
      return;
    }

    const provider = getWebSearchProvider();
    if (doesWebSearchRequireApproval()) {
      const approved = await this.approvals.ensureWebSearchApproval({
        sessionId: this.session.id,
        toolId: "web-fetch",
        label: "读取网页",
        query: trimmed,
        provider,
        allowDomains: getWebSearchAllowedDomains(),
        reason: "读取公开网页正文，并把摘要加入当前会话上下文。"
      });
      if (approved !== "approved") {
        this.postState();
        return;
      }
    }

    const abortController = new AbortController();
    await this.beginRunningTask("web", "正在读取网页", abortController);
    this.beginProgressMessage("正在读取网页", [
      { label: "确认联网读取授权", kind: "approval" },
      { label: "读取网页正文", kind: "tool" },
      { label: "整理网页内容", kind: "think" }
    ]);
    this.appendProgressEvent("确认联网读取授权", "done", trimmed, "approval");

    try {
      await this.runLocalTask("正在读取网页", async () => {
        this.appendProgressEvent("读取网页正文", "running", trimmed, "tool");
        const page = await this.webSearch.fetch(trimmed, { signal: abortController.signal });
        this.appendProgressEvent("读取网页正文", "done", page.source ?? page.url, "tool");
        this.appendProgressEvent("整理网页内容", "done", "已加入当前会话上下文", "think");
        await this.completeProgressMessage("网页读取完成", page.title ?? page.url);
        await this.appendTranscriptItem({
          role: "assistant",
          content: [
            `读取网页：${page.title ?? page.url}`,
            `URL: ${page.url}`,
            `来源：${page.source ?? "未知"}`,
            `时间：${formatLocalTime(page.fetchedAt)}`,
            "",
            "正文摘录：",
            "",
            compactHistoryText(page.content, getAgentContextBudget().webPageChars)
          ].join("\n"),
          model: provider,
          createdAt: new Date().toISOString(),
          kind: "webSearch",
          title: "网页正文",
          sources: [{
            title: page.title ?? page.url,
            url: page.url,
            snippet: compactHistoryText(page.content, Math.min(360, getAgentContextBudget().webSnippetChars)),
            source: page.source
          }]
        });
      });
    } catch (error) {
      if (isAbortError(error)) {
        throw error;
      }
      const message = formatWebSearchError(error, provider);
      this.appendProgressEvent("读取网页正文", "error", message, "tool");
      await this.failProgressMessage(`网页读取失败：${message}`);
      await this.appendAssistant(`网页读取失败：${message}`, "local");
    } finally {
      await this.clearRunningTask(abortController);
      this.postState();
    }
  }

  private async trySearchForAgent(prompt: string, capabilityContext: CapabilityContext, signal: AbortSignal): Promise<string | undefined> {
    if (!shouldAgentUseWebSearch(prompt, capabilityContext) || !this.webSearch.isEnabled()) {
      this.appendProgressEvent("联网搜索资料", "done", "未启用或当前任务不需要联网资料", "tool");
      return undefined;
    }

    const query = buildAgentSearchQuery(prompt);
    const provider = getWebSearchProvider();
    if (doesWebSearchRequireApproval()) {
      const approved = await this.approvals.ensureWebSearchApproval({
        sessionId: this.session.id,
        toolId: "web-search",
        label: "联网搜索",
        query,
        provider,
        allowDomains: getWebSearchAllowedDomains(),
        reason: "Agent 需要检索最新公开资料后再生成修改。"
      });
      if (approved !== "approved") {
        this.appendProgressEvent("联网搜索资料", "error", "用户拒绝联网搜索，继续使用本地上下文", "tool");
        return undefined;
      }
    }

    try {
      this.appendProgressEvent("联网搜索资料", "running", query, "tool");
      const sourceHint = inferSearchSourceHint(query);
      const response = await this.webSearch.search({
        sessionId: this.session.id,
        query,
        sourceHint
      }, {
        signal,
        onStatus: (status) => this.appendProgressEvent("联网搜索资料", "running", status, "tool")
      });
      this.appendProgressEvent("联网搜索资料", "done", `${response.results.length} 条结果`, "tool");
      await this.appendWebSearchResult(response);
      return formatWebSearchForPrompt(response);
    } catch (error) {
      if (isAbortError(error)) {
        throw error;
      }
      this.appendProgressEvent("联网搜索资料", "error", formatWebSearchError(error, provider), "tool");
      return undefined;
    }
  }

  private async runAgentWebSearch(query: string, signal: AbortSignal): Promise<WebSearchResponse | undefined> {
    const trimmed = query.trim();
    if (!trimmed) {
      return undefined;
    }
    if (!this.webSearch.isEnabled()) {
      this.appendProgressEvent("联网搜索资料", "done", "联网搜索未启用", "tool");
      return undefined;
    }

    const provider = getWebSearchProvider();
    if (doesWebSearchRequireApproval()) {
      const approved = await this.approvals.ensureWebSearchApproval({
        sessionId: this.session.id,
        toolId: "web-search",
        label: "联网搜索",
        query: trimmed,
        provider,
        allowDomains: getWebSearchAllowedDomains(),
        reason: "Agent 工具循环需要检索公开资料后再生成修改。"
      });
      if (approved !== "approved") {
        this.appendProgressEvent("联网搜索资料", "error", "用户拒绝联网搜索", "tool");
        return undefined;
      }
    }

    try {
      this.appendProgressEvent("联网搜索资料", "running", trimmed, "tool");
      const sourceHint = inferSearchSourceHint(trimmed);
      const response = await this.webSearch.search({
        sessionId: this.session.id,
        query: trimmed,
        sourceHint
      }, {
        signal,
        onStatus: (status) => this.appendProgressEvent("联网搜索资料", "running", status, "tool")
      });
      this.appendProgressEvent("联网搜索资料", "done", `${response.results.length} 条结果`, "tool");
      await this.appendWebSearchResult(response);
      return response;
    } catch (error) {
      if (isAbortError(error)) {
        throw error;
      }
      this.appendProgressEvent("联网搜索资料", "error", formatWebSearchError(error, provider), "tool");
      return undefined;
    }
  }

  private async explainSelectionInline(): Promise<void> {
    const target = getSelectedTextForAgent();
    this.busyLabel = "正在解释代码";
    this.postState();
    try {
      const activeModel = getModelForTask("chat");
      const response = await this.providers.get(activeModel.providerId).chat({
        model: activeModel.modelId,
        messages: [
          {
            role: "system",
            content: "Explain selected code clearly and practically. Mention purpose, key control flow, and notable risks. Reply in Chinese unless the user selected English code comments that should be preserved."
          },
          {
            role: "user",
            content: `${target.path ? `文件：${target.path}\n\n` : ""}请解释这段代码：\n\n\`\`\`\n${target.content}\n\`\`\``
          }
        ],
        temperature: getModelTemperature(),
        maxTokens: getModelMaxTokens(),
        topP: getModelTopP()
      });
      await this.appendTranscriptItem({
        role: "assistant",
        content: response.content,
        model: response.model,
        createdAt: new Date().toISOString(),
        kind: "codeExplanation",
        title: "代码解释",
        file: target.path,
        selection: target.selection
      });
    } finally {
      this.busyLabel = undefined;
      this.postState();
    }
  }

  private async handleSessionVerify(autoFix: boolean): Promise<void> {
    const commands = this.verifyService.getConfiguredCommands();
    if (commands.length === 0) {
      await this.appendAssistant("还没有配置验证命令。请在设置中配置 `codeAgent.verify.commands`，例如 `npm test`。", "local");
      return;
    }

    const approvedCommands = await this.approveVerifyCommands(commands, "运行验证", "在当前工作区运行配置好的验证命令，并把结果写入当前会话。");
    if (approvedCommands.length === 0) {
      return;
    }

    const abortController = new AbortController();
    await this.beginRunningTask("verify", autoFix ? "正在验证并修复" : "正在运行验证", abortController);
    this.beginProgressMessage(autoFix ? "正在验证并准备修复" : "正在运行验证", [
      { label: "确认验证套件授权", kind: "approval" },
      { label: "执行验证套件", kind: "verify" },
      { label: "整理验证输出", kind: "think" },
      ...(autoFix ? [{ label: "生成修复草稿", kind: "patch" as const }, { label: "等待你确认应用", kind: "approval" as const }] : [])
    ]);
    this.appendProgressEvent("确认验证套件授权", "done", `${approvedCommands.length} 条命令`, "approval");

    try {
      await this.runLocalTask(autoFix ? "正在验证并修复" : "正在运行验证", async () => {
        const suite = await this.verifyService.runSuite({
          commands: approvedCommands,
          signal: abortController.signal,
          stopOnFailure: true,
          onCommandStart: (command, index, total) => this.appendProgressEvent("执行验证套件", "running", `${index + 1}/${total} · ${command}`, "verify"),
          onCommandResult: (result, index, total) => this.appendProgressEvent(
            "执行验证套件",
            result.exitCode === 0 && !result.aborted ? "running" : "error",
            `${index + 1}/${total} · exit ${result.exitCode ?? "n/a"} · ${result.summary ?? result.command}`,
            "verify"
          )
        });
        this.appendProgressEvent(
          "执行验证套件",
          suite.passed ? "done" : "error",
          `${suite.results.length}/${suite.commands.length} 条 · ${verifyFailureKindLabel(suite.failureKind)} · ${formatDuration(suite.durationMs)}`,
          "verify"
        );
        this.appendProgressEvent("整理验证输出", "done", "结果已写入当前会话", "think");
        await this.appendAssistant(formatVerifySuiteResult(suite), "local");
        if (autoFix && !suite.aborted && !suite.passed) {
          const maxRepairAttempts = getAgentMaxRepairAttempts();
          if (maxRepairAttempts <= 0) {
            this.appendProgressEvent("生成修复草稿", "done", "已关闭自动修复草稿生成", "patch");
            await this.completeProgressMessage("验证未通过", "已记录验证输出，未生成修复草稿");
            return;
          }
          const draft = await this.generateVerifyRepairDraft(suite, abortController.signal, {
            round: 1,
            maxRounds: maxRepairAttempts,
            source: "manualVerify"
          });
          this.appendProgressEvent("等待你确认应用", "running", "请在修改结果页审查 diff 后手动应用", "approval");
          await this.completeProgressMessage(`已生成第 1/${maxRepairAttempts} 轮修复草稿`, draft.files.join("、"));
          await this.appendAssistant(formatPatchReadyMessage(draft), "local");
          return;
        }
        if (autoFix && suite.passed) {
          this.appendProgressEvent("生成修复草稿", "done", "验证已通过，无需修复", "patch");
        }
        await this.completeProgressMessage(suite.passed ? "验证通过" : "验证未通过", `${suite.results.length}/${suite.commands.length} 条命令`);
      });
    } finally {
      await this.clearRunningTask(abortController);
      this.postState();
    }
  }

  private async handleAgentPatch(prompt: string, capabilityIds: { skillIds?: string[]; toolIds?: string[] } = {}): Promise<void> {
    const capabilityContext = this.resolveCapabilityContext(capabilityIds.skillIds, capabilityIds.toolIds);
    this.transcript.push({
      role: "user",
      content: prompt.trim(),
      mode: "agent",
      skillIds: capabilityContext.skills.map((item) => item.id),
      toolIds: capabilityContext.tools.map((item) => item.id),
      createdAt: new Date().toISOString()
    });
    await this.persistTranscript();
    this.beginProgressMessage("正在生成修改", [
      { label: "等待文件读写授权", kind: "approval" },
      { label: "联网搜索资料", kind: "tool" },
      { label: "制定工具调用计划", kind: "think" },
      { label: "执行已选扩展能力", kind: "tool" },
      { label: "读取工作区上下文", kind: "file" },
      { label: "整理引用文件", kind: "file" },
      { label: "制定执行计划", kind: "think" },
      { label: "请求模型生成修改", kind: "model" },
      { label: "解析修改草稿", kind: "patch" },
      { label: "等待你确认应用", kind: "approval" }
    ]);

    const approved = await this.approvals.ensureToolApproval({
      sessionId: this.session.id,
      toolId: "files",
      label: "文件读写",
      reason: "生成可确认的工作区修改草稿"
    });
    if (approved !== "approved") {
      await this.failProgressMessage("用户拒绝文件读写授权。");
      return;
    }

    this.appendProgressEvent("等待文件读写授权", "done", "本会话已允许生成修改草稿", "approval");
    const abortController = new AbortController();
    await this.beginRunningTask("agent", "正在生成修改", abortController);

    try {
      await this.runLocalTask("正在生成修改", async () => {
        const agentMemory = buildAgentMemoryContext(prompt.trim(), this.transcript, getAgentContextBudget());
        if (agentMemory.planBlock) {
          this.appendProgressEvent("继承前文计划", "done", "已提取同一会话中的计划、步骤和验收标准", "think");
        } else if (agentMemory.shouldFollowPreviousPlan) {
          this.appendProgressEvent("继承前文计划", "error", "没有在前文找到可用计划，将按当前请求重新规划", "think");
        }
        const preparation = await this.agentOrchestrator.prepare({
          prompt: prompt.trim(),
          transcript: this.transcript,
          capabilityContext,
          signal: abortController.signal,
          onProgress: (label, status, detail, kind) => this.appendProgressEvent(label, status, detail, kind)
        });
        const toolLoop = await this.agentToolLoop.run({
          prompt: prompt.trim(),
          transcript: this.transcript,
          capabilityContext,
          baseContext: preparation.contextBlock,
          previousPlanContext: agentMemory.planBlock,
          signal: abortController.signal,
          onProgress: (label, status, detail, kind) => this.appendProgressEvent(label, status, detail, kind),
          runWebSearch: async (query) => {
            const response = await this.runAgentWebSearch(query, abortController.signal);
            return response ? formatWebSearchForPrompt(response) : undefined;
          },
          runCapability: async (capability, input) => {
            if (!isScriptCapability(capability) && !isMcpToolCapability(capability)) {
              return `能力 ${capability.label} 是内置能力开关，不是可直接执行的脚本或 MCP 工具。`;
            }
            const kind: "skill" | "tool" = capabilityContext.skills.some((item) => item.id === capability.id) ? "skill" : "tool";
            const result = await this.runCapabilityWithHistory(kind, capability, input, "agent", abortController.signal);
            return result ? formatCapabilityOutputForAgent(result) : undefined;
          },
          runVerify: async () => this.runVerifyForAgent(abortController.signal)
        });
        const agentRequest = buildAgentRequestWithHistory(
          prompt.trim(),
          this.transcript,
          capabilityContext,
          undefined,
          mergeToolContext(preparation.contextBlock, toolLoop.contextBlock),
          agentMemory
        );
        const draft = await this.patchWorkflow.generatePatch(agentRequest, {
          signal: abortController.signal,
          onProgress: (progress) => this.updateProgressMessage(progress.label, progress.detail, progressKindForStage(progress.stage)),
          onDraft: (draft, status, detail) => {
            this.appendProgressEvent(
              "实时生成修改",
              status === "failed" ? "error" : status === "stopped" ? "error" : status === "reviewing" || status === "repairing" ? "running" : "running",
              detail ?? `${draft.fileCount} 个文件`,
              "patch"
            );
            this.postState();
          }
        });
        await this.completeProgressMessage(`已生成 ${draft.fileCount} 个文件的修改草稿`, draft.files.join("、"));
        await this.appendAssistant(formatPatchReadyMessage(draft), "local");
      });
    } finally {
      await this.clearRunningTask(abortController);
      this.postState();
    }
  }

  private async handleChat(prompt: string, mode: ChatMode, capabilityIds: { skillIds?: string[]; toolIds?: string[] } = {}): Promise<void> {
    const activeModel = getActiveModel();
    const capabilityContext = this.resolveCapabilityContext(capabilityIds.skillIds, capabilityIds.toolIds);
    this.transcript.push({
      role: "user",
      content: prompt,
      mode,
      skillIds: capabilityContext.skills.map((item) => item.id),
      toolIds: capabilityContext.tools.map((item) => item.id),
      createdAt: new Date().toISOString()
    });
    await this.persistTranscript();
    this.busyLabel = mode === "agent" ? "正在修改" : "正在回复";
    this.postState();

    const abortController = new AbortController();
    try {
      await this.beginRunningTask("chat", this.busyLabel, abortController);
      const context = await this.tryCollectWorkspaceContext();
      const fileReferences = await collectPromptFileReferences(prompt);
      const recentHistory = this.transcript.slice(-(getAgentContextBudget().historyItems + 1), -1).map((item) => ({
        role: item.role,
        content: compactHistoryText(item.content, item.role === "assistant" ? getAgentContextBudget().assistantHistoryChars : getAgentContextBudget().userHistoryChars)
      }));

      const response = await this.providers.get(activeModel.providerId).chat({
        model: activeModel.modelId,
        messages: [
          {
            role: "system",
            content: buildSystemPrompt(mode)
          },
          ...recentHistory,
          {
            role: "user",
            content: buildContextualUserPrompt(prompt, mode, context, fileReferences, capabilityContext)
          }
        ],
        temperature: getModelTemperature(),
        maxTokens: getModelMaxTokens(),
        topP: getModelTopP()
      }, {
        signal: abortController.signal,
        onDelta: (delta) => {
          let last = this.transcript.at(-1);
          if (!last || last.role !== "assistant" || last.model !== activeModel.modelId) {
            last = { role: "assistant", content: "", model: activeModel.modelId, createdAt: new Date().toISOString() };
            this.transcript.push(last);
          }
          last.content += delta;
          void this.sessions.updateMessages(this.session.id, this.transcript).then((session) => {
            this.session = session;
            this.onStateChange();
          });
          this.postState();
        }
      });

      const last = this.transcript.at(-1);
      if (last && last.role === "assistant") {
        last.model = response.model;
        last.content = response.content;
      } else {
        this.transcript.push({ role: "assistant", content: response.content, model: response.model, createdAt: new Date().toISOString() });
      }
      await this.persistTranscript();
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") {
        if (this.disposed) {
          await this.persistTranscript();
          return;
        }
        const last = this.transcript.at(-1);
        if (last && last.role === "assistant" && last.content.trim().length > 0) {
          last.content = `${last.content}\n\n[已停止]`;
        } else {
          this.transcript.push({ role: "assistant", content: "已停止生成。", model: "local", createdAt: new Date().toISOString() });
        }
        await this.persistTranscript();
        return;
      }
      throw error;
    } finally {
      this.busyLabel = undefined;
      await this.clearRunningTask(abortController);
      if (!this.disposed) {
        this.postState();
      }
    }
  }

  private async handlePanelDispose(): Promise<void> {
    if (this.transcript.length > 0) {
      this.session = await this.sessions.updateMessages(this.session.id, this.transcript);
      this.onStateChange();
    }
  }

  private async tryCollectWorkspaceContext(): Promise<WorkspaceContext | undefined> {
    try {
      return await collectWorkspaceContext(this.gitService);
    } catch {
      return undefined;
    }
  }

  private async runSelectedCapabilitiesForAgent(prompt: string, capabilityContext: CapabilityContext, signal: AbortSignal): Promise<string | undefined> {
    const runnable = [
      ...capabilityContext.skills.filter(isScriptCapability),
      ...capabilityContext.tools.filter((item) => isScriptCapability(item) || isMcpToolCapability(item))
    ];

    if (runnable.length === 0) {
      this.appendProgressEvent("执行已选扩展能力", "done", "没有选择需要执行的 Skill 或 MCP 工具", "tool");
      return undefined;
    }

    const outputs: string[] = [];
    this.appendProgressEvent("执行已选扩展能力", "running", `${runnable.length} 个扩展能力等待审批后执行`, "tool");
    for (const capability of runnable.slice(0, getAgentContextBudget().readFiles)) {
      assertNotAborted(signal);
      const kind: "skill" | "tool" = capabilityContext.skills.some((item) => item.id === capability.id) ? "skill" : "tool";
      this.appendProgressEvent("执行已选扩展能力", "running", `执行 ${capability.label}`, "tool");
      const input = buildCapabilityAgentInput(prompt, this.transcript);
      const result = await this.runCapabilityWithHistory(kind, capability, input, "agent", signal);
      if (!result) {
        outputs.push(`## ${capability.label}\n用户拒绝授权或命令未执行。`);
        continue;
      }
      outputs.push(formatCapabilityOutputForAgent(result));
    }

    const output = compactHistoryText(outputs.join("\n\n"), getAgentContextBudget().toolOutputChars);
    this.appendProgressEvent("执行已选扩展能力", "done", output ? `${runnable.length} 个扩展能力已处理` : "没有可用输出", "tool");
    return output || undefined;
  }

  private async runVerifyForAgent(signal: AbortSignal): Promise<string | undefined> {
    const commands = this.verifyService.getConfiguredCommands();
    if (commands.length === 0) {
      return "没有配置验证命令。";
    }
    const approvedCommands = await this.approveVerifyCommands(commands, "运行验证", "Agent 工具循环需要运行验证命令来获得工程反馈。");
    if (approvedCommands.length === 0) {
      return undefined;
    }
    const suite = await this.verifyService.runSuite({ commands: approvedCommands, signal, stopOnFailure: true });
    await this.appendAssistant(formatVerifySuiteResult(suite), "local");
    return formatVerifySuiteResult(suite);
  }

  private async runPostApplyVerificationIfConfigured(signal: AbortSignal, appliedDraft?: Awaited<ReturnType<PatchWorkflowService["generatePatch"]>>): Promise<void> {
    const commands = this.verifyService.getConfiguredCommands();
    if (commands.length === 0) {
      this.appendProgressEvent("应用后验证", "done", "未配置验证命令", "verify");
      return;
    }

    const approvedCommands = await this.approveVerifyCommands(commands, "应用后验证", "修改应用后自动验证，失败时生成新的可审查修复草稿。");
    if (approvedCommands.length === 0) {
      this.appendProgressEvent("应用后验证", "error", "用户拒绝运行验证", "verify");
      return;
    }

    this.beginProgressMessage("正在应用后验证", [
      { label: "执行验证套件", kind: "verify" },
      { label: "分析验证结果", kind: "think" },
      { label: "生成修复草稿", kind: "patch" }
    ]);
    const suite = await this.verifyService.runSuite({
      commands: approvedCommands,
      signal,
      stopOnFailure: true,
      onCommandStart: (command, index, total) => this.appendProgressEvent("执行验证套件", "running", `${index + 1}/${total} · ${command}`, "verify"),
      onCommandResult: (result, index, total) => this.appendProgressEvent(
        "执行验证套件",
        result.exitCode === 0 && !result.aborted ? "running" : "error",
        `${index + 1}/${total} · exit ${result.exitCode ?? "n/a"} · ${result.summary ?? result.command}`,
        "verify"
      )
    });
    this.appendProgressEvent(
      "执行验证套件",
      suite.passed ? "done" : "error",
      `${suite.results.length}/${suite.commands.length} 条 · ${verifyFailureKindLabel(suite.failureKind)} · ${formatDuration(suite.durationMs)}`,
      "verify"
    );
    this.appendProgressEvent("分析验证结果", "done", "验证结果已写入会话", "think");
    await this.appendAssistant(formatVerifySuiteResult(suite), "local");
    if (!suite.aborted && !suite.passed) {
      const maxRepairAttempts = getAgentMaxRepairAttempts();
      const previousRound = appliedDraft?.verifyRepair?.round ?? 0;
      const nextRound = previousRound + 1;
      if (maxRepairAttempts <= 0 || nextRound > maxRepairAttempts) {
        this.appendProgressEvent(
          "生成修复草稿",
          "done",
          maxRepairAttempts <= 0 ? "已关闭自动修复草稿生成" : `已达到 ${maxRepairAttempts} 轮上限`,
          "patch"
        );
        await this.completeProgressMessage("应用后验证未通过", "已达到修复上限，请查看验证输出后手动处理");
        await this.appendAssistant(buildRepairLimitMessage(suite, previousRound, maxRepairAttempts), "local");
        return;
      }
      const draft = await this.generateVerifyRepairDraft(suite, signal, {
        round: nextRound,
        maxRounds: maxRepairAttempts,
        source: "postApply"
      });
      await this.completeProgressMessage(`应用后验证未通过，已生成第 ${nextRound}/${maxRepairAttempts} 轮修复草稿`, draft.files.join("、"));
      await this.appendAssistant(formatPatchReadyMessage(draft), "local");
      return;
    }
    this.appendProgressEvent("生成修复草稿", "done", "验证通过，无需修复", "patch");
    await this.completeProgressMessage("应用后验证通过", `${suite.results.length} 条命令`);
  }

  private async generateVerifyRepairDraft(
    result: VerifyResult | VerifySuiteResult,
    signal: AbortSignal,
    repairInfo: { round: number; maxRounds: number; source: "manualVerify" | "postApply" }
  ): Promise<Awaited<ReturnType<PatchWorkflowService["generatePatch"]>>> {
    this.appendProgressEvent("生成修复草稿", "running", `第 ${repairInfo.round}/${repairInfo.maxRounds} 轮，生成可审查草稿`, "patch");
    const fixPrompt = buildVerifyFixPrompt(result);
    const capabilityContext = this.resolveCapabilityContext(["debug"], ["files", "tests"]);
    const preparation = await this.agentOrchestrator.prepare({
      prompt: fixPrompt,
      transcript: this.transcript,
      capabilityContext,
      signal,
      onProgress: (label, stepStatus, detail, kind) => this.appendProgressEvent(label, stepStatus, detail, kind)
    });
    const agentRequest = buildAgentRequestWithHistory(fixPrompt, this.transcript, capabilityContext, undefined, preparation.contextBlock);
    const draft = await this.patchWorkflow.generatePatch(agentRequest, {
      signal,
      draftMetadata: {
        verifyRepair: {
          ...repairInfo,
          failedCommand: getVerifyFailedCommand(result),
          failureKind: getVerifyFailureKind(result),
          summary: getVerifyFailureSummary(result),
          createdAt: new Date().toISOString()
        }
      },
      onProgress: (progress) => this.updateProgressMessage(progress.label, progress.detail, progressKindForStage(progress.stage)),
      onDraft: (draft, draftStatus, detail) => {
        this.appendProgressEvent(
          "生成修复草稿",
          draftStatus === "failed" || draftStatus === "stopped" ? "error" : "running",
          detail ?? `${draft.fileCount} 个文件`,
          "patch"
        );
        this.postState();
      }
    });
    this.appendProgressEvent("生成修复草稿", "done", `${draft.fileCount} 个文件`, "patch");
    return draft;
  }

  private async approveVerifyCommands(commands: string[], label: string, reason: string): Promise<string[]> {
    const approvedCommands: string[] = [];
    const cwd = this.verifyService.getWorkspaceRoot();
    for (const command of commands) {
      const approved = await this.approvals.ensureCommandApproval({
        sessionId: this.session.id,
        toolId: "verify.run",
        label,
        command,
        cwd,
        reason
      });
      if (approved !== "approved") {
        this.postState();
        return [];
      }
      approvedCommands.push(command);
    }
    return approvedCommands;
  }

  private resolveCapabilityContext(skillIds?: string[], toolIds?: string[]): CapabilityContext {
    const capabilities = this.getCapabilities();
    return {
      skills: pickCapabilities(capabilities.skills, skillIds),
      tools: pickCapabilities(capabilities.tools, toolIds)
    };
  }

  private findCapability(type: "skill" | "tool", id: string): AgentCapabilityConfig | undefined {
    const capabilities = this.getCapabilities();
    const items = type === "skill" ? capabilities.skills : capabilities.tools;
    return items.find((item) => item.id === id);
  }

  private async runCapabilityWithHistory(
    type: "skill" | "tool",
    capability: AgentCapabilityConfig,
    input: string | undefined,
    source: "settings" | "agent",
    signal: AbortSignal
  ): Promise<CapabilityRunResult | undefined> {
    const startedAt = Date.now();
    try {
      const result = await this.capabilityRunner.run({
        sessionId: this.session.id,
        kind: type,
        capability,
        input,
        signal
      });
      await this.recordCapabilityRun({
        capability,
        type,
        source,
        result,
        input,
        startedAt,
        status: result ? undefined : "rejected"
      });
      return result;
    } catch (error) {
      await this.recordCapabilityRun({
        capability,
        type,
        source,
        input,
        startedAt,
        status: error instanceof Error && error.name === "AbortError" ? "stopped" : "error",
        error: formatUserFacingError(error)
      });
      throw error;
    }
  }

  private async recordCapabilityRun(options: {
    capability: AgentCapabilityConfig;
    type: "skill" | "tool";
    source: "settings" | "agent";
    result?: CapabilityRunResult;
    input?: string;
    startedAt: number;
    status?: CapabilityRunStatus;
    error?: string;
  }): Promise<void> {
    const durationMs = Math.max(0, Date.now() - options.startedAt);
    const status = options.status ?? capabilityRunStatus(options.result);
    const summary = buildCapabilityRunSummary(status, options.result, options.error);
    const record: CapabilityRunRecord = {
      id: createCapabilityRunId(),
      type: options.type,
      capabilityId: options.capability.id,
      label: options.capability.label,
      capabilityKind: options.capability.kind,
      source: options.source,
      status,
      summary,
      command: options.result?.command,
      cwd: options.result?.cwd,
      inputSummary: options.input ? compactHistoryText(options.input, 320) : undefined,
      exitCode: options.result?.exitCode,
      stdout: options.result?.stdout ? compactHistoryText(options.result.stdout, 1200) : undefined,
      stderr: options.result?.stderr ? compactHistoryText(options.result.stderr, 800) : options.error,
      durationMs,
      createdAt: new Date().toISOString()
    };
    const updated = await this.sessions.addCapabilityRun(this.session.id, record);
    if (updated) {
      this.session = { ...updated, messages: this.transcript };
      this.onStateChange();
      this.postState();
    }
  }

  private async beginRunningTask(kind: ChatSessionTaskState["kind"], label: string, controller: AbortController): Promise<void> {
    this.activeAbortController = controller;
    this.runningTasks.set(this.session.id, { controller, kind, label });
    const updated = await this.sessions.updateTaskState(this.session.id, {
      kind,
      label,
      updatedAt: new Date().toISOString()
    });
    if (updated) {
      this.session = { ...updated, messages: this.transcript };
    }
    this.onStateChange();
    this.postState();
  }

  private async clearRunningTask(controller: AbortController): Promise<void> {
    let shouldClear = false;
    if (this.activeAbortController === controller) {
      this.activeAbortController = undefined;
    }
    if (this.runningTasks.get(this.session.id)?.controller === controller) {
      this.runningTasks.delete(this.session.id);
      shouldClear = true;
    }
    if (shouldClear) {
      const updated = await this.sessions.updateTaskState(this.session.id, undefined);
      if (updated) {
        this.session = { ...updated, messages: this.transcript };
      }
      this.onStateChange();
    }
  }

  private async clearSessionTaskState(): Promise<void> {
    this.runningTasks.delete(this.session.id);
    const updated = await this.sessions.updateTaskState(this.session.id, undefined);
    if (updated) {
      this.session = { ...updated, messages: this.transcript };
    }
    this.onStateChange();
  }

  private async markStaleTask(taskState: ChatSessionTaskState): Promise<void> {
    const staleProgress = [...this.transcript].reverse().find((item) => item.kind === "agentProgress" && item.status === "running");
    if (staleProgress) {
      const now = new Date().toISOString();
      staleProgress.status = "error";
      staleProgress.content = `任务已中断\n${taskState.label}`;
      staleProgress.progressSteps = staleProgress.progressSteps?.map((step) => {
        if (step.status === "done" || step.status === "error") {
          return step;
        }
        return {
          ...step,
          status: "error",
          detail: step.status === "running" ? "窗口关闭或扩展主机重启后任务已中断" : step.detail,
          endedAt: now
        };
      });
    }

    const latestUser = [...this.transcript].reverse().find((item) => item.role === "user");
    const content = [
      `上次任务已中断：${taskState.label}`,
      "",
      "会话内容已经保留。VS Code 窗口关闭或扩展主机重启后，正在运行的进程无法继续执行；可以点击下方按钮重试上次请求。",
      latestUser ? "" : "",
      latestUser ? `上次请求：${compactHistoryText(latestUser.content, 420)}` : ""
    ].join("\n");
    const last = this.transcript.at(-1);
    if (!last || last.kind !== "taskInterrupted" || last.content !== content) {
      this.transcript.push({
        role: "assistant",
        content,
        model: "Patchlane",
        createdAt: new Date().toISOString(),
        kind: "taskInterrupted",
        title: taskState.label,
        status: "error"
      });
      this.session = await this.sessions.updateMessages(this.session.id, this.transcript);
    }
    const updated = await this.sessions.updateTaskState(this.session.id, undefined);
    if (updated) {
      this.session = { ...updated, messages: this.transcript };
    }
    this.onStateChange();
  }

  private async runLocalTask(label: string, task: () => Promise<void>): Promise<void> {
    this.busyLabel = label;
    this.postState();
    try {
      await task();
    } finally {
      this.busyLabel = undefined;
      this.postState();
    }
  }

  private async appendAssistant(content: string, model: string): Promise<void> {
    await this.appendTranscriptItem({ role: "assistant", content, model, createdAt: new Date().toISOString(), kind: "chat" });
  }

  private async appendTranscriptItem(item: ChatTranscriptItem): Promise<void> {
    this.transcript.push(item);
    await this.persistTranscript();
    this.postState();
  }

  private beginProgressMessage(title: string, steps: Array<{ label: string; kind?: ProgressStepKind }>): void {
    const now = new Date().toISOString();
    this.progressMessageId = now;
    this.transcript.push({
      role: "assistant",
      content: title,
      model: "Patchlane",
      createdAt: now,
      kind: "agentProgress",
      title,
      status: "running",
      progressSteps: steps.map((step, index) => ({
        label: step.label,
        kind: step.kind,
        status: index === 0 ? "running" : "pending",
        startedAt: index === 0 ? now : undefined
      }))
    });
    void this.persistTranscript();
    this.postState();
  }

  private updateProgressMessage(label: string, detail?: string, kind?: ProgressStepKind): void {
    const item = this.findProgressMessage();
    if (!item?.progressSteps) {
      return;
    }

    const index = item.progressSteps.findIndex((step) => step.label === label);
    if (index === -1) {
      return;
    }

    const now = new Date().toISOString();
    item.progressSteps = item.progressSteps.map((step, stepIndex) => {
      if (stepIndex < index && step.status !== "error") {
        return { ...step, status: "done", endedAt: step.endedAt ?? now };
      }
      if (stepIndex === index) {
        return { ...step, status: "running", detail, kind: kind ?? step.kind, startedAt: step.startedAt ?? now };
      }
      return step;
    });
    item.content = detail ? `${label}\n${detail}` : label;
    void this.persistTranscript();
    this.postState();
  }

  private async completeProgressMessage(label: string, detail?: string): Promise<void> {
    const item = this.findProgressMessage();
    if (!item?.progressSteps) {
      return;
    }

    item.status = "done";
    item.content = detail ? `${label}\n${detail}` : label;
    const now = new Date().toISOString();
    item.progressSteps = item.progressSteps.map((step) => ({ ...step, status: "done", endedAt: step.endedAt ?? now }));
    this.progressMessageId = undefined;
    await this.persistTranscript();
    this.postState();
  }

  private appendProgressEvent(label: string, status: "pending" | "running" | "done" | "error", detail?: string, kind?: ProgressStepKind): void {
    const item = this.findProgressMessage();
    if (!item) {
      return;
    }

    const steps = item.progressSteps ?? [];
    const existingIndex = steps.findIndex((step) => step.label === label);
    const now = new Date().toISOString();
    if (existingIndex === -1) {
      item.progressSteps = [...steps, { label, status, detail, kind, startedAt: status === "pending" ? undefined : now, endedAt: status === "done" || status === "error" ? now : undefined }];
    } else {
      item.progressSteps = steps.map((step, index) => index === existingIndex ? {
        ...step,
        status,
        detail,
        kind: kind ?? step.kind,
        startedAt: step.startedAt ?? (status === "pending" ? undefined : now),
        endedAt: status === "done" || status === "error" ? now : step.endedAt
      } : step);
    }
    item.content = detail ? `${label}\n${detail}` : label;
    void this.persistTranscript();
    this.postState();
  }

  private async failProgressMessage(message: string): Promise<void> {
    const item = this.findProgressMessage();
    if (!item) {
      return;
    }

    item.status = "error";
    item.content = message;
    const now = new Date().toISOString();
    item.progressSteps = item.progressSteps?.map((step) => step.status === "running" ? { ...step, status: "error", detail: message, endedAt: now } : step);
    this.progressMessageId = undefined;
    await this.persistTranscript();
    this.postState();
  }

  private findProgressMessage(): ChatTranscriptItem | undefined {
    if (!this.progressMessageId) {
      return undefined;
    }
    return this.transcript.find((item) => item.createdAt === this.progressMessageId && item.kind === "agentProgress");
  }

  private async persistTranscript(): Promise<void> {
    this.session = await this.sessions.updateMessages(this.session.id, this.transcript);
    if (!this.disposed) {
      this.panel.title = `Patchlane: ${this.session.title}`;
    }
    this.onStateChange();
  }

  private async refreshWorkspaceFiles(): Promise<void> {
    this.workspaceFiles = await getPreferredReferenceFiles(120);
  }

  private requestPageApproval(request: ApprovalPromptRequest): Promise<ApprovalDecision> {
    this.pendingApprovals.push(request);
    this.postState();
    return new Promise((resolve) => {
      this.approvalResolvers.set(request.id, resolve);
    });
  }

  private resolvePageApproval(approvalId: string, decision: ApprovalDecision): void {
    const resolver = this.approvalResolvers.get(approvalId);
    if (!resolver) {
      return;
    }

    this.approvalResolvers.delete(approvalId);
    const index = this.pendingApprovals.findIndex((item) => item.id === approvalId);
    if (index !== -1) {
      this.pendingApprovals.splice(index, 1);
    }
    resolver(decision);
    this.postState();
  }

  private async previewPendingPatch(): Promise<void> {
    const pendingPatch = this.patchWorkflow.getState().pendingPatch;
    if (!pendingPatch) {
      vscode.window.showInformationMessage("暂无可预览的待确认修改。");
      return;
    }

    const document = await vscode.workspace.openTextDocument({
      content: pendingPatch.patchText,
      language: "diff"
    });
    await vscode.window.showTextDocument(document, {
      preview: false,
      viewColumn: vscode.ViewColumn.Beside
    });
  }

}

function getHtml(webview: vscode.Webview, extensionUri: vscode.Uri, view: WebviewKind): string {
  const nonce = getNonce();
  const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, "media", "webview", "main.js"));
  const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, "media", "webview", "styles.css"));

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource} data:; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}'; font-src ${webview.cspSource};">
  <meta name="code-agent-view" content="${view}">
  <link rel="stylesheet" href="${styleUri}">
  <title>Patchlane</title>
</head>
<body data-view="${view}">
  <div id="root"></div>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
}

function normalizeSettingsTarget(settingKey?: string): string {
  const trimmed = settingKey?.trim();
  return trimmed && trimmed.startsWith("codeAgent.") ? trimmed : "@ext:local-dev.patchlane";
}

function getEditorContextSummary(): EditorContextSummary {
  const folder = vscode.workspace.workspaceFolders?.[0];
  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    return {
      hasFile: false,
      hasSelection: false,
      workspace: folder?.name
    };
  }

  const file = vscode.workspace.asRelativePath(editor.document.uri, false);
  const hasSelection = !editor.selection.isEmpty;
  const selection = hasSelection
    ? `${editor.selection.end.line - editor.selection.start.line + 1} line(s)`
    : undefined;

  return {
    file,
    selection,
    language: editor.document.languageId,
    hasFile: true,
    hasSelection,
    workspace: folder?.name
  };
}

async function insertTextIntoActiveEditor(text: string): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  if (!editor || editor.document.uri.scheme !== "file") {
    throw new Error("请先打开一个工作区文件，并把光标放到要插入的位置。");
  }

  await editor.edit((builder) => {
    if (editor.selection.isEmpty) {
      builder.insert(editor.selection.active, text);
    } else {
      builder.replace(editor.selection, text);
    }
  });
}

function getSelectedTextForAgent(): { path?: string; content: string; selection?: string } {
  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    throw new Error("请先打开一个文件。");
  }

  const hasSelection = !editor.selection.isEmpty;
  const content = !editor.selection.isEmpty ? editor.document.getText(editor.selection) : editor.document.getText();
  return {
    path: vscode.workspace.asRelativePath(editor.document.uri, false),
    content,
    selection: hasSelection
      ? `${editor.selection.end.line - editor.selection.start.line + 1} 行`
      : "整份文件"
  };
}

function buildSystemPrompt(mode: ChatMode): string {
  const base = [
    "You are Patchlane, a professional coding assistant inside VS Code.",
    "Default to Simplified Chinese for all user-facing replies unless the user explicitly asks for another language.",
    "Be concise, practical, and specific to the workspace context.",
    "Use file paths when helpful.",
    "When you include code, use fenced code blocks with a language tag.",
    "You can read workspace file context supplied by the extension.",
    "For writing files, generate a unified diff or tell the user to use the patch workflow; do not pretend normal chat has edited files directly."
  ];

  if (mode === "agent") {
    return [
      ...base,
      "Mode: Agent.",
      "Act like an engineering code agent, not a generic chatbot.",
      "Use a disciplined workflow: understand the task, inspect supplied workspace context, identify affected files, make the smallest correct change, and state verification steps.",
      "Do not invent files, APIs, package scripts, or project conventions that are not visible in the supplied context.",
      "Prefer local project patterns over generic examples.",
      "If a change is requested, produce concrete file-level guidance or direct the user to the patch workflow; never claim files were edited from normal chat.",
      "For limited-reasoning models, keep the plan short, explicit, and grounded in visible code.",
      "Use Simplified Chinese for summaries, plans, assumptions, risks, and verification notes."
    ].join(" ");
  }

  return [
    ...base,
    "Mode: Chat.",
    "Answer the user's question directly. Explain code and tradeoffs without over-planning."
  ].join(" ");
}

function normalizeMode(mode?: string): ChatMode {
  return mode === "agent" ? "agent" : "chat";
}

function buildContextualUserPrompt(
  prompt: string,
  mode: ChatMode,
  context: WorkspaceContext | undefined,
  fileReferences: Array<{ path: string; languageId: string; content: string }>,
  capabilityContext: CapabilityContext
): string {
  if (!context) {
    return [
      `Mode: ${mode}`,
      `User request: ${prompt}`,
      buildCapabilityContextBlock(capabilityContext),
      "",
      "Workspace context: unavailable. Answer with what you can infer and ask for a workspace only if needed."
    ].join("\n");
  }

  const activeFileBlock = context.activeFilePath
    ? [
        `Active file: ${context.activeFilePath}`,
        "Active file content:",
        "```text",
        context.activeFileContent ?? "",
        "```"
      ].join("\n")
    : "Active file: none";

  const selectionBlock = context.activeSelection
    ? [
        "Active selection:",
        "```text",
        context.activeSelection,
        "```"
      ].join("\n")
    : "Active selection: none";

  const referenceBlock = fileReferences.length > 0
    ? [
        "Referenced workspace files:",
        ...fileReferences.flatMap((file) => [
          `File: ${file.path}`,
          `\`\`\`${file.languageId}`,
          file.content,
          "```",
          ""
        ])
      ].join("\n")
    : "Referenced workspace files: none";

  return [
    `Mode: ${mode}`,
    `Workspace root: ${context.workspaceRoot}`,
    `User request: ${prompt}`,
    mode === "agent" ? [
      "",
      "Agent execution contract:",
      "- Treat this as a real engineering task in the current workspace.",
      "- Use only the files and context provided here unless the user references more files.",
      "- Prefer minimal, reviewable changes.",
      "- Call out assumptions and verification commands when relevant.",
      "- If implementation is blocked by missing context, say exactly which file or command is needed."
    ].join("\n") : "",
    buildCapabilityContextBlock(capabilityContext),
    "",
    activeFileBlock,
    "",
    selectionBlock,
    "",
    referenceBlock,
    "",
    "Workspace change summary:",
    "```text",
    context.changeSummary,
    "```",
    "",
    "Workspace diff context:",
    "```diff",
    context.diffContext,
    "```"
  ].join("\n");
}

function buildCapabilityPrompt(prompt: string, capabilityContext: CapabilityContext): string {
  return [
    buildCapabilityContextBlock(capabilityContext),
    "",
    prompt
  ].join("\n").trim();
}

function buildAgentRequestWithHistory(
  prompt: string,
  transcript: ChatTranscriptItem[],
  capabilityContext: CapabilityContext,
  webContext?: string,
  toolContext?: string,
  memoryContext: AgentMemoryContext = buildAgentMemoryContext(prompt, transcript, getAgentContextBudget())
): string {
  const history = memoryContext.recentHistory || collectAgentRelevantHistory(transcript);
  return [
    buildCapabilityContextBlock(capabilityContext),
    memoryContext.planBlock ? [
      "前文计划摘录：用户当前请求可能是在执行同一会话前文计划。生成修改时必须优先遵循下面的目标、步骤、验收标准和范围；如果当前工作区上下文与计划冲突，以真实文件内容为准并保持最小修改。",
      memoryContext.planBlock
    ].join("\n") : "",
    memoryContext.shouldFollowPreviousPlan && !memoryContext.planBlock ? [
      "前文计划状态：用户请求看起来是在继续执行前文计划，但当前可用历史中没有提取到明确计划。请基于当前任务和真实工作区上下文重新制定最小计划，不要生成无关示例项目。"
    ].join("\n") : "",
    toolContext ? [
      "Agent 工具上下文：以下内容来自 Patchlane 在本地工作区执行的只读分析，包括候选文件、关键文件片段、诊断和 Git 状态。生成修改时必须优先依据这里的真实项目上下文。",
      toolContext
    ].join("\n") : "",
    webContext ? [
      "联网搜索上下文：以下资料来自公开网页搜索。涉及最新版本、最新文档或服务商 API 时，应优先依据这里的来源；如果来源不足，请说明不确定性。",
      webContext
    ].join("\n") : "",
    history ? [
      "最近对话上下文：当用户提到“上面的计划”“刚才方案”“按计划实现”等内容时，必须沿用这里的计划和需求，不要重新生成无关示例项目。",
      history
    ].join("\n") : "",
    "",
    "当前 Agent 任务：",
    prompt,
    "",
    "重要要求：如果当前任务引用前文计划或前文讨论，请实现前文计划；所有面向用户的摘要、步骤、假设和验证说明默认使用简体中文。"
  ].filter(Boolean).join("\n").trim();
}

function collectAgentRelevantHistory(transcript: ChatTranscriptItem[]): string {
  const budget = getAgentContextBudget();
  const items = transcript
    .slice(0, -1)
    .filter((item) => item.kind !== "agentProgress")
    .slice(-budget.historyItems);

  const lines: string[] = [];
  for (const item of items) {
    const role = item.role === "assistant" ? `assistant${item.model ? `/${item.model}` : ""}` : "user";
    lines.push(`--- ${role} ---`);
    lines.push(compactHistoryText(item.content, item.role === "assistant" ? budget.assistantHistoryChars : budget.userHistoryChars));
  }

  return compactHistoryText(lines.join("\n"), budget.historyChars);
}

function shouldAgentUseWebSearch(prompt: string, capabilityContext: CapabilityContext): boolean {
  if (capabilityContext.tools.some((tool) => ["web-search", "docs-search", "github-search", "news-search"].includes(tool.id))) {
    return true;
  }
  return /最新|官方文档|文档|搜索|联网|查一下|查找|release|changelog|api\s*变化|版本|报错|错误码|依赖|npm|sdk|breaking/i.test(prompt);
}

function buildAgentSearchQuery(prompt: string): string {
  const normalized = prompt.replace(/\s+/g, " ").trim();
  if (normalized.length <= 160) {
    return normalized;
  }
  return normalized.slice(0, 160);
}

function inferSearchSourceHint(query: string): "general" | "docs" | "news" | "github" {
  if (/github|issue|pull request|pr\b|release|仓库|开源/.test(query)) {
    return "github";
  }
  if (/官方文档|文档|docs|documentation|api|sdk|reference|手册/.test(query)) {
    return "docs";
  }
  if (/最新|新闻|公告|发布|release|changelog|breaking|变更/.test(query)) {
    return "news";
  }
  return "general";
}

function formatWebSearchForPrompt(response: WebSearchResponse): string {
  const lines = [
    `Query: ${response.query}`,
    `Provider: ${response.provider}`,
    `Search intent: ${response.sourceHint}`,
    `Fetched at: ${response.fetchedAt}`,
    "",
    ...response.results.slice(0, getAgentContextBudget().webResults).flatMap((item, index) => [
      `${index + 1}. ${item.title}`,
      `URL: ${item.url}`,
      item.source ? `Source: ${item.source}` : "",
      item.updatedAt ? `Updated: ${item.updatedAt}` : item.publishedAt ? `Published: ${item.publishedAt}` : "",
      `Summary: ${compactHistoryText(item.snippet, getAgentContextBudget().webSnippetChars)}`,
      ""
    ])
  ];
  return lines.filter(Boolean).join("\n");
}

function compactHistoryText(value: string, maxChars: number): string {
  const normalized = value.replace(/\n{4,}/g, "\n\n\n").trim();
  if (normalized.length <= maxChars) {
    return normalized;
  }
  const head = Math.floor(maxChars * 0.7);
  const tail = maxChars - head;
  return `${normalized.slice(0, head)}\n\n[历史已截断]\n\n${normalized.slice(-tail)}`;
}

function capabilityRunStatus(result?: CapabilityRunResult): CapabilityRunStatus {
  if (!result) {
    return "rejected";
  }
  return result.exitCode === 0 ? "success" : "failed";
}

function buildCapabilityRunSummary(status: CapabilityRunStatus, result?: CapabilityRunResult, error?: string): string {
  if (error) {
    return error;
  }
  if (status === "rejected") {
    return "用户拒绝授权或命令未执行。";
  }
  if (status === "stopped") {
    return "已手动停止执行。";
  }
  if (!result) {
    return "未获得执行结果。";
  }
  if (result.exitCode === 0) {
    return result.stdout ? compactHistoryText(firstNonEmptyLine(result.stdout), 160) : "执行成功，脚本没有输出。";
  }
  if (result.stderr) {
    return compactHistoryText(firstNonEmptyLine(result.stderr), 160);
  }
  if (result.stdout) {
    return compactHistoryText(firstNonEmptyLine(result.stdout), 160);
  }
  return `执行失败，退出码 ${result.exitCode ?? "n/a"}。`;
}

function firstNonEmptyLine(value: string): string {
  return value.split(/\r?\n/).map((line) => line.trim()).find(Boolean) ?? value.trim();
}

function createCapabilityRunId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function progressKindForStage(stage: "context" | "references" | "plan" | "model" | "parse" | "review" | "repair" | "ready"): ProgressStepKind {
  switch (stage) {
    case "context":
    case "references":
      return "file";
    case "plan":
    case "review":
      return "think";
    case "model":
      return "model";
    case "parse":
    case "repair":
    case "ready":
      return "patch";
  }
}

function formatUserFacingError(error: unknown): string {
  return formatProviderErrorForUser(error);
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && (error.name === "AbortError" || error.message.toLowerCase().includes("aborted"));
}

function formatLocalTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }
  return date.toLocaleString("zh-CN", {
    hour12: false
  });
}

function buildCapabilityContextBlock(context: CapabilityContext): string {
  const lines: string[] = [];
  if (context.skills.length > 0) {
    lines.push(`已选择 Skill：${context.skills.map((item) => `${item.label}${item.script ? ` (${item.runtime ?? "script"})` : ""}`).join("、")}`);
  }
  if (context.tools.length > 0) {
    lines.push(`已选择工具：${context.tools.map((item) => `${item.label}${item.kind === "mcp" && item.server ? ` [${item.server}]` : ""}`).join("、")}`);
  }
  return lines.join("\n");
}

function pickCapabilities(items: AgentCapabilityConfig[], ids?: string[]): AgentCapabilityConfig[] {
  const selectedIds = sanitizeIds(ids);
  if (selectedIds.length === 0) {
    return [];
  }

  const byId = new Map(items.map((item) => [item.id, item] as const));
  return selectedIds.map((id) => byId.get(id)).filter((item): item is AgentCapabilityConfig => Boolean(item));
}

function sanitizeIds(ids?: string[]): string[] {
  return [...new Set((ids ?? []).map((id) => id.trim()).filter(Boolean))];
}

function formatCapabilityRunResult(result: {
  label: string;
  command: string;
  cwd: string;
  exitCode: number | null;
  stdout: string;
  stderr: string;
}): string {
  const lines = [
    `已运行：${result.label}`,
    "",
    `- 命令：\`${result.command}\``,
    `- 目录：\`${result.cwd}\``,
    `- 退出码：${result.exitCode ?? "n/a"}`,
    ""
  ];

  if (result.stdout) {
    lines.push("输出：", "", "```text", result.stdout, "```", "");
  }
  if (result.stderr) {
    lines.push("错误输出：", "", "```text", result.stderr, "```", "");
  }
  if (!result.stdout && !result.stderr) {
    lines.push("脚本没有输出。");
  }
  return lines.join("\n").trim();
}

function summarizeMcpCatalog(items: McpDiscoveredServerCatalog[]): { tools: number; resources: number; prompts: number } {
  return items.reduce((summary, item) => ({
    tools: summary.tools + item.tools.length,
    resources: summary.resources + item.resources.length,
    prompts: summary.prompts + item.prompts.length
  }), { tools: 0, resources: 0, prompts: 0 });
}

function buildCapabilityDiagnostics(
  capabilities: AgentCapabilityState,
  mcpServers: McpServerSummary[],
  catalog: McpDiscoveredServerCatalog[],
  manifest?: CapabilityManifestState
): CapabilityDiagnostic[] {
  const diagnostics: CapabilityDiagnostic[] = [];
  const serverByName = new Map(mcpServers.map((server) => [server.name, server] as const));
  const catalogByName = new Map(catalog.map((server) => [server.name, server] as const));

  addManifestDiagnostics(diagnostics, manifest);
  addDuplicateCapabilityDiagnostics(diagnostics, "skill", capabilities.skills);
  addDuplicateCapabilityDiagnostics(diagnostics, "tool", capabilities.tools);

  for (const skill of capabilities.skills) {
    if (skill.kind === "builtin") {
      continue;
    }
    if (skill.kind === "mcp") {
      addMcpCapabilityDiagnostic(diagnostics, "skill", skill, serverByName);
      continue;
    }
    addScriptCapabilityDiagnostic(diagnostics, "skill", skill);
  }

  for (const tool of capabilities.tools) {
    if (tool.kind === "builtin") {
      continue;
    }
    if (tool.kind === "mcp") {
      addMcpCapabilityDiagnostic(diagnostics, "tool", tool, serverByName);
      continue;
    }
    addScriptCapabilityDiagnostic(diagnostics, "tool", tool);
  }

  for (const server of mcpServers) {
    const configTarget = "codeAgent.mcp.servers";
    if (!server.enabled) {
      diagnostics.push({
        id: `mcp-disabled-${server.name}`,
        severity: "info",
        scope: "mcp",
        title: `${server.name} 已禁用`,
        detail: "这个 MCP 服务不会出现在 Agent 可用工具里；需要时可以在设置里重新启用。",
        target: configTarget,
        action: "需要使用这个 MCP 时，把 enabled 改成 true；不需要它时可以保持禁用。",
        actionLabel: "打开 MCP 设置"
      });
      continue;
    }

    if (server.transport === "http" && !server.url) {
      diagnostics.push({
        id: `mcp-missing-url-${server.name}`,
        severity: "error",
        scope: "mcp",
        title: `${server.name} 缺少 URL`,
        detail: "HTTP MCP 服务需要填写 url，Patchlane 才能调用 JSON-RPC 接口。",
        target: configTarget,
        action: "打开 MCP 设置，在这个服务里填写 url，例如 https://your-server.example.com/mcp。",
        actionLabel: "填写 URL"
      });
    }

    if (server.transport === "stdio" && !server.command) {
      diagnostics.push({
        id: `mcp-missing-command-${server.name}`,
        severity: "error",
        scope: "mcp",
        title: `${server.name} 缺少 command`,
        detail: "stdio MCP 服务需要填写启动命令，例如 node 或 python，并通过 args 指向服务脚本。",
        target: configTarget,
        action: "打开 MCP 设置，填写 command，例如 node；如果是本地脚本，再用 args 指向 .patchlane/mcp/.../server.js。",
        actionLabel: "填写 command"
      });
    }

    if (server.lastError || server.status === "error") {
      diagnostics.push({
        id: `mcp-runtime-error-${server.name}`,
        severity: "error",
        scope: "mcp",
        title: `${server.name} 启动或调用失败`,
        detail: server.lastError || "MCP 服务进入错误状态，请检查命令、参数、环境变量或服务日志。",
        target: configTarget,
        action: "先在 MCP 服务卡片里点“重连”；仍失败时检查 command、args、cwd、env 或远程 URL。",
        actionLabel: "检查配置"
      });
      continue;
    }

    const discovered = catalogByName.get(server.name);
    const discoveredCount = (discovered?.tools.length ?? 0) + (discovered?.resources.length ?? 0) + (discovered?.prompts.length ?? 0);
    if (server.status === "running" && discoveredCount === 0) {
      diagnostics.push({
        id: `mcp-empty-catalog-${server.name}`,
        severity: "warning",
        scope: "mcp",
        title: `${server.name} 没有发现能力`,
        detail: "服务已运行，但没有返回工具、资源或 Prompt。请确认 MCP 服务是否实现了 list 接口。",
        target: configTarget,
        action: "如果这是完整 MCP Server，请确认它实现 tools/list、resources/list 或 prompts/list；如果只是占位配置，可以忽略。",
        actionLabel: "打开 MCP 设置"
      });
    } else if (discoveredCount === 0 && (server.command || server.url)) {
      diagnostics.push({
        id: `mcp-not-discovered-${server.name}`,
        severity: "info",
        scope: "mcp",
        title: `${server.name} 尚未发现目录`,
        detail: "点击“发现 MCP 能力”后，会读取该服务的工具、资源和 Prompt，并同步到选择器。",
        target: configTarget,
        action: "先点设置页下方“发现 MCP 能力”。如果发现失败，再打开 MCP 设置检查启动命令或 URL。",
        actionLabel: "打开 MCP 设置"
      });
    }
  }

  return dedupeDiagnostics(diagnostics).slice(0, 24);
}

function addManifestDiagnostics(diagnostics: CapabilityDiagnostic[], manifest?: CapabilityManifestState): void {
  for (const item of manifest?.diagnostics ?? []) {
    diagnostics.push({
      id: `manifest-${item.severity}-${item.path}-${item.message}`,
      severity: item.severity,
      scope: item.path.startsWith("mcpServers") ? "mcp" : item.path.startsWith("skills") ? "skill" : "tool",
      title: ".patchlane 清单配置异常",
      detail: `${item.path}：${item.message}`,
      target: ".patchlane/patchlane.json",
      targetKind: "file",
      action: "打开工作区里的 .patchlane/patchlane.json，按提示修正对应字段；如果只是想先体验，也可以点击“生成扩展模板”重新生成示例。",
      actionLabel: "打开清单"
    });
  }
}

function addDuplicateCapabilityDiagnostics(
  diagnostics: CapabilityDiagnostic[],
  scope: "skill" | "tool",
  capabilities: AgentCapabilityConfig[]
): void {
  const counts = new Map<string, number>();
  for (const capability of capabilities) {
    counts.set(capability.id, (counts.get(capability.id) ?? 0) + 1);
  }
  for (const [id, count] of counts.entries()) {
    if (count > 1) {
      diagnostics.push({
        id: `${scope}-duplicate-${id}`,
        severity: "warning",
        scope,
        title: `${capabilityScopeLabel(scope)} ID 重复：${id}`,
        detail: "重复 ID 会导致选择器和执行路由只命中其中一个能力，建议改成唯一 ID。",
        target: scope === "skill" ? "codeAgent.customSkills" : "codeAgent.customTools",
        action: "打开设置，给重复的能力换一个唯一 id；团队共享能力则修改 .patchlane/patchlane.json。",
        actionLabel: "修改 ID"
      });
    }
  }
}

function addScriptCapabilityDiagnostic(
  diagnostics: CapabilityDiagnostic[],
  scope: "skill" | "tool",
  capability: AgentCapabilityConfig
): void {
  const target = scope === "skill" ? "codeAgent.customSkills" : "codeAgent.customTools";
  if (!capability.script && !capability.command) {
    if (scope === "skill") {
      return;
    }
    diagnostics.push({
      id: `${scope}-passive-${capability.id}`,
      severity: "warning",
      scope,
      title: `${capability.label} 没有可执行入口`,
      detail: "这个工具没有 script 或 command，Agent 不能把它作为可执行工具调用。",
      target,
      action: "如果只是提示标签，请改成 Skill；如果要让 Agent 执行它，请填写 script 或 command。",
      actionLabel: "添加入口"
    });
    return;
  }

  if (capability.script) {
    const normalized = capability.script.replace(/\\/g, "/");
    if (path.isAbsolute(capability.script) || normalized.startsWith("../")) {
      diagnostics.push({
        id: `${scope}-script-outside-${capability.id}`,
        severity: "error",
        scope,
        title: `${capability.label} 脚本路径不安全`,
        detail: "脚本必须使用当前工作区内的相对路径，不能使用绝对路径或 ../ 跳出工作区。",
        target,
        action: "把脚本移动到当前工作区内，推荐放在 .patchlane/skills 或 .patchlane/tools，再更新 script 路径。",
        actionLabel: "修改路径"
      });
    } else if (!normalized.startsWith(".patchlane/")) {
      diagnostics.push({
        id: `${scope}-script-location-${capability.id}`,
        severity: "info",
        scope,
        title: `${capability.label} 建议放入 .patchlane`,
        detail: "推荐把扩展脚本放在 .patchlane/skills、.patchlane/tools 或 .patchlane/mcp 下，便于团队维护和审计。",
        target,
        action: "这不是必须处理的问题；如果要团队共享和审计，建议把脚本移到 .patchlane 目录。",
        actionLabel: "查看设置"
      });
    }
  }

  if (capability.runtime === "mcp" && capability.kind !== "mcp") {
    diagnostics.push({
      id: `${scope}-runtime-mcp-${capability.id}`,
      severity: "warning",
      scope,
      title: `${capability.label} runtime 与类型不一致`,
      detail: "runtime=mcp 通常应配合 kind=mcp、server 和 command 使用；如果这是普通脚本，建议改成 node、python、shell 或 custom。",
      target,
      action: "如果它调用 MCP，请设置 kind=mcp 并填写 server/command；如果它是脚本，请把 runtime 改成 node、python 或 shell。",
      actionLabel: "修正类型"
    });
  }
}

function addMcpCapabilityDiagnostic(
  diagnostics: CapabilityDiagnostic[],
  scope: "skill" | "tool",
  capability: AgentCapabilityConfig,
  serverByName: Map<string, McpServerSummary>
): void {
  const target = scope === "skill" ? "codeAgent.customSkills" : "codeAgent.customTools";
  if (!capability.server || !capability.command) {
    diagnostics.push({
      id: `${scope}-mcp-missing-route-${capability.id}`,
      severity: "error",
      scope,
      title: `${capability.label} 缺少 MCP 路由`,
      detail: "MCP 能力需要同时配置 server 和 command，才能知道调用哪个 MCP 服务的哪个工具。",
      target,
      action: "打开设置，填写 server 为 MCP 服务名，command 为 MCP 工具名；普通用户也可以先点“生成扩展模板”。",
      actionLabel: "填写路由"
    });
    return;
  }

  const server = serverByName.get(capability.server);
  if (!server) {
    diagnostics.push({
      id: `${scope}-mcp-server-not-found-${capability.id}`,
      severity: "error",
      scope,
      title: `${capability.label} 找不到 MCP 服务`,
      detail: `请先在 codeAgent.mcp.servers 中添加名为 ${capability.server} 的服务。`,
      target: "codeAgent.mcp.servers",
      action: `打开 MCP 设置，添加名为 ${capability.server} 的服务；或把这个能力的 server 改成已有服务名。`,
      actionLabel: "添加 MCP 服务"
    });
    return;
  }

  if (!server.enabled) {
    diagnostics.push({
      id: `${scope}-mcp-server-disabled-${capability.id}`,
      severity: "warning",
      scope,
      title: `${capability.label} 指向已禁用服务`,
      detail: `MCP 服务 ${capability.server} 当前被禁用，Agent 不会成功调用这个能力。`,
      target: "codeAgent.mcp.servers",
      action: "打开 MCP 设置，把该服务 enabled 改成 true；不需要时可以删除这个能力。",
      actionLabel: "启用服务"
    });
  }
}

function dedupeDiagnostics(items: CapabilityDiagnostic[]): CapabilityDiagnostic[] {
  const seen = new Set<string>();
  const result: CapabilityDiagnostic[] = [];
  for (const item of items) {
    if (seen.has(item.id)) {
      continue;
    }
    seen.add(item.id);
    result.push(item);
  }
  return result.sort((left, right) => diagnosticWeight(left.severity) - diagnosticWeight(right.severity));
}

function diagnosticWeight(severity: CapabilityDiagnosticSeverity): number {
  switch (severity) {
    case "error":
      return 0;
    case "warning":
      return 1;
    case "info":
    default:
      return 2;
  }
}

function capabilityScopeLabel(scope: "skill" | "tool" | "mcp"): string {
  switch (scope) {
    case "skill":
      return "Skill";
    case "tool":
      return "工具";
    case "mcp":
      return "MCP";
    default:
      return "能力";
  }
}

function formatMcpDiscoveryResult(discovered: Record<string, McpDiscoveredServerCatalog>): string {
  const entries = Object.entries(discovered);
  if (entries.length === 0) {
    return "没有可发现的 MCP 服务。请先在 VS Code 设置中配置 `codeAgent.mcp.servers`。";
  }
  const totals = summarizeMcpCatalog(entries.map(([, catalog]) => catalog));
  const lines = [
    "MCP 能力发现结果：",
    "",
    `合计：${totals.tools} 个工具，${totals.resources} 个资源，${totals.prompts} 个 Prompt。`,
    ""
  ];
  for (const [server, catalog] of entries) {
    lines.push(`- ${server}：${catalog.tools.length} 个工具，${catalog.resources.length} 个资源，${catalog.prompts.length} 个 Prompt`);
    for (const tool of catalog.tools.slice(0, 8)) {
      lines.push(`  - ${tool.label || tool.name} (${tool.name})：${tool.description || "无说明"}`);
    }
    for (const resource of catalog.resources.slice(0, 6)) {
      lines.push(`  - Resource ${resource.name || resource.uri}：${resource.description || resource.uri}`);
    }
    for (const prompt of catalog.prompts.slice(0, 6)) {
      lines.push(`  - Prompt ${prompt.label || prompt.name} (${prompt.name})：${prompt.description || "无说明"}`);
    }
  }
  return lines.join("\n");
}

function formatMcpResourceResult(serverName: string, resourceUri: string, content: string): string {
  return [
    `已读取 MCP 资源：${serverName}`,
    "",
    `URI：\`${resourceUri}\``,
    "",
    "```text",
    compactHistoryText(content, getAgentContextBudget().toolOutputChars),
    "```",
    "",
    "这段内容已经进入当前会话上下文。后续切换到 Agent 模式时，可以直接引用“上面的 MCP 资源”。"
  ].join("\n");
}

function formatMcpPromptResult(serverName: string, promptName: string, content: string): string {
  return [
    `已获取 MCP Prompt：${serverName}/${promptName}`,
    "",
    compactHistoryText(content, getAgentContextBudget().toolOutputChars),
    "",
    "这段 Prompt 已进入当前会话上下文。你可以继续提问，或切换到 Agent 模式让它按这段 Prompt 执行。"
  ].join("\n");
}

function buildCapabilityAgentInput(prompt: string, transcript: ChatTranscriptItem[]): string {
  return JSON.stringify({
    prompt,
    recentHistory: collectAgentRelevantHistory(transcript),
    time: new Date().toISOString()
  }, null, 2);
}

function formatCapabilityOutputForAgent(result: {
  label: string;
  command: string;
  cwd: string;
  exitCode: number | null;
  stdout: string;
  stderr: string;
}): string {
  return [
    `## ${result.label}`,
    `命令：${result.command}`,
    `目录：${result.cwd}`,
    `退出码：${result.exitCode ?? "n/a"}`,
    result.stdout ? ["输出：", "```text", compactHistoryText(result.stdout, getAgentContextBudget().toolStdoutChars), "```"].join("\n") : "输出：无",
    result.stderr ? ["错误输出：", "```text", compactHistoryText(result.stderr, getAgentContextBudget().toolStderrChars), "```"].join("\n") : ""
  ].filter(Boolean).join("\n");
}

function mergeToolContext(...blocks: Array<string | undefined>): string | undefined {
  const merged = blocks.filter((block): block is string => Boolean(block?.trim())).join("\n\n");
  return merged || undefined;
}

function isScriptCapability(capability: AgentCapabilityConfig): boolean {
  return Boolean(capability.script || (capability.command && capability.kind === "custom"));
}

function isMcpToolCapability(capability: AgentCapabilityConfig): boolean {
  return capability.kind === "mcp" && Boolean(capability.server && capability.command) && capability.id.startsWith("mcp:");
}

function assertNotAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new DOMException("The operation was aborted.", "AbortError");
  }
}

async function createUniqueSkillId(workspace: vscode.Uri, label: string): Promise<string> {
  const config = vscode.workspace.getConfiguration("codeAgent", workspace);
  const existingIds = new Set(config.get<AgentCapabilityConfig[]>("customSkills", []).map((item) => item.id));
  const baseId = slugify(label) || "custom-skill";
  let candidate = baseId;
  let index = 2;
  while (existingIds.has(candidate) || await uriExists(workspaceRelativeUri(workspace, `.patchlane/skills/${candidate}`))) {
    candidate = `${baseId}-${index}`;
    index += 1;
  }
  return candidate;
}

function normalizeSkillRuntime(value?: "node" | "python" | "shell"): "node" | "python" | "shell" {
  if (value === "python" || value === "shell") {
    return value;
  }
  return "node";
}

function skillExtension(runtime: "node" | "python" | "shell"): string {
  switch (runtime) {
    case "python":
      return "py";
    case "shell":
      return process.platform === "win32" ? "cmd" : "sh";
    case "node":
    default:
      return "js";
  }
}

function workspaceRelativeUri(root: vscode.Uri, relativePath: string): vscode.Uri {
  return vscode.Uri.joinPath(root, ...relativePath.split("/").filter(Boolean));
}

function parentUri(uri: vscode.Uri): vscode.Uri {
  return vscode.Uri.file(path.dirname(uri.fsPath));
}

async function uriExists(uri: vscode.Uri): Promise<boolean> {
  return vscode.workspace.fs.stat(uri).then(() => true, () => false);
}

function slugify(value: string): string {
  const ascii = value
    .normalize("NFKD")
    .replace(/[^\w\s-]/g, "")
    .trim()
    .toLowerCase()
    .replace(/[_\s]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  return ascii || `skill-${Date.now().toString(36)}`;
}

function buildSkillTemplate(label: string, description: string | undefined, runtime: "node" | "python" | "shell"): string {
  if (runtime === "python") {
    return [
      "import json",
      "import os",
      "import sys",
      "",
      "workspace = os.environ.get('PATCHLANE_WORKSPACE', os.getcwd())",
      "raw_input = sys.stdin.read()",
      "",
      `print("# ${escapeTemplateText(label)}")`,
      "print()",
      `print("${escapeTemplateText(description || "自定义 Patchlane Skill。")}")`,
      "print()",
      "print('## 工作区')",
      "print(workspace)",
      "print()",
      "print('## 输入')",
      "print(raw_input.strip() or '未提供输入。')",
      "print()",
      "print('## 建议')",
      "print('- 在这里读取必要文件、调用内部服务或输出结构化分析。')",
      "print('- 保持输出简短，避免把整个项目内容塞回模型。')",
      ""
    ].join("\n");
  }

  if (runtime === "shell") {
    return process.platform === "win32"
      ? [
          "@echo off",
          "setlocal enabledelayedexpansion",
          `echo # ${escapeTemplateText(label)}`,
          "echo.",
          `echo ${escapeTemplateText(description || "自定义 Patchlane Skill。")}`,
          "echo.",
          "echo ## 工作区",
          "echo %PATCHLANE_WORKSPACE%",
          "echo.",
          "echo ## 输入",
          "more",
          ""
        ].join("\r\n")
      : [
          "#!/usr/bin/env sh",
          `printf '# ${escapeTemplateText(label)}\\n\\n'`,
          `printf '${escapeTemplateText(description || "自定义 Patchlane Skill。")}\\n\\n'`,
          "printf '## 工作区\\n%s\\n\\n' \"${PATCHLANE_WORKSPACE:-$(pwd)}\"",
          "printf '## 输入\\n'",
          "cat",
          ""
        ].join("\n");
  }

  return [
    'const fs = require("fs");',
    'const path = require("path");',
    "",
    "const workspace = process.env.PATCHLANE_WORKSPACE || process.cwd();",
    "const input = readStdin();",
    "",
    `console.log("# ${escapeTemplateText(label)}");`,
    'console.log("");',
    `console.log("${escapeTemplateText(description || "自定义 Patchlane Skill。")}");`,
    'console.log("");',
    'console.log("## 工作区");',
    "console.log(workspace);",
    'console.log("");',
    'console.log("## 输入");',
    'console.log(input.trim() || "未提供输入。");',
    'console.log("");',
    'console.log("## 建议");',
    'console.log("- 在这里读取必要文件、调用内部服务或输出结构化分析。");',
    'console.log("- 保持输出简短，避免把整个项目内容塞回模型。");',
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

function escapeTemplateText(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\r?\n/g, " ");
}

function formatVerifyResult(result: {
  command: string;
  exitCode: number | null;
  output: string;
  durationMs: number;
  aborted?: boolean;
  failureKind?: VerifyResult["failureKind"];
  summary?: string;
}): string {
  const status = result.aborted ? "已停止" : result.exitCode === 0 ? "通过" : "未通过";
  return [
    `验证结果：${status}`,
    "",
    `- 命令：\`${result.command}\``,
    `- 退出码：${result.exitCode ?? "n/a"}`,
    `- 耗时：${formatDuration(result.durationMs)}`,
    result.failureKind && result.failureKind !== "pass" ? `- 失败类型：${verifyFailureKindLabel(result.failureKind)}` : "",
    result.summary ? `- 摘要：${result.summary}` : "",
    "",
    "输出：",
    "",
    "```text",
    compactHistoryText(result.output, getAgentContextBudget().verifyOutputChars),
    "```"
  ].filter(Boolean).join("\n");
}

function formatVerifySuiteResult(suite: VerifySuiteResult): string {
  if (suite.results.length === 1) {
    return formatVerifyResult(suite.results[0]);
  }
  const status = suite.aborted ? "已停止" : suite.passed ? "通过" : "未通过";
  const budget = getAgentContextBudget();
  return [
    `验证套件结果：${status}`,
    "",
    `- 命令数：${suite.results.length}/${suite.commands.length}`,
    `- 耗时：${formatDuration(suite.durationMs)}`,
    suite.failedCommand ? `- 首个失败命令：\`${suite.failedCommand}\`` : "",
    `- 失败类型：${verifyFailureKindLabel(suite.failureKind)}`,
    "",
    "命令摘要：",
    ...suite.results.map((result, index) => [
      `${index + 1}. ${result.exitCode === 0 && !result.aborted ? "通过" : "失败"} \`${result.command}\``,
      `   exit ${result.exitCode ?? "n/a"} · ${formatDuration(result.durationMs)} · ${result.summary ?? verifyFailureKindLabel(result.failureKind ?? "unknown")}`
    ].join("\n")),
    "",
    "输出：",
    "",
    "```text",
    compactHistoryText(suite.results.map((result) => [
      `$ ${result.command}`,
      `exit ${result.exitCode ?? "n/a"} · ${result.summary ?? ""}`,
      result.output
    ].join("\n")).join("\n\n"), budget.verifyOutputChars),
    "```"
  ].filter(Boolean).join("\n");
}

function buildRepairLimitMessage(suite: VerifySuiteResult, previousRound: number, maxRepairAttempts: number): string {
  const limitText = maxRepairAttempts <= 0 ? "当前配置已关闭自动修复草稿生成。" : `已达到 ${maxRepairAttempts} 轮自动修复上限。`;
  return [
    "应用后验证仍未通过。",
    "",
    `- 已完成修复轮次：${previousRound}`,
    `- 修复策略：${limitText}`,
    suite.failedCommand ? `- 首个失败命令：\`${suite.failedCommand}\`` : "",
    `- 失败类型：${verifyFailureKindLabel(suite.failureKind)}`,
    "",
    "Patchlane 已停止继续消耗模型调用。请先查看上方验证输出和当前工作区状态，再决定是否手动调整、扩大上下文或重新发起 Agent 任务。"
  ].filter(Boolean).join("\n");
}

function getVerifyFailedCommand(result: VerifyResult | VerifySuiteResult): string | undefined {
  if ("results" in result) {
    return result.failedCommand ?? result.results.find((item) => item.aborted || item.exitCode !== 0)?.command;
  }
  return result.command;
}

function getVerifyFailureKind(result: VerifyResult | VerifySuiteResult): string | undefined {
  const kind = "results" in result
    ? result.failureKind
    : result.failureKind;
  return kind ? verifyFailureKindLabel(kind) : undefined;
}

function getVerifyFailureSummary(result: VerifyResult | VerifySuiteResult): string | undefined {
  if ("results" in result) {
    const failed = result.results.find((item) => item.aborted || item.exitCode !== 0);
    return failed?.summary ?? (result.passed ? "验证通过" : verifyFailureKindLabel(result.failureKind));
  }
  return result.summary ?? verifyFailureKindLabel(result.failureKind ?? "unknown");
}

function buildVerifyFixPrompt(result: VerifyResult | VerifySuiteResult): string {
  const failureStrategy = createFailureStrategyFromVerify(result);
  if ("results" in result) {
    const failed = result.results.find((item) => item.aborted || item.exitCode !== 0);
    const output = result.results.map((item) => [
      `$ ${item.command}`,
      `exit ${item.exitCode ?? "n/a"} · ${item.summary ?? ""}`,
      item.output
    ].join("\n")).join("\n\n");
    return [
      "请根据当前工作区上下文修复验证失败。",
      "",
      `验证套件：${result.results.length}/${result.commands.length} 条命令，首个失败类型：${verifyFailureKindLabel(result.failureKind)}`,
      failed ? `失败命令：${failed.command}` : "",
      failed ? `退出码：${failed.exitCode ?? "n/a"}` : "",
      failed?.failureKind ? `失败类型：${verifyFailureKindLabel(failed.failureKind)}` : "",
      failed?.summary ? `失败摘要：${failed.summary}` : "",
      "",
      "失败修正策略：",
      formatFailureStrategyForPrompt(failureStrategy),
      "",
      "失败输出：",
      "```text",
      compactHistoryText(output, getAgentContextBudget().verifyOutputChars),
      "```",
      "",
      "要求：",
      "- 只修复导致验证失败的直接问题。",
      "- 保持修改最小且可审查。",
      "- 输出可确认的 unified diff 草稿，不要直接写入文件。",
      "- 如果失败不是代码问题，请在计划中说明原因和需要用户处理的事项。",
      "- 按上面的失败修正策略行动，不要把任务扩大成重写整个模块。"
    ].filter(Boolean).join("\n");
  }

  return [
    "请根据当前工作区上下文修复验证失败。",
    "",
    `失败命令：${result.command}`,
    `退出码：${result.exitCode ?? "n/a"}`,
    result.failureKind ? `失败类型：${verifyFailureKindLabel(result.failureKind)}` : "",
    result.summary ? `失败摘要：${result.summary}` : "",
    "",
    "失败修正策略：",
    formatFailureStrategyForPrompt(failureStrategy),
    "",
    "失败输出：",
    "```text",
    compactHistoryText(result.output, getAgentContextBudget().verifyOutputChars),
    "```",
    "",
    "要求：",
    "- 只修复导致验证失败的直接问题。",
    "- 保持修改最小且可审查。",
    "- 输出可确认的 unified diff 草稿，不要直接写入文件。",
    "- 如果失败不是代码问题，请在计划中说明原因和需要用户处理的事项。",
    "- 按上面的失败修正策略行动，不要把任务扩大成重写整个模块。"
  ].filter(Boolean).join("\n");
}

function verifyFailureKindLabel(kind: VerifyResult["failureKind"] | VerifySuiteResult["failureKind"]): string {
  switch (kind) {
    case "pass":
      return "验证通过";
    case "typescript":
      return "类型检查";
    case "test":
      return "测试失败";
    case "lint":
      return "代码规范";
    case "build":
      return "构建失败";
    case "missingDependency":
      return "依赖或命令缺失";
    case "runtime":
      return "运行时错误";
    case "timeout":
      return "超时";
    case "aborted":
      return "已停止";
    default:
      return "未知失败";
  }
}

function searchSourceHintLabel(value: WebSearchResponse["sourceHint"]): string {
  switch (value) {
    case "docs":
      return "官方文档优先";
    case "news":
      return "最新消息优先";
    case "github":
      return "GitHub 优先";
    default:
      return "通用搜索";
  }
}

function formatPatchReadyMessage(draft: Awaited<ReturnType<PatchWorkflowService["generatePatch"]>>): string {
  return [
    `已生成 ${draft.fileCount} 个文件的修改草稿。`,
    "",
    "执行计划：",
    draft.plan
      ? [
          `- ${draft.plan.summary}`,
          ...(draft.plan.files.length > 0 ? draft.plan.files.map((file) => `- ${file.operation ?? "modify"} ${file.path}：${file.reason}`) : ["- 未明确文件"]),
          ...(draft.plan.steps.length > 0 ? ["", "步骤：", ...draft.plan.steps.map((step) => `- ${step}`)] : []),
          ...(draft.plan.verification.length > 0 ? ["", "验证：", ...draft.plan.verification.map((step) => `- ${step}`)] : [])
        ].join("\n")
      : "- 未生成结构化计划",
    "",
    "请切换到“修改结果”页面查看每个文件的改动，确认后再应用到项目。",
    "",
    draft.files.map((file) => `- ${file}`).join("\n")
  ].join("\n");
}

function formatDuration(durationMs: number): string {
  if (!Number.isFinite(durationMs) || durationMs < 0) {
    return "未知";
  }
  if (durationMs < 1000) {
    return `${durationMs}ms`;
  }
  return `${(durationMs / 1000).toFixed(1)}s`;
}

function buildHelpText(): string {
  return [
    "Patchlane 可用指令：",
    "",
    "/explain - 解释当前选中代码或当前文件",
    "/fix - 为当前选中代码生成修改草稿",
    "/fix <需求> - 根据描述生成修复草稿",
    "/tests <需求> - 生成或更新测试",
    "/patch <需求> - 生成可确认的文件修改",
    "/verify - 运行配置好的验证命令",
    "/web <关键词> - 联网搜索最新文档和资料",
    "/index - 生成轻量工作区索引",
    "/clear - 清空当前会话",
    "",
    "在输入框点击加号选择文件，也可以手动输入 @path/to/file.ts 引用工作区文件。"
  ].join("\n");
}

function getNonce(): string {
  const possible = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let text = "";
  for (let index = 0; index < 32; index++) {
    text += possible.charAt(Math.floor(Math.random() * possible.length));
  }
  return text;
}
