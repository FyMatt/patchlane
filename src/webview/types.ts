export type ChatMode = "chat" | "agent";
export type TranscriptKind = "chat" | "codeExplanation" | "local" | "agentProgress" | "webSearch" | "taskInterrupted";
export type ProgressStatus = "pending" | "running" | "done" | "error";

export interface ProgressStep {
  label: string;
  status: ProgressStatus;
  detail?: string;
  kind?: "think" | "tool" | "file" | "approval" | "model" | "patch" | "verify";
  startedAt?: string;
  endedAt?: string;
}

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

export interface TranscriptItem {
  role: "user" | "assistant";
  content: string;
  model?: string;
  mode?: ChatMode;
  createdAt?: string;
  skillIds?: string[];
  toolIds?: string[];
  kind?: TranscriptKind;
  title?: string;
  file?: string;
  selection?: string;
  sources?: WebSearchSource[];
  status?: Exclude<ProgressStatus, "pending">;
  progressSteps?: ProgressStep[];
}

export interface WebSearchSource {
  title: string;
  url: string;
  snippet?: string;
  source?: string;
  publishedAt?: string;
  updatedAt?: string;
  trustLabel?: "official" | "docs" | "github" | "news" | "community" | "unknown";
  citation?: string;
  isOfficial?: boolean;
}

export interface ChatSession {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  messages: TranscriptItem[];
  taskState?: ChatSessionTaskState;
  capabilityRuns?: CapabilityRunRecord[];
}

export interface ChatSessionTaskState {
  kind: "chat" | "agent" | "apply" | "verify" | "capability" | "web";
  label: string;
  updatedAt: string;
}

export type CapabilityRunStatus = "success" | "failed" | "rejected" | "error" | "stopped";

export interface CapabilityRunRecord {
  id: string;
  type: "skill" | "tool";
  capabilityId: string;
  label: string;
  capabilityKind?: "builtin" | "custom" | "mcp";
  source: "settings" | "agent";
  status: CapabilityRunStatus;
  summary: string;
  command?: string;
  cwd?: string;
  inputSummary?: string;
  exitCode?: number | null;
  stdout?: string;
  stderr?: string;
  durationMs?: number;
  createdAt: string;
}

export interface PatchDraft {
  id: string;
  request: string;
  model: string;
  createdAt: string;
  patchText: string;
  fileCount: number;
  files: string[];
  plan?: PatchPlan;
  quality?: PatchQualityReport;
  repairOf?: string;
  repairError?: string;
  verifyRepair?: PatchVerifyRepairInfo;
  stage?: PatchDraftStageInfo;
}

export interface PatchDraftStageInfo {
  taskId: string;
  phaseId: string;
  phaseIndex: number;
  phaseCount: number;
  phaseTitle: string;
  attempt: number;
}

export type PatchDraftStatus = "generating" | "reviewing" | "repairing" | "stopped" | "failed";

export interface PatchVerifyRepairInfo {
  round: number;
  maxRounds: number;
  source: "manualVerify" | "postApply";
  failedCommand?: string;
  failureKind?: string;
  summary?: string;
  createdAt: string;
}

export interface PatchPlan {
  summary: string;
  riskLevel?: "low" | "medium" | "high";
  files: PatchPlanFile[];
  checkpoints?: PatchPlanCheckpoint[];
  steps: string[];
  acceptanceCriteria: string[];
  verification: string[];
  risks: string[];
  contextGaps: string[];
  assumptions: string[];
}

export interface PatchPlanFile {
  path: string;
  reason: string;
  operation?: "create" | "modify" | "delete";
}

export interface PatchPlanCheckpoint {
  id: string;
  title: string;
  files: string[];
  acceptanceCriteria: string[];
  verification: string[];
}

export type PatchQualityStatus = "pass" | "warn" | "fail";

export interface PatchQualityCheck {
  id: string;
  label: string;
  status: PatchQualityStatus;
  detail: string;
}

export interface PatchQualityReport {
  status: PatchQualityStatus;
  summary: string;
  checks: PatchQualityCheck[];
  reviewModel?: string;
  repaired?: boolean;
}

export interface PatchState {
  pendingPatch?: PatchDraft;
  activeDraft?: PatchDraft;
  activeDraftStatus?: PatchDraftStatus;
  activeDraftDetail?: string;
  lastAppliedPatch?: PatchDraft;
  lastBackupId?: string;
  lastApplyError?: string;
  repairCount: number;
  stagedTask?: StagedTaskState;
}

export type StagedTaskStatus = "active" | "failed" | "done";
export type StagedTaskPhaseStatus = "pending" | "generating" | "ready" | "applied" | "verifying" | "failed" | "done";

export interface StagedTaskState {
  id: string;
  request: string;
  plan: PatchPlan;
  status: StagedTaskStatus;
  currentPhaseIndex: number;
  phaseCount: number;
  phases: StagedTaskPhase[];
  createdAt: string;
  updatedAt: string;
}

export interface StagedTaskPhase {
  id: string;
  title: string;
  files: string[];
  acceptanceCriteria: string[];
  verification: string[];
  status: StagedTaskPhaseStatus;
  attempt: number;
  draftId?: string;
  patchFiles?: string[];
  failureReason?: string;
  startedAt?: string;
  completedAt?: string;
  updatedAt: string;
}

export interface EditorContextSummary {
  file?: string;
  selection?: string;
  language?: string;
  hasFile: boolean;
  hasSelection: boolean;
  workspace?: string;
}

export interface WorkspaceFileSummary {
  path: string;
  languageId: string;
  lineCount: number;
  source?: "active" | "open" | "workspace";
}

export interface AgentCapability {
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

export interface McpDiscoveredTool {
  name: string;
  label: string;
  description: string;
}

export interface McpDiscoveredResource {
  uri: string;
  name: string;
  description?: string;
  mimeType?: string;
}

export interface McpDiscoveredPrompt {
  name: string;
  label: string;
  description?: string;
  arguments?: McpDiscoveredPromptArgument[];
}

export interface McpDiscoveredPromptArgument {
  name: string;
  description?: string;
  required?: boolean;
}

export interface McpDiscoveredServerCatalog {
  name: string;
  tools: McpDiscoveredTool[];
  resources: McpDiscoveredResource[];
  prompts: McpDiscoveredPrompt[];
}

export interface AgentCapabilityState {
  skills: AgentCapability[];
  tools: AgentCapability[];
}

export interface WebSearchSettings {
  enabled: boolean;
  provider: string;
  baseUrl: string;
  maxResults: number;
  defaultRecencyDays?: number;
  allowedDomains: string[];
  blockedDomains: string[];
  requireApproval: boolean;
}

export interface AgentRuntimeSettings {
  contextBudget: "economy" | "balanced" | "quality";
  maxRepairAttempts: number;
  maxToolRounds: number;
}

export type CapabilityDiagnosticSeverity = "info" | "warning" | "error";

export interface CapabilityDiagnostic {
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

export interface ApprovalSnapshot {
  trustedTools: string[];
  trustedSkills: string[];
  trustedCommands: string[];
}

export type ApprovalKind = "tool" | "command" | "skill" | "web";
export type ApprovalDecision = "approveOnce" | "approveSession" | "reject";

export interface ApprovalPrompt {
  id: string;
  kind: ApprovalKind;
  sessionId: string;
  targetId: string;
  label: string;
  reason?: string;
  command?: string;
  cwd?: string;
  script?: string;
  query?: string;
  provider?: string;
  allowDomains?: string[];
  rememberable: boolean;
}

export interface ExtensionState {
  type?: "state";
  view?: "sessions" | "chat";
  activeModel?: ActiveModel;
  models: ModelOption[];
  session?: ChatSession;
  sessions: ChatSession[];
  transcript: TranscriptItem[];
  patch: PatchState;
  context: EditorContextSummary;
  workspaceFiles: WorkspaceFileSummary[];
  capabilities?: AgentCapabilityState;
  mcpServers?: McpServerSummary[];
  mcpCatalog?: McpDiscoveredServerCatalog[];
  webSearch?: WebSearchSettings;
  agentSettings?: AgentRuntimeSettings;
  capabilityDiagnostics?: CapabilityDiagnostic[];
  approvals?: ApprovalSnapshot;
  pendingApprovals?: ApprovalPrompt[];
  busy: boolean;
  busyLabel?: string;
}

export type WebviewCommand =
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
  | "continueStagedTask"
  | "retryStagedPhase"
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

export interface WebviewMessage {
  type: WebviewCommand;
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
