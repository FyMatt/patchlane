import React, { useEffect, useMemo, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  Check,
  CheckCircle2,
  Copy,
  FileCode2,
  FileDiff,
  FolderSearch,
  Hammer,
  AlertTriangle,
  Info,
  KeyRound,
  Layers,
  Loader2,
  MessageSquare,
  MessageSquarePlus,
  Pencil,
  Play,
  Plus,
  RefreshCw,
  Globe,
  RotateCcw,
  Save,
  Search,
  SearchCode,
  Send,
  Settings2,
  ShieldCheck,
  Sparkles,
  Square,
  Trash2,
  Wand2,
  Workflow,
  X,
  Zap
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import Prism from "prismjs";
import "prismjs/components/prism-bash";
import "prismjs/components/prism-diff";
import "prismjs/components/prism-json";
import "prismjs/components/prism-jsx";
import "prismjs/components/prism-markdown";
import "prismjs/components/prism-python";
import "prismjs/components/prism-tsx";
import "prismjs/components/prism-typescript";
import { useCodeAgentStore } from "./store";
import { AgentCapability, ApprovalDecision, ApprovalPrompt, CapabilityDiagnostic, CapabilityRunRecord, McpDiscoveredPrompt, McpDiscoveredServerCatalog, McpServerSummary, ModelOption, PatchDraft, PatchDraftStatus, PatchPlan, PatchQualityReport, TranscriptItem, WebSearchSource, WorkspaceFileSummary } from "./types";
import { classNames, extractCodeText, formatProvider, formatTime, formatWebSearchProvider, postCommand, routePrompt } from "./utils";

interface ActionItem {
  id: string;
  label: string;
  description: string;
  command: Parameters<typeof postCommand>[0];
  icon: LucideIcon;
  requiresFile?: boolean;
  requiresPatch?: boolean;
  requiresBackup?: boolean;
  requiresStagedTask?: boolean;
  requiresFailedStage?: boolean;
}

interface PatchFilePreview {
  id: string;
  label: string;
  path: string;
  operation: "create" | "modify" | "delete" | "rename";
  additions: number;
  deletions: number;
  hunks: number;
  rawLines: string[];
}

interface ChoiceItem {
  id: string;
  label: string;
  description: string;
  icon: LucideIcon;
  kind?: "builtin" | "custom" | "mcp";
  command?: string;
  server?: string;
  script?: string;
  runtime?: AgentCapability["runtime"];
  args?: string[];
}

interface MessageContext {
  content: string;
  skills: string[];
  tools: string[];
}

type MainPanel = "chat" | "changes" | "settings";
type VisibleMainPanel = MainPanel;
type ComposerMenu = "files" | "skills" | "tools" | undefined;
type ChangeStatus = "ready" | "applied" | "empty" | PatchDraftStatus;

const modeOptions = [
  { id: "chat" as const, label: "聊天", description: "只回答问题，不写文件" },
  { id: "agent" as const, label: "Agent", description: "生成可确认的文件修改" }
];

const mainTabs: Array<{ id: VisibleMainPanel; label: string; description: string; icon: LucideIcon }> = [
  { id: "chat", label: "对话", description: "聊天和 Agent 执行流", icon: MessageSquare },
  { id: "changes", label: "修改结果", description: "查看文件改动", icon: FileDiff },
  { id: "settings", label: "设置", description: "模型、密钥、Skill 和 MCP", icon: Settings2 }
];

const patchActions: ActionItem[] = [
  { id: "preview", label: "完整预览", description: "在 VS Code 中打开完整 diff", command: "previewPatch", icon: FileDiff, requiresPatch: true },
  { id: "apply", label: "应用修改", description: "把确认后的修改写入项目文件", command: "applyPatch", icon: Check, requiresPatch: true },
  { id: "verify", label: "运行验证", description: "运行配置好的验证命令并记录结果", command: "runSessionVerify", icon: Play },
  { id: "verify-fix", label: "验证并修复", description: "验证失败时自动生成新的修复草稿", command: "verifyAndFix", icon: ShieldCheck },
  { id: "continue-stage", label: "继续阶段", description: "生成下一个阶段的独立 diff", command: "continueStagedTask", icon: Workflow, requiresStagedTask: true },
  { id: "retry-stage", label: "续跑阶段", description: "重新生成当前失败阶段的 diff", command: "retryStagedPhase", icon: RefreshCw, requiresFailedStage: true },
  { id: "hunks", label: "部分应用", description: "选择要应用的部分修改", command: "applySelectedPatchHunks", icon: Layers, requiresPatch: true },
  { id: "discard", label: "放弃草稿", description: "放弃当前待确认修改", command: "discardPatch", icon: Trash2, requiresPatch: true },
  { id: "rollback", label: "撤回上次", description: "恢复上一次应用修改前的状态", command: "rollbackPatch", icon: RotateCcw, requiresBackup: true }
];

const promptTemplates = [
  { label: "修复问题", value: "请帮我修复当前代码里的问题。", mode: "agent" as const },
  { label: "解释代码", value: "请解释当前打开的代码。", mode: "chat" as const },
  { label: "生成测试", value: "请为当前功能补充单元测试。", mode: "agent" as const },
  { label: "重构优化", value: "请帮我重构这段代码，让它更清晰可靠。", mode: "agent" as const }
];

const skillOptions: ChoiceItem[] = [
  { id: "review", label: "代码审查", description: "检查可读性、边界条件和潜在缺陷", icon: SearchCode, kind: "builtin" },
  { id: "debug", label: "调试分析", description: "围绕报错、日志和复现路径定位问题", icon: Zap, kind: "builtin" },
  { id: "tests", label: "测试生成", description: "补充单元测试、集成测试或验证步骤", icon: ShieldCheck, kind: "builtin" },
  { id: "docs", label: "文档生成", description: "生成注释、README 或使用说明", icon: MessageSquare, kind: "builtin" },
  { id: "perf", label: "性能优化", description: "分析热点路径和资源消耗", icon: Wand2, kind: "builtin" },
  { id: "security", label: "安全检查", description: "检查输入校验、权限和敏感信息风险", icon: KeyRound, kind: "builtin" },
  { id: "engineering-plan", label: "工程化计划", description: "拆分阶段、边界、验收和验证策略", icon: Workflow, kind: "builtin" },
  { id: "refactor", label: "重构迁移", description: "按兼容层、调用点、测试和清理顺序推进", icon: Wand2, kind: "builtin" },
  { id: "quality-gate", label: "质量门禁", description: "强化风险、回滚、测试覆盖和发布前检查", icon: ShieldCheck, kind: "builtin" }
];

const toolOptions: ChoiceItem[] = [
  { id: "files", label: "文件读写", description: "允许 Agent 基于工作区文件生成修改草稿", icon: FileCode2, kind: "builtin" },
  { id: "terminal", label: "终端命令", description: "用于构建、测试、格式化和诊断", icon: Play, kind: "builtin" },
  { id: "search", label: "搜索分析", description: "用于检索代码、日志和上下文线索", icon: Search, kind: "builtin" },
  { id: "web-search", label: "联网搜索", description: "搜索最新官方文档、错误信息、Release 和网页资料", icon: Globe, kind: "builtin" },
  { id: "docs-search", label: "官方文档", description: "优先搜索官方文档、API Reference 和 SDK 说明", icon: SearchCode, kind: "builtin" },
  { id: "github-search", label: "GitHub", description: "优先搜索仓库、Issue、Release 和 Discussion", icon: FolderSearch, kind: "builtin" },
  { id: "news-search", label: "最新消息", description: "优先搜索 Release、Changelog 和近期公告", icon: RefreshCw, kind: "builtin" },
  { id: "tests", label: "测试运行器", description: "执行配置好的验证命令", icon: ShieldCheck, kind: "builtin" },
  { id: "task-plan", label: "任务编排", description: "维护阶段、多 diff 和失败续跑状态", icon: Workflow, kind: "builtin" },
  { id: "repo-map", label: "仓库地图", description: "提供低 token 的项目结构和关键文件摘要", icon: FolderSearch, kind: "builtin" },
  { id: "quality-gate", label: "质量门禁", description: "检查计划、diff 范围、风险和验证", icon: ShieldCheck, kind: "builtin" },
  { id: "failure-memory", label: "失败记忆", description: "召回历史验证失败和修复策略", icon: RefreshCw, kind: "builtin" },
  { id: "mcp", label: "MCP 工具", description: "连接 MCP 协议的外部工具", icon: Layers, kind: "mcp" },
  { id: "custom", label: "自定义工具", description: "预留团队内部工具或业务系统入口", icon: Settings2, kind: "custom" }
];

function getSkillChoices(items?: AgentCapability[]): ChoiceItem[] {
  return items && items.length > 0 ? items.map((item) => capabilityToChoiceItem(item, "skill")) : skillOptions;
}

function getToolChoices(items?: AgentCapability[]): ChoiceItem[] {
  return items && items.length > 0 ? items.map((item) => capabilityToChoiceItem(item, "tool")) : toolOptions;
}

function capabilityToChoiceItem(item: AgentCapability, group: "skill" | "tool"): ChoiceItem {
  return {
    id: item.id,
    label: item.label,
    description: item.description,
    kind: item.kind ?? "custom",
    command: item.command,
    server: item.server,
    script: item.script,
    runtime: item.runtime,
    args: item.args,
    icon: iconForCapability(item, group)
  };
}

function iconForCapability(item: Pick<AgentCapability, "id" | "kind">, group: "skill" | "tool"): LucideIcon {
  if (item.kind === "mcp") {
    return Layers;
  }

  if (group === "skill") {
    switch (item.id) {
      case "review":
        return SearchCode;
      case "debug":
        return Zap;
      case "tests":
        return ShieldCheck;
      case "docs":
        return MessageSquare;
      case "perf":
        return Wand2;
    case "security":
      return KeyRound;
    case "engineering-plan":
      return Workflow;
    case "refactor":
      return Wand2;
    case "quality-gate":
      return ShieldCheck;
    default:
      return Wand2;
  }
  }

  switch (item.id) {
    case "files":
      return FileCode2;
    case "terminal":
      return Play;
    case "search":
    case "web-search":
      return Search;
    case "docs-search":
      return SearchCode;
    case "github-search":
      return FolderSearch;
    case "news-search":
      return RefreshCw;
    case "tests":
      return ShieldCheck;
    case "task-plan":
    case "staged-task":
      return Workflow;
    case "repo-map":
      return FolderSearch;
    case "quality-gate":
      return ShieldCheck;
    case "failure-memory":
      return RefreshCw;
    case "mcp":
      return Layers;
    case "custom":
      return Settings2;
    default:
      return Settings2;
  }
}

function capabilityKindLabel(kind?: ChoiceItem["kind"]): string {
  switch (kind) {
    case "builtin":
      return "内置";
    case "mcp":
      return "MCP";
    case "custom":
      return "自定义";
    default:
      return "扩展";
  }
}

export function CodeAgentApp(): JSX.Element {
  const { extensionState, setExtensionState } = useCodeAgentStore();

  useEffect(() => {
    const handleMessage = (event: MessageEvent) => {
      if (event.data?.type === "state") {
        setExtensionState(event.data);
      }
    };

    window.addEventListener("message", handleMessage);
    postCommand("ready");
    return () => window.removeEventListener("message", handleMessage);
  }, [setExtensionState]);

  return extensionState.view === "chat" ? <ChatWorkspace /> : <SessionSidebar />;
}

function SessionSidebar(): JSX.Element {
  const { extensionState } = useCodeAgentStore();
  const [query, setQuery] = useState("");
  const sessions = extensionState.sessions.filter((session) => session.title.toLowerCase().includes(query.toLowerCase()));
  const workspaceName = extensionState.context.workspace ?? "当前工作区";

  return (
    <div className="session-shell">
      <header className="session-header">
        <div>
          <span className="eyebrow">工作区会话</span>
          <h1>{workspaceName}</h1>
        </div>
        <button type="button" title="新建会话" aria-label="新建会话" onClick={() => postCommand("newSession")}>
          <MessageSquarePlus size={16} />
        </button>
      </header>

      <div className="session-model">
        <ModelSelect activeModel={extensionState.activeModel} models={extensionState.models} compact />
      </div>

      <label className="session-search">
        <Search size={14} />
        <input value={query} placeholder="搜索历史会话" onChange={(event) => setQuery(event.target.value)} />
      </label>

      <section className="session-list" aria-label="工作区历史会话">
        {sessions.length === 0 ? (
          <div className="session-empty">
            <MessageSquare size={18} />
            <strong>暂无会话</strong>
            <span>新建一个会话，开始让 AI 帮你读代码、解释代码或生成修改。</span>
            <button type="button" onClick={() => postCommand("newSession")}>
              <Plus size={14} />
              新建会话
            </button>
          </div>
        ) : sessions.map((session) => (
          <article key={session.id} className="session-card" onClick={() => postCommand("openSession", { sessionId: session.id })}>
            <div className="session-card-main">
              <strong title={session.title}>{session.title}</strong>
              <span>{session.messages.length} 条消息 · {formatTime(session.updatedAt)}</span>
            </div>
            <button
              type="button"
              title="删除会话"
              aria-label="删除会话"
              onClick={(event) => {
                event.stopPropagation();
                postCommand("deleteSession", { sessionId: session.id });
              }}
            >
              <Trash2 size={13} />
            </button>
          </article>
        ))}
      </section>

      <footer className="session-footer">
        <button type="button" onClick={() => postCommand("newSession")}>
          <Plus size={14} />
          新建会话
        </button>
        <button type="button" onClick={() => postCommand("setApiKey")}>
          <KeyRound size={14} />
          设置密钥
        </button>
      </footer>
    </div>
  );
}

function ChatWorkspace(): JSX.Element {
  const { extensionState, activePanel, setActivePanel } = useCodeAgentStore();
  const pendingPatch = extensionState.patch.pendingPatch;
  const activeDraft = extensionState.patch.activeDraft;
  const workspaceName = extensionState.context.workspace ?? "当前工作区";
  const sessionTitle = extensionState.session?.title ?? "新会话";

  useEffect(() => {
    if (pendingPatch || activeDraft) {
      setActivePanel("changes");
    }
  }, [pendingPatch?.id, activeDraft?.id, setActivePanel]);

  return (
    <div className="chat-shell">
      <aside className="workbench-rail" aria-label="工作区导航">
        <div className="rail-brand">
          <span className="product-mark">
            <Hammer size={17} />
          </span>
          <div>
            <strong>Patchlane</strong>
            <span>{workspaceName}</span>
          </div>
        </div>

        <div className="rail-scroll">
          <span className="rail-section-label">工作台</span>
          <nav className="main-tabs" aria-label="主页面切换">
            {mainTabs.map((item) => {
              const Icon = item.icon;
              return (
                <button
                  key={item.id}
                  type="button"
                  className={classNames(activePanel === item.id && "is-active")}
                  title={item.description}
                  onClick={() => setActivePanel(item.id)}
                >
                  <Icon size={15} />
                  <span>
                    <strong>{item.label}</strong>
                    <small>{item.description}</small>
                  </span>
                  {item.id === "changes" && (pendingPatch || activeDraft) ? <span className={classNames("tab-dot", activeDraft && "is-live")} /> : null}
                </button>
              );
            })}
          </nav>
        </div>

        <div className="rail-footer">
          <span>当前模式</span>
          <strong>{extensionState.busy ? extensionState.busyLabel ?? "处理中" : "就绪"}</strong>
        </div>
      </aside>

      <section className="workbench-main">
        <header className="chat-header">
          <div className="chat-title">
            <span className="page-mark">
              {activePanel === "changes" ? <FileDiff size={16} /> : activePanel === "settings" ? <Settings2 size={16} /> : <MessageSquare size={16} />}
            </span>
            <div>
              <strong>{activePanel === "changes" ? "修改结果" : activePanel === "settings" ? "设置" : sessionTitle}</strong>
              <span>{activePanel === "chat" ? "Enter 发送，Ctrl + Enter 换行" : activePanel === "changes" ? activeDraft ? "正在实时接收修改" : "确认后才会写入工作区" : "模型、密钥、Skill 和 MCP"}</span>
            </div>
          </div>
          <div className="chat-header-actions">
            <RunStatus />
          </div>
        </header>

        <div className="chat-body">
          <ApprovalRail />
          {activePanel === "chat" ? <ChatPanelPage /> : null}
          {activePanel === "changes" ? <ChangesPanel /> : null}
          {activePanel === "settings" ? <SettingsPanel /> : null}
        </div>
      </section>
    </div>
  );
}

function ChatPanelPage(): JSX.Element {
  const { extensionState, setActivePanel } = useCodeAgentStore();

  return (
    <main className="chat-main">
      <Conversation />
      {extensionState.patch.pendingPatch || extensionState.patch.activeDraft ? (
        <PatchNotice onOpen={() => setActivePanel("changes")} />
      ) : null}
      <SelectionActionBar />
      <Composer busy={extensionState.busy} />
    </main>
  );
}

function SelectionActionBar(): JSX.Element | null {
  const { extensionState } = useCodeAgentStore();
  if (!extensionState.context.hasSelection) {
    return null;
  }

  return (
    <section className="selection-action-bar" aria-label="当前选区操作">
      <div>
        <SearchCode size={15} />
        <span>{extensionState.context.file ?? "当前文件"} · {extensionState.context.selection ?? "已选中代码"}</span>
      </div>
      <button type="button" onClick={() => postCommand("explainInline")}>
        <MessageSquare size={14} />
        解释选中代码
      </button>
      <button type="button" onClick={() => postCommand("patchSelection")}>
        <Wand2 size={14} />
        修改选中代码
      </button>
    </section>
  );
}

function ModelSelect({ activeModel, models, compact = false }: { activeModel?: { providerId: string; modelId: string; label: string }; models: ModelOption[]; compact?: boolean }): JSX.Element {
  const selectedValue = activeModel ? `${activeModel.providerId}::${activeModel.modelId}` : "";

  return (
    <label className={classNames("model-select", compact && "is-compact")}>
      {!compact ? <span>模型</span> : null}
      <select
        value={selectedValue}
        onChange={(event) => {
          const [providerId, modelId] = event.target.value.split("::");
          postCommand("switchModel", { providerId, modelId });
        }}
      >
        {models.map((model) => (
          <option key={`${model.providerId}:${model.modelId}`} value={`${model.providerId}::${model.modelId}`}>
            {model.label}
          </option>
        ))}
      </select>
    </label>
  );
}

function RunStatus(): JSX.Element {
  const { extensionState } = useCodeAgentStore();
  const taskState = extensionState.session?.taskState;
  return (
    <div className={classNames("run-status", extensionState.busy && "is-busy")}>
      {extensionState.busy ? <Loader2 size={13} className="spin" /> : <ShieldCheck size={13} />}
      <span>
        {extensionState.busy ? extensionState.busyLabel ?? "处理中" : "就绪"}
        {extensionState.busy && taskState ? <small>{taskKindLabel(taskState.kind)}</small> : null}
      </span>
    </div>
  );
}

function Conversation(): JSX.Element {
  const { extensionState } = useCodeAgentStore();
  const streamRef = useRef<HTMLDivElement | null>(null);
  const transcript = extensionState.transcript;

  useEffect(() => {
    const node = streamRef.current;
    if (node) {
      node.scrollTop = node.scrollHeight;
    }
  }, [transcript.length, transcript.at(-1)?.content]);

  return (
    <section className="conversation" ref={streamRef} aria-label="对话">
      {transcript.length === 0 ? <EmptyState /> : transcript.map((item, index) => <MessageBubble key={`${item.createdAt ?? index}-${index}`} item={item} index={index} />)}
    </section>
  );
}

function EmptyState(): JSX.Element {
  const { extensionState, setDraft, setActiveMode } = useCodeAgentStore();

  return (
    <div className="empty-workbench">
      <div className="empty-hero">
        <div className="empty-icon">
          <Hammer size={22} />
        </div>
        <div>
          <span className="eyebrow">Patchlane</span>
          <h1>告诉我你想完成什么</h1>
          <p>选择模型、填写 API Key，然后直接描述需求。聊天模式用于解释和分析，Agent 模式会生成可确认的文件修改。</p>
        </div>
      </div>

      <div className="agent-command-grid">
        <button type="button" className="command-tile is-primary" disabled={!extensionState.context.hasFile} onClick={() => postCommand("patchSelection")}>
          <Wand2 size={17} />
          <span>
            <strong>修改当前代码</strong>
            <small>{extensionState.context.selection ?? extensionState.context.file ?? "先打开一个文件"}</small>
          </span>
        </button>
        <button
          type="button"
          className="command-tile"
          onClick={() => {
            setActiveMode("agent");
            setDraft("请帮我实现：");
          }}
        >
          <FileDiff size={17} />
          <span>
            <strong>描述一个需求</strong>
            <small>例如：优化登录表单校验并补充测试</small>
          </span>
        </button>
        <button type="button" className="command-tile" disabled={!extensionState.context.hasFile} onClick={() => postCommand("explainSelection")}>
          <SearchCode size={17} />
          <span>
            <strong>解释当前代码</strong>
            <small>{extensionState.context.file ?? "先打开一个文件"}</small>
          </span>
        </button>
        <button
          type="button"
          className="command-tile"
          onClick={() => {
            setActiveMode("chat");
            setDraft("请帮我分析当前项目，找出需要优化或修复的地方。");
          }}
        >
          <MessageSquare size={17} />
          <span>
            <strong>分析项目</strong>
            <small>从当前文件和引用文件开始</small>
          </span>
        </button>
      </div>

      <div className="simple-guide">
        <div><KeyRound size={15} /><span>底部选择模型并设置密钥</span></div>
        <div><Plus size={15} /><span>需要时引用文件</span></div>
        <div><Zap size={15} /><span>选择 Skill 和工具</span></div>
        <div><Check size={15} /><span>确认后应用修改</span></div>
      </div>
    </div>
  );
}

function MessageBubble({ item, index }: { item: TranscriptItem; index: number }): JSX.Element {
  const { extensionState } = useCodeAgentStore();
  const [isEditing, setIsEditing] = useState(false);
  const [draft, setDraft] = useState(item.content);
  const isUser = item.role === "user";
  const displayMode = item.mode === "agent" ? "Agent 模式" : item.mode === "chat" ? "聊天模式" : undefined;
  const isExplanationCard = item.kind === "codeExplanation";
  const isAgentProgress = item.kind === "agentProgress";
  const isWebSearch = item.kind === "webSearch";
  const isTaskInterrupted = item.kind === "taskInterrupted";
  const skillChoices = useMemo(() => getSkillChoices(extensionState.capabilities?.skills), [extensionState.capabilities?.skills]);
  const toolChoices = useMemo(() => getToolChoices(extensionState.capabilities?.tools), [extensionState.capabilities?.tools]);
  const messageContext = useMemo(() => {
    const parsed = extractMessageContext(item.content);
    const skillLabels = item.skillIds ? labelChoices(item.skillIds, skillChoices) : [];
    const toolLabels = item.toolIds ? labelChoices(item.toolIds, toolChoices) : [];
    return {
      content: parsed.content,
      skills: uniqueLabels([...skillLabels, ...parsed.skills]),
      tools: uniqueLabels([...toolLabels, ...parsed.tools])
    };
  }, [item.content, item.skillIds, item.toolIds, skillChoices, toolChoices]);

  useEffect(() => setDraft(item.content), [item.content]);

  if (isAgentProgress) {
    return <AgentProgressCard item={item} index={index} />;
  }

  if (isWebSearch) {
    return <WebSearchCard item={item} index={index} />;
  }

  if (isTaskInterrupted) {
    return <TaskInterruptedCard item={item} index={index} transcript={extensionState.transcript} />;
  }

  if (isExplanationCard) {
    return (
      <article className="code-explanation-card">
        <div className="code-explanation-header">
          <div>
            <span className="code-explanation-kicker">{item.title ?? "代码解释"}</span>
            <strong>{item.file ?? "当前文件"}</strong>
            <span>{item.selection ?? "已选中代码"}</span>
          </div>
          <div className="message-actions">
            {item.model ? <span className="mode-badge">{displayModelName(item.model)}</span> : null}
            {formatTime(item.createdAt) ? <span>{formatTime(item.createdAt)}</span> : null}
            <button type="button" title="复制解释内容" aria-label="复制解释内容" onClick={() => postCommand("copyMessage", { messageIndex: index })}>
              <Copy size={13} />
            </button>
          </div>
        </div>
        {item.skillIds?.length || item.toolIds?.length ? (
          <MessageContextTags
            skills={item.skillIds ? labelChoices(item.skillIds, skillChoices) : []}
            tools={item.toolIds ? labelChoices(item.toolIds, toolChoices) : []}
          />
        ) : null}
        <MarkdownContent content={item.content} />
      </article>
    );
  }

  return (
    <article className={classNames("message-bubble", item.role, item.content.startsWith("Error:") && "is-error")}>
      <div className="message-meta">
        <span>{isUser ? "你" : displayModelName(item.model)}</span>
        <div className="message-actions">
          {displayMode ? <span className="mode-badge">{displayMode}</span> : null}
          {formatTime(item.createdAt) ? <span>{formatTime(item.createdAt)}</span> : null}
          <button type="button" title="复制消息" aria-label="复制消息" onClick={() => postCommand("copyMessage", { messageIndex: index })}>
            <Copy size={13} />
          </button>
          {isUser ? (
            <>
              <button type="button" title="编辑后重发" aria-label="编辑后重发" onClick={() => setIsEditing(true)}>
                <Pencil size={13} />
              </button>
              <button type="button" title="重新发送" aria-label="重新发送" onClick={() => postCommand("resendMessage", { messageIndex: index })}>
                <RefreshCw size={13} />
              </button>
            </>
          ) : null}
        </div>
      </div>
      {isEditing ? (
        <div className="message-editor">
          <textarea value={draft} onChange={(event) => setDraft(event.target.value)} />
          <div className="editor-actions">
            <button type="button" onClick={() => setIsEditing(false)}>
              <X size={13} />
              取消
            </button>
            <button
              type="button"
              className="primary-button"
              onClick={() => {
                setIsEditing(false);
                postCommand("editMessage", { messageIndex: index, text: draft, mode: item.mode });
              }}
            >
              <Play size={13} />
              发送
            </button>
          </div>
        </div>
      ) : (
        <>
          {messageContext.skills.length > 0 || messageContext.tools.length > 0 ? (
            <MessageContextTags skills={messageContext.skills} tools={messageContext.tools} />
          ) : null}
          <MarkdownContent content={messageContext.content} />
        </>
      )}
    </article>
  );
}

function AgentProgressCard({ item, index }: { item: TranscriptItem; index: number }): JSX.Element {
  const status = item.status ?? "running";
  const title = item.title ?? (status === "done" ? "Agent 已完成" : status === "error" ? "Agent 遇到问题" : "Agent 正在工作");
  const steps = item.progressSteps ?? [];
  const detail = item.content.split("\n").slice(1).join("\n").trim();

  return (
    <article className={classNames("agent-progress-card", `is-${status}`)}>
      <header className="agent-progress-header">
        <div>
          <span className="agent-progress-kicker">Patchlane 工作流</span>
          <strong>{title}</strong>
          <span>{status === "running" ? "正在按工程步骤处理任务；会话会持续保存，窗口重开后可查看结果或重试。" : status === "done" ? "修改草稿已生成，等待确认后写入工作区。" : "任务已停止或失败。"}</span>
        </div>
        <div className="agent-progress-actions">
          <span className="agent-status-pill">
            {status === "running" ? <Loader2 size={12} className="spin" /> : status === "done" ? <Check size={12} /> : <X size={12} />}
            {status === "running" ? "执行中" : status === "done" ? "已完成" : "需要处理"}
          </span>
          <button type="button" title="复制执行记录" aria-label="复制执行记录" onClick={() => postCommand("copyMessage", { messageIndex: index })}>
            <Copy size={13} />
          </button>
        </div>
      </header>

      <ol className="agent-step-list">
        {steps.map((step, stepIndex) => (
          <li key={`${step.label}-${stepIndex}`} className={`is-${step.status}`}>
            <span className="agent-step-icon">
              {agentStepIcon(step)}
            </span>
            <div>
              <strong>{step.label}</strong>
              {step.detail ? <span>{step.detail}</span> : null}
            </div>
          </li>
        ))}
      </ol>

      {detail ? (
        <div className="agent-progress-detail">
          {detail.split("、").map((part) => part.trim()).filter(Boolean).slice(0, 8).map((part) => (
            <span key={part}>{part}</span>
          ))}
        </div>
      ) : null}
    </article>
  );
}

function TaskInterruptedCard({ item, index, transcript }: { item: TranscriptItem; index: number; transcript: TranscriptItem[] }): JSX.Element {
  const lastUserIndex = findPreviousUserMessageIndex(transcript, index);
  const canRetry = lastUserIndex !== undefined;

  return (
    <article className="task-interrupted-card">
      <header>
        <div>
          <span className="task-interrupted-kicker">任务恢复</span>
          <strong>{item.title ? `上次任务已中断：${item.title}` : "上次任务已中断"}</strong>
          <span>会话和已生成内容已经保留，运行中的进程在窗口关闭或扩展主机重启后无法继续。</span>
        </div>
        <div className="message-actions">
          <button type="button" title="复制中断记录" aria-label="复制中断记录" onClick={() => postCommand("copyMessage", { messageIndex: index })}>
            <Copy size={13} />
          </button>
        </div>
      </header>
      <MarkdownContent content={item.content} />
      <div className="task-interrupted-actions">
        <button type="button" disabled={!canRetry} onClick={() => canRetry ? postCommand("resendMessage", { messageIndex: lastUserIndex }) : undefined}>
          <RefreshCw size={14} />
          重试上次请求
        </button>
      </div>
    </article>
  );
}

function WebSearchCard({ item, index }: { item: TranscriptItem; index: number }): JSX.Element {
  const sources = item.sources ?? [];
  return (
    <article className="web-search-card">
      <header className="web-search-header">
        <div>
          <span className="web-search-kicker">联网搜索</span>
          <strong>{item.title ?? "搜索结果"}</strong>
          <span>{displayModelName(item.model)} · {formatTime(item.createdAt)}</span>
        </div>
        <button type="button" title="复制搜索结果" aria-label="复制搜索结果" onClick={() => postCommand("copyMessage", { messageIndex: index })}>
          <Copy size={13} />
        </button>
      </header>
      <div className="web-source-list">
        {sources.length > 0 ? sources.map((source, sourceIndex) => (
          <WebSourceItem key={`${source.url}-${sourceIndex}`} source={source} index={sourceIndex} />
        )) : (
          <MarkdownContent content={item.content} />
        )}
      </div>
    </article>
  );
}

function WebSourceItem({ source, index }: { source: WebSearchSource; index: number }): JSX.Element {
  const host = source.source ?? safeHost(source.url) ?? source.url;
  const dateLabel = source.updatedAt ? `更新 ${source.updatedAt}` : source.publishedAt ? `发布 ${source.publishedAt}` : "";
  return (
    <div className="web-source-item" title={source.url}>
      <span className="web-source-rank">{index + 1}</span>
      <span>
        <strong>{source.title}</strong>
        <small>
          <span>{host}</span>
          {source.trustLabel ? <b className={`web-source-trust is-${source.trustLabel}`}>{webTrustText(source.trustLabel)}</b> : null}
          {dateLabel ? <b className="web-source-date">{dateLabel}</b> : null}
        </small>
        {source.snippet ? <em>{source.snippet}</em> : null}
        <span className="web-source-actions">
          <button type="button" onClick={() => postCommand("fetchUrl", { text: source.url })}>读取正文</button>
          <button type="button" onClick={() => postCommand("openUrl", { text: source.url })}>打开链接</button>
        </span>
      </span>
    </div>
  );
}

function webTrustText(value: NonNullable<WebSearchSource["trustLabel"]>): string {
  switch (value) {
    case "official":
      return "官方";
    case "docs":
      return "文档";
    case "github":
      return "GitHub";
    case "news":
      return "新闻";
    case "community":
      return "社区";
    default:
      return "未知";
  }
}

function safeHost(url: string): string | undefined {
  try {
    return new URL(url).hostname;
  } catch {
    return undefined;
  }
}

function agentStepIcon(step: NonNullable<TranscriptItem["progressSteps"]>[number]): React.ReactNode {
  if (step.status === "running") {
    return <Loader2 size={12} className="spin" />;
  }
  if (step.status === "done") {
    return <Check size={12} />;
  }
  if (step.status === "error") {
    return <X size={12} />;
  }

  switch (step.kind) {
    case "approval":
      return <ShieldCheck size={12} />;
    case "file":
      return <FileCode2 size={12} />;
    case "think":
      return <Sparkles size={12} />;
    case "model":
      return <Sparkles size={12} />;
    case "patch":
      return <FileDiff size={12} />;
    case "tool":
      return <Wand2 size={12} />;
    case "verify":
      return <Play size={12} />;
    default:
      return <span />;
  }
}

function MessageContextTags({ skills, tools }: { skills: string[]; tools: string[] }): JSX.Element {
  return (
    <div className="message-context-tags" aria-label="本次请求上下文">
      {skills.map((label) => <span key={`skill-${label}`} className="message-context-tag is-skill">Skill · {label}</span>)}
      {tools.map((label) => <span key={`tool-${label}`} className="message-context-tag is-tool">工具 · {label}</span>)}
    </div>
  );
}

function MarkdownContent({ content, allowMarkdownPreview = true }: { content: string; allowMarkdownPreview?: boolean }): JSX.Element {
  return (
    <div className="markdown-body">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          code(props) {
            const { inline, className, children, ...rest } = props as {
              inline?: boolean;
              className?: string;
              children?: unknown;
            };
            const raw = extractCodeText(children);
            const match = /language-(\w+)/.exec(className || "");
            const language = match?.[1] ?? "";
            const isInlineCode = inline || (!className && !raw.includes("\n"));
            if (isInlineCode) {
              return <code className="inline-code" {...rest}>{children as React.ReactNode}</code>;
            }
            return <CodeBlock language={language} code={raw} allowMarkdownPreview={allowMarkdownPreview} />;
          }
        }}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
}

function CodeBlock({ language, code, allowMarkdownPreview = true }: { language: string; code: string; allowMarkdownPreview?: boolean }): JSX.Element {
  if (allowMarkdownPreview && isMarkdownLanguage(language)) {
    return <MarkdownPreviewBlock code={code} />;
  }

  return <HighlightedCodeBlock language={language} code={code} />;
}

function HighlightedCodeBlock({ language, code }: { language: string; code: string }): JSX.Element {
  const lines = useMemo(() => highlightCodeLines(code, language), [code, language]);

  return (
    <div className="code-card">
      <div className="code-toolbar">
        <span>{language || "text"}</span>
        <div>
          <button type="button" title="复制源码" onClick={() => postCommand("copyText", { text: code })}>
            <Copy size={13} />
            复制源码
          </button>
          <button type="button" title="写入当前活动编辑器，选区会被替换" onClick={() => postCommand("insertText", { text: code, language })}>
            <Save size={13} />
            写入当前文件
          </button>
        </div>
      </div>
      <pre className={`language-${language || "text"}`}>
        <code>
          {lines.map((line, index) => (
            <span key={`${index}-${line.raw}`} className="code-line">
              <span className="code-line-number">{index + 1}</span>
              <span className="code-line-content" dangerouslySetInnerHTML={{ __html: line.html || " " }} />
            </span>
          ))}
        </code>
      </pre>
    </div>
  );
}

function highlightCodeLines(code: string, language: string): Array<{ raw: string; html: string }> {
  const grammar = Prism.languages[language] ?? Prism.languages.markup;
  return code.split(/\r?\n/).map((line) => ({
    raw: line,
    html: Prism.highlight(line, grammar, language || "text")
  }));
}

function isMarkdownLanguage(language: string): boolean {
  return ["markdown", "md", "mdx"].includes(language.toLowerCase());
}

function MarkdownPreviewBlock({ code }: { code: string }): JSX.Element {
  return (
    <div className="markdown-preview-block">
      <div className="code-toolbar markdown-preview-toolbar">
        <span>Markdown 预览</span>
        <div>
          <button type="button" title="复制完整 Markdown 源码" onClick={() => postCommand("copyText", { text: code })}>
            <Copy size={13} />
            复制源码
          </button>
        </div>
      </div>
      <div className="markdown-preview-content">
        <MarkdownContent content={code} allowMarkdownPreview={false} />
      </div>
    </div>
  );
}

function PatchNotice({ onOpen }: { onOpen: () => void }): JSX.Element {
  const { extensionState } = useCodeAgentStore();
  const patch = extensionState.patch.pendingPatch ?? extensionState.patch.activeDraft;
  const isLive = Boolean(extensionState.patch.activeDraft && !extensionState.patch.pendingPatch);
  const files = useMemo(() => parsePatchPreview(patch), [patch?.id, patch?.patchText]);
  if (!patch) {
    return <></>;
  }

  const additions = files.reduce((total, file) => total + file.additions, 0);
  const deletions = files.reduce((total, file) => total + file.deletions, 0);

  return (
    <section className={classNames("patch-notice", isLive && "is-live")} aria-label={isLive ? "正在生成修改" : "待确认修改"}>
      <div>
        {isLive ? <Loader2 size={16} className="spin" /> : <FileDiff size={16} />}
        <span>{isLive ? "正在实时生成修改" : "已生成修改草稿"}：{patch.fileCount} 个文件，新增 {additions} 行，删除 {deletions} 行。</span>
      </div>
      <button type="button" onClick={onOpen}>
        查看修改结果
      </button>
    </section>
  );
}

function ApprovalRail(): JSX.Element | null {
  const { extensionState } = useCodeAgentStore();
  const approvals = extensionState.pendingApprovals ?? [];
  if (approvals.length === 0) {
    return null;
  }

  return (
    <section className="approval-rail" aria-label="待审批操作">
      {approvals.map((approval) => (
        <ApprovalCard key={approval.id} approval={approval} />
      ))}
    </section>
  );
}

function ApprovalCard({ approval }: { approval: ApprovalPrompt }): JSX.Element {
  const Icon = approval.kind === "command" ? Play : approval.kind === "skill" ? Wand2 : approval.kind === "web" ? Globe : Layers;

  function resolve(decision: ApprovalDecision): void {
    postCommand("resolveApproval", {
      approvalId: approval.id,
      approvalDecision: decision
    });
  }

  return (
    <article className="approval-card">
      <div className="approval-icon">
        <Icon size={16} />
      </div>
      <div className="approval-main">
        <div className="approval-title">
          <strong>{approvalTitle(approval)}</strong>
          <span>{approvalKindLabel(approval.kind)}</span>
        </div>
        {approval.reason ? <p>{approval.reason}</p> : null}
        {approval.script ? <code>{approval.script}</code> : null}
        {approval.command ? <code>{approval.command}</code> : null}
        {approval.query ? <code>搜索：{approval.query}</code> : null}
        {approval.provider ? <small>服务商：{approval.provider}</small> : null}
        {approval.allowDomains?.length ? <small>允许域名：{approval.allowDomains.join("、")}</small> : null}
        {approval.cwd ? <small>目录：{approval.cwd}</small> : null}
      </div>
      <div className="approval-actions">
        <button type="button" className="primary-button" onClick={() => resolve(approval.kind === "command" || approval.kind === "web" ? "approveOnce" : "approveSession")}>
          <Check size={13} />
          {approval.kind === "command" || approval.kind === "web" ? "允许一次" : "允许本会话"}
        </button>
        {approval.kind === "command" || approval.kind === "web" ? (
          <button type="button" onClick={() => resolve("approveSession")}>
            <ShieldCheck size={13} />
            {approval.kind === "web" ? "本会话记住此搜索" : "本会话记住此命令"}
          </button>
        ) : null}
        <button type="button" onClick={() => resolve("reject")}>
          <X size={13} />
          拒绝
        </button>
      </div>
    </article>
  );
}

function Composer({ busy }: { busy: boolean }): JSX.Element {
  const { extensionState, draft, setDraft, activeMode, setActiveMode } = useCodeAgentStore();
  const [activeMenu, setActiveMenu] = useState<ComposerMenu>();
  const [selectedSkills, setSelectedSkills] = useState<string[]>([]);
  const [selectedTools, setSelectedTools] = useState<string[]>([]);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const skillChoices = useMemo(() => getSkillChoices(extensionState.capabilities?.skills), [extensionState.capabilities?.skills]);
  const toolChoices = useMemo(() => getToolChoices(extensionState.capabilities?.tools), [extensionState.capabilities?.tools]);

  function submit(): void {
    if (!draft.trim() || busy) {
      textareaRef.current?.focus();
      return;
    }
    const next = draft.trim();
    setDraft("");
    routePrompt(next, activeMode, { skillIds: selectedSkills, toolIds: selectedTools });
  }

  function addMention(path: string): void {
    setDraft(`${fileMentionPrefix(draft)}@${path} `);
    setActiveMenu(undefined);
    textareaRef.current?.focus();
  }

  function toggleChoice(value: string, selected: string[], setter: (value: string[]) => void): void {
    setter(selected.includes(value) ? selected.filter((item) => item !== value) : [...selected, value]);
  }

  function runCapability(type: "skill" | "tool", id: string): void {
    postCommand("runCapability", {
      capabilityType: type,
      capabilityId: id,
      text: draft
    });
  }

  useEffect(() => {
    if (!activeMenu) {
      return;
    }

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        setActiveMenu(undefined);
        textareaRef.current?.focus();
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [activeMenu]);

  return (
    <footer className="composer">
      <div className="template-row">
        {promptTemplates.map((template) => (
          <button
            key={template.label}
            type="button"
            onClick={() => {
              setActiveMode(template.mode);
              setDraft(template.value);
              textareaRef.current?.focus();
            }}
          >
            {template.label}
          </button>
        ))}
      </div>
      <div className="prompt-box">
        {activeMenu === "files" ? <FileReferencePicker onPick={addMention} /> : null}
        {activeMenu === "skills" ? (
          <ChoicePicker
            title="选择 Skill"
            description="Skill 是可扩展任务能力，可兼容 Claude、GPT、DeepSeek 等模型；脚本执行前会请求审批。"
            items={skillChoices}
            selected={selectedSkills}
            onToggle={(id) => toggleChoice(id, selectedSkills, setSelectedSkills)}
          />
        ) : null}
        {activeMenu === "tools" ? (
          <ChoicePicker
            title="选择工具 / MCP"
            description="工具和 MCP 用于文件、命令、调试或外部系统。命令执行默认逐条审批，可在本会话记住同一条命令。"
            items={toolChoices}
            selected={selectedTools}
            onToggle={(id) => toggleChoice(id, selectedTools, setSelectedTools)}
          />
        ) : null}
        <ComposerChips
          skills={selectedSkills}
          tools={selectedTools}
          skillChoices={skillChoices}
          toolChoices={toolChoices}
          onRun={runCapability}
        />
        <textarea
          ref={textareaRef}
          value={draft}
          placeholder={activeMode === "agent"
            ? "描述你想完成的工程任务，例如：修复这个报错、重构当前模块、补充测试、分析性能问题..."
            : "直接提问，例如：解释这段代码、这个报错是什么意思、这个设计有没有风险..."}
          rows={4}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key !== "Enter") {
              return;
            }

            if (event.ctrlKey && !event.altKey && !event.shiftKey && !event.metaKey) {
              event.preventDefault();
              const target = event.currentTarget;
              const start = target.selectionStart;
              const end = target.selectionEnd;
              const next = `${draft.slice(0, start)}\n${draft.slice(end)}`;
              setDraft(next);
              window.requestAnimationFrame(() => {
                target.selectionStart = start + 1;
                target.selectionEnd = start + 1;
              });
              return;
            }

            if (!event.altKey && !event.shiftKey && !event.ctrlKey && !event.metaKey) {
              event.preventDefault();
              submit();
              return;
            }

            event.preventDefault();
          }}
        />
        <div className="composer-actions">
          <button type="button" title="引用项目文件" onClick={() => {
            setActiveMenu(activeMenu === "files" ? undefined : "files");
            postCommand("listWorkspaceFiles");
          }}>
            <Plus size={15} />
          </button>
          <button type="button" className={classNames(activeMenu === "skills" && "is-active")} title="选择 Skill" onClick={() => setActiveMenu(activeMenu === "skills" ? undefined : "skills")}>
            <Wand2 size={15} />
            Skill
          </button>
          <button type="button" className={classNames(activeMenu === "tools" && "is-active")} title="选择工具或 MCP" onClick={() => setActiveMenu(activeMenu === "tools" ? undefined : "tools")}>
            <Layers size={15} />
            MCP
          </button>
          <button type="button" title="联网搜索当前输入" disabled={busy || !draft.trim()} onClick={() => postCommand("runWebSearch", { query: draft })}>
            <Globe size={15} />
            搜索
          </button>
          <button type="button" title="优先搜索官方文档" disabled={busy || !draft.trim()} onClick={() => postCommand("runWebSearch", { query: draft, sourceHint: "docs" })}>
            <SearchCode size={15} />
            文档
          </button>
          <div className="mode-switch" role="group" aria-label="选择工作模式">
            {modeOptions.map((mode) => (
              <button
                key={mode.id}
                type="button"
                className={classNames(activeMode === mode.id && "is-active")}
                title={mode.description}
                onClick={() => setActiveMode(mode.id)}
              >
                {mode.label}
              </button>
            ))}
          </div>
          <div className="composer-model">
            <ModelSelect activeModel={extensionState.activeModel} models={extensionState.models} compact />
          </div>
          <button type="button" className="key-inline" title="设置当前模型 API Key" onClick={() => postCommand("setApiKey")}>
            <KeyRound size={15} />
            API Key
          </button>
          <span className="composer-spacer" />
          <button type="button" className="stop-button" title="停止当前回复或 Agent 任务" disabled={!busy} onClick={() => postCommand("stopGeneration")}>
            <Square size={14} />
            {busy ? "停止" : ""}
          </button>
          <button type="button" className="send-button" title="发送" disabled={busy || !draft.trim()} onClick={submit}>
            {activeMode === "agent" ? <FileDiff size={15} /> : <Send size={15} />}
          </button>
        </div>
      </div>
    </footer>
  );
}

function ComposerChips({
  skills,
  tools,
  skillChoices,
  toolChoices,
  onRun
}: {
  skills: string[];
  tools: string[];
  skillChoices: ChoiceItem[];
  toolChoices: ChoiceItem[];
  onRun: (type: "skill" | "tool", id: string) => void;
}): JSX.Element | null {
  const selectedSkillItems = matchChoices(skills, skillChoices);
  const selectedToolItems = matchChoices(tools, toolChoices);
  if (selectedSkillItems.length === 0 && selectedToolItems.length === 0) {
    return null;
  }

  return (
    <div className="composer-chips" aria-label="当前任务上下文">
      {selectedSkillItems.map((item) => (
        <span key={`skill-${item.id}`} className="composer-chip">
          Skill · {item.label}
          {isRunnableCapability(item) ? (
            <button type="button" title={`运行 ${item.label}`} onClick={() => onRun("skill", item.id)}>
              <Play size={11} />
            </button>
          ) : null}
        </span>
      ))}
      {selectedToolItems.map((item) => (
        <span key={`tool-${item.id}`} className="composer-chip">
          {item.kind === "mcp" ? "MCP" : "工具"} · {item.label}
          {isRunnableCapability(item) ? (
            <button type="button" title={`运行 ${item.label}`} onClick={() => onRun("tool", item.id)}>
              <Play size={11} />
            </button>
          ) : null}
        </span>
      ))}
    </div>
  );
}

function ChoicePicker({ title, description, items, selected, onToggle }: { title: string; description: string; items: ChoiceItem[]; selected: string[]; onToggle: (id: string) => void }): JSX.Element {
  return (
    <div className="choice-picker">
      <div className="choice-picker-header">
        <div>
          <strong>{title}</strong>
          <span>{description}</span>
        </div>
        <span className="choice-picker-count">{items.length} 项</span>
      </div>
      <div className="choice-grid">
        {items.map((item) => {
          const Icon = item.icon;
          return (
            <button
              key={item.id}
              type="button"
              className={classNames(selected.includes(item.id) && "is-selected")}
              onClick={() => onToggle(item.id)}
            >
              <Icon size={15} />
              <span>
                <div className="choice-item-title">
                  <strong>{item.label}</strong>
                  {item.kind ? <span className="choice-kind">{capabilityKindLabel(item.kind)}</span> : null}
                </div>
                <small>{item.description}</small>
                {item.server ? <small className="choice-subline">MCP: {item.server}</small> : null}
                {item.script ? <small className="choice-subline">{item.runtime ?? "script"}: {item.script}</small> : null}
                {item.command ? <small className="choice-subline">命令: {item.command}</small> : null}
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

function FileReferencePicker({ onPick }: { onPick: (path: string) => void }): JSX.Element {
  const { extensionState } = useCodeAgentStore();
  const [query, setQuery] = useState("");
  const currentFile = extensionState.context.file;
  const files = extensionState.workspaceFiles
    .filter((file) => file.path.toLowerCase().includes(query.toLowerCase()))
    .slice(0, 12);

  return (
    <div className="file-picker">
      <div className="file-picker-header">
        <div>
          <strong>引用文件</strong>
          <span>优先显示当前打开文件和已打开标签页，选中后会引用到本次对话。</span>
        </div>
        <button type="button" onClick={() => postCommand("listWorkspaceFiles")}>
          <RefreshCw size={13} />
          刷新
        </button>
      </div>
      <label className="file-picker-search">
        <Search size={14} />
        <input value={query} placeholder="输入文件名或路径关键字" onChange={(event) => setQuery(event.target.value)} autoFocus />
      </label>
      <div className="file-picker-list">
        {files.length === 0 ? (
          <div className="file-picker-empty">
            <FolderSearch size={16} />
            <span>{extensionState.workspaceFiles.length === 0 ? "正在读取或暂无可引用文件" : "没有匹配的文件"}</span>
          </div>
        ) : files.map((file) => (
          <button
            key={file.path}
            type="button"
            title={file.path}
            className={classNames(file.path === currentFile && "is-current", file.source === "active" && "is-active-file", file.source === "open" && "is-open-file")}
            onClick={() => onPick(file.path)}
          >
            <FileCode2 size={14} />
            <span className="file-picker-main">
              <strong>{file.path}</strong>
              <small>
                {file.languageId} · {file.lineCount} 行
              </small>
            </span>
            <span className="file-picker-current">{fileSourceLabel(file, currentFile)}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

function ChangesPanel(): JSX.Element {
  const { extensionState, setDraft, setActivePanel, setActiveMode } = useCodeAgentStore();
  const pendingPatch = extensionState.patch.pendingPatch;
  const activeDraft = extensionState.patch.activeDraft;
  const lastAppliedPatch = extensionState.patch.lastAppliedPatch;
  const activePatch = pendingPatch ?? activeDraft ?? lastAppliedPatch;
  const activeStatus = pendingPatch ? "ready" : activeDraft ? extensionState.patch.activeDraftStatus ?? "generating" : lastAppliedPatch ? "applied" : "empty";
  const isStreaming = activeStatus === "generating" || activeStatus === "reviewing" || activeStatus === "repairing";
  const files = useMemo(() => parsePatchPreview(activePatch), [activePatch?.id, activePatch?.patchText]);
  const [selectedId, setSelectedId] = useState<string | undefined>();

  useEffect(() => {
    setSelectedId(files[0]?.id);
  }, [activePatch?.id, files.length]);

  if (!activePatch) {
    return (
      <main className="panel-page changes-page">
        <PanelHeader title="修改结果" description="Agent 生成的文件修改会显示在这里，确认后才会写入工作区。" />
        <div className="empty-change-page">
          <FileDiff size={24} />
          <strong>还没有生成修改</strong>
          <span>回到对话页，切换到 Agent 模式并描述你想完成的任务。</span>
          <button
            type="button"
            onClick={() => {
              setActiveMode("agent");
              setDraft("请帮我修改：");
              setActivePanel("chat");
            }}
          >
            <Wand2 size={14} />
            去输入需求
          </button>
        </div>
        {extensionState.patch.lastBackupId ? (
          <button type="button" className="wide-button" onClick={() => postCommand("rollbackPatch")}>
            <RotateCcw size={14} />
            撤回上次修改
          </button>
        ) : null}
      </main>
    );
  }

  const selected = files.find((file) => file.id === selectedId) ?? files[0];
  const additions = files.reduce((total, file) => total + file.additions, 0);
  const deletions = files.reduce((total, file) => total + file.deletions, 0);
  const isPending = Boolean(pendingPatch);
  const canShowRawDraft = files.length === 0 && Boolean(activePatch.patchText.trim());

  return (
    <main className="panel-page changes-page">
      <PanelHeader
        title="修改结果"
        description={changePanelDescription(activeStatus)}
        actionLabel={isPending ? "完整 diff" : undefined}
        actionIcon={FileDiff}
        onAction={isPending ? () => postCommand("previewPatch") : undefined}
      />

      <section className={classNames("change-overview", changeStatusClass(activeStatus))}>
        <div>
          <strong>{changeStatusLabel(activeStatus)}</strong>
          <span>{activePatch.fileCount} 个文件 · {activePatch.model} · {formatTime(activePatch.createdAt)}</span>
        </div>
        <div className="change-totals">
          {isStreaming ? <span className="is-streaming"><Loader2 size={11} className="spin" /> 实时</span> : null}
          <span className="is-add">+{additions}</span>
          <span className="is-remove">-{deletions}</span>
        </div>
      </section>

      {activeDraft ? (
        <section className={classNames("live-draft-banner", changeStatusClass(activeStatus))} aria-label="实时生成状态">
          <div>
            {isStreaming ? <Loader2 size={15} className="spin" /> : activeStatus === "failed" ? <X size={15} /> : <Square size={15} />}
            <span>{extensionState.patch.activeDraftDetail ?? changePanelDescription(activeStatus)}</span>
          </div>
          {extensionState.busy ? (
            <button type="button" className="danger-button" onClick={() => postCommand("stopGeneration")}>
              <Square size={13} />
              立即停止
            </button>
          ) : null}
        </section>
      ) : null}

      {extensionState.patch.stagedTask ? <StagedTaskPanel /> : null}
      {activePatch.verifyRepair ? <VerifyRepairPanel patch={activePatch} /> : null}
      {activePatch.plan ? <PatchPlanPanel plan={activePatch.plan} /> : null}
      {activePatch.quality ? <PatchQualityPanel quality={activePatch.quality} /> : null}

      {extensionState.patch.lastApplyError ? (
        <div className="error-panel">
          <strong>应用修改失败</strong>
          <span>{extensionState.patch.lastApplyError}</span>
        </div>
      ) : null}

      <div className="change-action-row">
        {isPending ? patchActions.map((action) => <ActionButton key={action.id} action={action} />) : activeDraft ? (
          <>
            <button type="button" disabled={activePatch.quality?.status === "fail"}>
              <FileDiff size={14} />
              {activePatch.quality?.status === "fail" ? "质量未通过" : "生成中不可应用"}
            </button>
            <button type="button" disabled={!extensionState.busy} onClick={() => postCommand("stopGeneration")}>
              <Square size={14} />
              停止
            </button>
          </>
        ) : (
          <>
            <button type="button" disabled>
              <FileDiff size={14} />
              已应用
            </button>
            <button type="button" disabled={!extensionState.patch.lastBackupId} onClick={() => postCommand("rollbackPatch")}>
              <RotateCcw size={14} />
              撤回
            </button>
          </>
        )}
      </div>

      <section className="change-detail-layout" aria-label="文件修改详情">
        <div className="change-files">
          <div className="change-files-title">修改文件</div>
          {files.length === 0 ? <p className="muted-copy">{isStreaming ? "正在等待模型输出 diff 头部..." : "没有解析到可显示的文件修改。"}</p> : files.map((file) => (
            <button
              key={file.id}
              type="button"
              className={classNames("change-file-card", selected?.id === file.id && "is-active")}
              title={file.path}
              onClick={() => setSelectedId(file.id)}
            >
              <span className={classNames("change-op", `is-${file.operation}`)}>{operationLabel(file.operation)}</span>
              <span className="change-file-name">{file.path}</span>
              <span className="change-file-stats">+{file.additions} -{file.deletions}</span>
            </button>
          ))}
        </div>
        {canShowRawDraft ? <RawDraftPreview patch={activePatch} isStreaming={isStreaming} /> : <DiffPreview file={selected} isStreaming={isStreaming} />}
      </section>
    </main>
  );
}

function VerifyRepairPanel({ patch }: { patch: PatchDraft }): JSX.Element {
  const repair = patch.verifyRepair;
  if (!repair) {
    return <></>;
  }

  return (
    <section className="verify-repair-panel" aria-label="验证修复">
      <header>
        <div>
          <span>验证修复</span>
          <strong>第 {repair.round}/{repair.maxRounds} 轮修复草稿</strong>
        </div>
        <small>{repair.source === "postApply" ? "应用后验证触发" : "手动验证触发"}</small>
      </header>
      <div className="verify-repair-grid">
        {repair.failedCommand ? (
          <div>
            <span>失败命令</span>
            <code>{repair.failedCommand}</code>
          </div>
        ) : null}
        {repair.failureKind ? (
          <div>
            <span>失败类型</span>
            <strong>{repair.failureKind}</strong>
          </div>
        ) : null}
        {repair.summary ? (
          <div className="is-wide">
            <span>摘要</span>
            <p>{repair.summary}</p>
          </div>
        ) : null}
      </div>
      <p>请先审查本轮 diff，确认后再应用。应用后 Patchlane 会继续运行验证；如果仍失败且未达到上限，会生成下一轮修复草稿。</p>
    </section>
  );
}

function StagedTaskPanel(): JSX.Element | null {
  const { extensionState } = useCodeAgentStore();
  const task = extensionState.patch.stagedTask;
  if (!task) {
    return null;
  }
  const current = task.phases[task.currentPhaseIndex];
  const completed = task.phases.filter((phase) => phase.status === "done").length;
  const canContinue = Boolean(current && (current.status === "applied" || current.status === "done") && task.status !== "done");
  const canRetry = Boolean(current && current.status === "failed");

  return (
    <section className={classNames("staged-task-panel", `is-${task.status}`)} aria-label="分阶段任务">
      <header>
        <div>
          <span className="staged-task-kicker">分阶段任务</span>
          <strong>{task.status === "done" ? "全部阶段完成" : current ? `阶段 ${task.currentPhaseIndex + 1}/${task.phaseCount} · ${current.title}` : task.plan.summary}</strong>
          <small>{completed}/{task.phaseCount} 已完成 · {stagedTaskStatusLabel(task.status)}</small>
        </div>
        <div className="staged-task-actions">
          <button type="button" disabled={!canContinue || extensionState.busy} onClick={() => postCommand("continueStagedTask")}>
            <Workflow size={13} />
            继续
          </button>
          <button type="button" disabled={!canRetry || extensionState.busy} onClick={() => postCommand("retryStagedPhase", { text: current?.failureReason })}>
            <RefreshCw size={13} />
            续跑
          </button>
        </div>
      </header>
      <ol className="staged-phase-list">
        {task.phases.map((phase, index) => (
          <li key={phase.id} className={classNames(`is-${phase.status}`, index === task.currentPhaseIndex && "is-current")}>
            <span>{stagePhaseIcon(phase.status)}</span>
            <div>
              <strong>{index + 1}. {phase.title}</strong>
              <small>{stagePhaseStatusLabel(phase.status)}{phase.attempt > 0 ? ` · 第 ${phase.attempt} 次` : ""}</small>
              {phase.files.length > 0 ? <em>{phase.files.join("、")}</em> : null}
              {phase.failureReason ? <small className="stage-failure">{phase.failureReason}</small> : null}
            </div>
          </li>
        ))}
      </ol>
    </section>
  );
}

function PatchPlanPanel({ plan }: { plan: PatchPlan }): JSX.Element {
  const riskLevel = plan.riskLevel ?? "low";
  return (
    <section className={classNames("plan-panel", `is-risk-${riskLevel}`)} aria-label="执行计划">
      <header className="plan-panel-header">
        <div>
          <span className="plan-panel-kicker">执行计划</span>
          <strong>{plan.summary}</strong>
        </div>
        <span className={classNames("plan-risk-badge", `is-${riskLevel}`)}>{patchRiskLabel(riskLevel)}</span>
      </header>
      <div className="plan-panel-grid">
        <div className="plan-panel-block">
          <span>文件</span>
          <div className="plan-tags">
            {plan.files.length > 0 ? plan.files.map((file) => (
              <span key={`${file.path}-${file.operation ?? "modify"}`} className="plan-tag">
                {file.operation ?? "modify"} · {file.path}
              </span>
            )) : <span className="plan-tag">未指定文件</span>}
          </div>
        </div>
        <div className="plan-panel-block">
          <span>步骤</span>
          <ol className="plan-list">
            {plan.steps.length > 0 ? plan.steps.map((step) => <li key={step}>{step}</li>) : <li>先定位最小修改点</li>}
          </ol>
        </div>
        {(plan.checkpoints ?? []).length > 0 ? (
          <div className="plan-panel-block">
            <span>检查点</span>
            <ol className="plan-checkpoints">
              {(plan.checkpoints ?? []).map((checkpoint) => (
                <li key={checkpoint.id || checkpoint.title}>
                  <strong>{checkpoint.title}</strong>
                  {checkpoint.files.length > 0 ? <span>{checkpoint.files.join("、")}</span> : null}
                  {checkpoint.acceptanceCriteria.length > 0 ? <small>{checkpoint.acceptanceCriteria.join("；")}</small> : null}
                </li>
              ))}
            </ol>
          </div>
        ) : null}
        <div className="plan-panel-block">
          <span>验收标准</span>
          <ol className="plan-list">
            {(plan.acceptanceCriteria ?? []).length > 0 ? plan.acceptanceCriteria.map((item) => <li key={item}>{item}</li>) : <li>修改内容与需求一致</li>}
          </ol>
        </div>
        <div className="plan-panel-block">
          <span>验证</span>
          <ol className="plan-list">
            {plan.verification.length > 0 ? plan.verification.map((step) => <li key={step}>{step}</li>) : <li>检查修改结果页中的 diff</li>}
          </ol>
        </div>
        {(plan.risks ?? []).length > 0 ? (
          <div className="plan-panel-block">
            <span>风险</span>
            <div className="plan-tags">
              {plan.risks.map((risk) => <span key={risk} className="plan-tag is-muted">{risk}</span>)}
            </div>
          </div>
        ) : null}
        {(plan.contextGaps ?? []).length > 0 ? (
          <div className="plan-panel-block">
            <span>上下文缺口</span>
            <div className="plan-tags">
              {plan.contextGaps.map((gap) => <span key={gap} className="plan-tag is-muted">{gap}</span>)}
            </div>
          </div>
        ) : null}
        {plan.assumptions.length > 0 ? (
          <div className="plan-panel-block">
            <span>假设</span>
            <div className="plan-tags">
              {plan.assumptions.map((assumption) => <span key={assumption} className="plan-tag is-muted">{assumption}</span>)}
            </div>
          </div>
        ) : null}
      </div>
    </section>
  );
}

function patchRiskLabel(level: NonNullable<PatchPlan["riskLevel"]>): string {
  if (level === "high") {
    return "高风险";
  }
  if (level === "medium") {
    return "中风险";
  }
  return "低风险";
}

function PatchQualityPanel({ quality }: { quality: PatchQualityReport }): JSX.Element {
  return (
    <section className={classNames("quality-panel", `is-${quality.status}`)} aria-label="质量审查">
      <header className="quality-panel-header">
        <div>
          <span className="quality-kicker">质量审查</span>
          <strong>{quality.summary}</strong>
          <span>{quality.reviewModel ? `审查模型：${displayModelName(quality.reviewModel)}` : "本地规则 + 模型审查"}{quality.repaired ? " · 已尝试自动修复" : ""}</span>
        </div>
        <span className={classNames("quality-status", `is-${quality.status}`)}>{qualityStatusLabel(quality.status)}</span>
      </header>
      <div className="quality-check-list">
        {quality.checks.map((check) => (
          <div key={`${check.id}-${check.label}`} className={classNames("quality-check", `is-${check.status}`)}>
            <span>{qualityStatusIcon(check.status)}</span>
            <div>
              <strong>{check.label}</strong>
              <small>{check.detail}</small>
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}

function DiffPreview({ file, isStreaming = false }: { file?: PatchFilePreview; isStreaming?: boolean }): JSX.Element {
  if (!file) {
    return (
      <div className="diff-card">
        <div className="quiet-panel">
          {isStreaming ? <Loader2 size={16} className="spin" /> : <FileDiff size={16} />}
          <strong>{isStreaming ? "正在接收修改" : "请选择文件"}</strong>
          <span>{isStreaming ? "模型输出可解析的 diff 后，这里会实时显示文件改动。" : "点击左侧文件即可查看具体改动。"}</span>
        </div>
      </div>
    );
  }

  return (
    <section className="diff-card" aria-label="Diff 内容">
      <header className="diff-card-header">
        <div>
          <strong title={file.path}>{file.path}</strong>
          <span>{isStreaming ? "实时更新中 · " : ""}{file.hunks} 处改动</span>
        </div>
        <button type="button" title="复制此文件改动" onClick={() => postCommand("copyText", { text: file.rawLines.join("\n") })}>
          <Copy size={13} />
        </button>
      </header>
      <pre className="diff-viewer">
        {file.rawLines.map((line, index) => (
          <span key={`${index}-${line}`} className={classNames("diff-line", diffLineClass(line))}>
            <span className="diff-gutter">{diffMarker(line)}</span>
            <code>{line || " "}</code>
          </span>
        ))}
      </pre>
    </section>
  );
}

function RawDraftPreview({ patch, isStreaming }: { patch: PatchDraft; isStreaming: boolean }): JSX.Element {
  const lines = patch.patchText.split(/\r?\n/).slice(-220);
  return (
    <section className="diff-card raw-draft-card" aria-label="模型原始输出">
      <header className="diff-card-header">
        <div>
          <strong>正在接收模型输出</strong>
          <span>{isStreaming ? "等待形成完整 diff" : "未解析为标准 diff"}</span>
        </div>
        <button type="button" title="复制当前输出" onClick={() => postCommand("copyText", { text: patch.patchText })}>
          <Copy size={13} />
        </button>
      </header>
      <pre className="diff-viewer raw-draft-viewer">
        {lines.map((line, index) => (
          <span key={`${index}-${line}`} className={classNames("diff-line", diffLineClass(line))}>
            <span className="diff-gutter">{diffMarker(line)}</span>
            <code>{line || " "}</code>
          </span>
        ))}
      </pre>
    </section>
  );
}

function SettingsPanel(): JSX.Element {
  const { extensionState, setActivePanel } = useCodeAgentStore();
  const providerName = formatProvider(extensionState.activeModel?.providerId);
  const skillChoices = useMemo(() => getSkillChoices(extensionState.capabilities?.skills), [extensionState.capabilities?.skills]);
  const toolChoices = useMemo(() => getToolChoices(extensionState.capabilities?.tools), [extensionState.capabilities?.tools]);
  const mcpServers = extensionState.mcpServers ?? [];
  const mcpCatalog = extensionState.mcpCatalog ?? [];
  const capabilityDiagnostics = extensionState.capabilityDiagnostics ?? [];
  const capabilityRuns = extensionState.session?.capabilityRuns ?? [];
  const mcpToolCount = toolChoices.filter((item) => item.kind === "mcp" && item.id.startsWith("mcp:")).length;
  const mcpResourceCount = mcpCatalog.reduce((total, server) => total + server.resources.length, 0);
  const mcpPromptCount = mcpCatalog.reduce((total, server) => total + server.prompts.length, 0);
  const openSetting = (settingKey: string) => postCommand("openSettingsTarget", { settingKey });
  return (
    <main className="panel-page settings-page">
      <PanelHeader
        title="设置"
        description="普通用户只需要选择模型并填写对应 API Key；高级配置可以在 VS Code 设置里修改。"
        actionLabel="返回对话"
        actionIcon={MessageSquare}
        onAction={() => setActivePanel("chat")}
      />

      <section className="settings-hero">
        <div>
          <strong>基础只需要两步</strong>
          <span>选择模型，填写 API Key。其它能力按需开启，Agent 执行前都会在页面内请求审批。</span>
        </div>
        <button type="button" className="primary-button" onClick={() => postCommand("setApiKey")}>
          <KeyRound size={14} />
          设置当前模型密钥
        </button>
      </section>

      <section className="settings-grid">
        <div className="settings-card is-primary">
          <SectionTitle title="模型" />
          <ModelSelect activeModel={extensionState.activeModel} models={extensionState.models} />
          <InfoRow label="厂商" value={providerName} />
          <InfoRow label="模型 ID" value={extensionState.activeModel?.modelId ?? "n/a"} />
          <InfoRow label="上下文预算" value={contextBudgetLabel(extensionState.agentSettings?.contextBudget)} />
          <InfoRow label="修复轮次" value={`${extensionState.agentSettings?.maxRepairAttempts ?? 2} 轮`} />
          <InfoRow label="工具轮次" value={`${extensionState.agentSettings?.maxToolRounds ?? 2} 轮`} />
          <button type="button" className="wide-button primary-button" onClick={() => postCommand("setApiKey")}>
            <KeyRound size={14} />
            设置 {providerName} API Key
          </button>
        </div>

        <div className="settings-card">
          <SectionTitle title="自定义模型" />
          <div className="quiet-panel setup-note">
            <Settings2 size={16} />
            <strong>OpenAI / Claude 接口</strong>
            <span>自定义模型支持选择协议、Base URL、模型 ID 和 API Key。普通用户直接点下面按钮即可配置。</span>
          </div>
          <button type="button" className="wide-button primary-button" onClick={() => postCommand("configureCustomProvider")}>
            <Settings2 size={14} />
            配置自定义模型
          </button>
          <button type="button" className="wide-button" onClick={() => openSetting("codeAgent.agent.contextBudget")}>
            <Settings2 size={14} />
            打开模型与预算配置
          </button>
        </div>

        <div className="settings-card">
          <SectionTitle title="联网搜索" />
          <div className="quiet-panel setup-note">
            <Globe size={16} />
            <strong>{extensionState.webSearch?.enabled ? "已启用" : "未启用"}</strong>
            <span>默认可用免费搜索，不需要 Key。会优先尝试 Bing、百度、搜狗等无 Key 搜索；有条件时建议填写自建 SearXNG 地址。</span>
          </div>
          <InfoRow label="服务商" value={formatWebSearchProvider(extensionState.webSearch?.provider)} />
          <InfoRow label="地址" value={extensionState.webSearch?.baseUrl || (extensionState.webSearch?.provider === "free" ? "内置免费源轮询" : "默认地址")} />
          <InfoRow label="结果数" value={String(extensionState.webSearch?.maxResults ?? 6)} />
          <InfoRow label="时间范围" value={extensionState.webSearch?.defaultRecencyDays ? `${extensionState.webSearch.defaultRecencyDays} 天` : "不限"} />
          <button type="button" className="wide-button primary-button" onClick={() => postCommand("configureWebSearch")}>
            <Globe size={14} />
            配置联网搜索
          </button>
          <button type="button" className="wide-button" onClick={() => postCommand("runWebSearch", { query: "Patchlane VS Code Agent 最新文档" })}>
            <Search size={14} />
            通用搜索测试
          </button>
          <button type="button" className="wide-button" onClick={() => postCommand("runWebSearch", { query: "VS Code extension webview markdown render official docs", sourceHint: "docs" })}>
            <SearchCode size={14} />
            官方文档搜索测试
          </button>
        </div>

        <div className="settings-card">
          <SectionTitle title="Skill 与工具" />
          <div className="capability-guide">
            <div>
              <span>1</span>
              <strong>先用内置能力</strong>
              <small>代码审查、调试分析、测试生成、文件读写、终端命令和联网搜索已经内置，可直接在输入框底部选择。</small>
            </div>
            <div>
              <span>2</span>
              <strong>需要脚本再生成模板</strong>
              <small>点击“生成扩展模板”会创建 .patchlane 示例目录；点击“创建一个 Skill”会生成一个可编辑脚本。</small>
            </div>
            <div>
              <span>3</span>
              <strong>MCP 属于高级扩展</strong>
              <small>只有要接外部工具服务时才需要配置 MCP；普通代码任务不配置也能正常使用。</small>
            </div>
          </div>
          <div className="quiet-panel setup-note">
            <Sparkles size={16} />
            <strong>一键生成模板</strong>
            <span>会在当前工作区创建 .patchlane 示例目录，并把 Skill、工具和 MCP 示例写入工作区设置，之后按需改脚本即可。</span>
          </div>
          <button type="button" className="wide-button primary-button" onClick={() => postCommand("createCapabilityTemplates")}>
            <Sparkles size={14} />
            生成扩展模板
          </button>
          <SkillCreatePanel />
          <div className="tool-list">
            {skillChoices.slice(0, 4).map((item) => (
              <span key={`skill-${item.id}`}>Skill · {capabilityOriginLabel(item)} · {item.label}</span>
            ))}
            {toolChoices.slice(0, 4).map((item) => (
              <span key={`tool-${item.id}`}>{capabilityOriginLabel(item)} · {item.label}</span>
            ))}
          </div>
          <div className="settings-help-grid">
            <div className="quiet-panel setup-note">
              <Layers size={16} />
              <strong>MCP 协议入口</strong>
              <span>MCP 用来接外部服务。stdio 模式填写 command 和 args；HTTP 模式填写 url。发现能力后才会显示具体工具。</span>
            </div>
            <div className="quiet-panel setup-note">
              <Settings2 size={16} />
              <strong>团队共享</strong>
              <span>团队共用能力推荐写在 .patchlane/patchlane.json；个人临时能力仍可写在 VS Code 设置里，脚本放在 .patchlane 目录。</span>
            </div>
            <div className="quiet-panel setup-note">
              <ShieldCheck size={16} />
              <strong>审批规则</strong>
              <span>同一会话同一个 Skill 或工具审批一次；命令默认每次审批，可选择本会话记住同一条命令。</span>
            </div>
            <div className="quiet-panel setup-note">
              <Sparkles size={16} />
              <strong>当前会话授权</strong>
              <span>{formatApprovalSummary(extensionState.approvals)}</span>
            </div>
          </div>
          <div className="action-grid">
            <button type="button" onClick={() => openSetting("codeAgent.customSkills")}>
              <Wand2 size={14} />
              添加 Skill
            </button>
            <button type="button" onClick={() => openSetting("codeAgent.customTools")}>
              <Layers size={14} />
              添加工具
            </button>
            <button type="button" onClick={() => openSetting("codeAgent.mcp.servers")}>
              <Settings2 size={14} />
              添加 MCP
            </button>
          </div>
          <button type="button" className="wide-button" onClick={() => openSetting("codeAgent.customSkills")}>
            <Settings2 size={14} />
            打开扩展能力设置
          </button>
          <CapabilityDiagnosticsPanel diagnostics={capabilityDiagnostics} />
          <CapabilityWorkbench skills={skillChoices} tools={toolChoices} />
          <CapabilityRunHistoryPanel runs={capabilityRuns} />
        </div>

        <div className="settings-card">
          <SectionTitle title="MCP 服务器" />
          <div className="mcp-summary">
            <span>{mcpServers.length} 个服务</span>
            <span>{mcpToolCount} 个可选 MCP 工具</span>
            <span>{mcpResourceCount} 个资源</span>
            <span>{mcpPromptCount} 个 Prompt</span>
          </div>
          <div className="mcp-server-list">
            {mcpServers.length > 0 ? mcpServers.map((server) => (
              <McpServerRow key={server.name} server={server} />
            )) : <span className="muted-line">当前没有配置 MCP 服务器。</span>}
          </div>
          <McpCatalogPanel catalog={mcpCatalog} />
          <div className="quiet-panel setup-note">
            <Layers size={16} />
            <strong>自动发现</strong>
            <span>点击发现后，Patchlane 会启动已配置 MCP 服务并读取 tools/list、resources/list 和 prompts/list；执行前会在页面内请求审批。</span>
          </div>
          <button type="button" className="wide-button primary-button" onClick={() => postCommand("discoverMcpTools")}>
            <RefreshCw size={14} />
            发现 MCP 能力
          </button>
          <button type="button" className="wide-button" onClick={() => openSetting("codeAgent.mcp.servers")}>
            <Settings2 size={14} />
            打开 MCP 配置
          </button>
        </div>

        <div className="settings-card">
          <SectionTitle title="验证与维护" />
          <div className="action-grid">
            <button type="button" onClick={() => postCommand("clearTranscript")}>
              <Trash2 size={14} />
              清空对话
            </button>
            <button type="button" onClick={() => postCommand("showHelp")}>
              <MessageSquare size={14} />
              查看指令
            </button>
            <button type="button" onClick={() => postCommand("runVerify")}>
              <ShieldCheck size={14} />
              运行验证
            </button>
          </div>
        </div>
      </section>
    </main>
  );
}

function PanelHeader({ title, description, actionLabel, actionIcon: ActionIcon, onAction }: { title: string; description?: string; actionLabel?: string; actionIcon?: LucideIcon; onAction?: () => void }): JSX.Element {
  return (
    <div className="panel-header">
      <div>
        <h2>{title}</h2>
        {description ? <span>{description}</span> : null}
      </div>
      {actionLabel && ActionIcon && onAction ? (
        <button type="button" onClick={onAction}>
          <ActionIcon size={13} />
          {actionLabel}
        </button>
      ) : null}
    </div>
  );
}

function SkillCreatePanel(): JSX.Element {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [runtime, setRuntime] = useState<"node" | "python" | "shell">("node");
  const canCreate = name.trim().length > 0;

  return (
    <section className="skill-create-panel" aria-label="创建 Skill">
      <div className="skill-create-title">
        <Wand2 size={15} />
        <span>
          <strong>创建一个 Skill</strong>
          <small>适合沉淀团队规范、调试流程、文档生成或外部脚本。脚本会放到 `.patchlane/skills`。</small>
        </span>
      </div>
      <div className="skill-create-form">
        <label>
          <span>名称</span>
          <input value={name} placeholder="例如：接口联调检查" onChange={(event) => setName(event.target.value)} />
        </label>
        <label>
          <span>运行时</span>
          <select value={runtime} onChange={(event) => setRuntime(event.target.value as "node" | "python" | "shell")}>
            <option value="node">Node.js</option>
            <option value="python">Python</option>
            <option value="shell">Shell</option>
          </select>
        </label>
        <label className="is-wide">
          <span>说明</span>
          <input value={description} placeholder="告诉 Agent 这个 Skill 适合什么时候使用" onChange={(event) => setDescription(event.target.value)} />
        </label>
      </div>
      <button
        type="button"
        className="wide-button"
        disabled={!canCreate}
        onClick={() => postCommand("createSkillFromTemplate", { skillName: name, skillDescription: description, skillRuntime: runtime })}
      >
        <Plus size={14} />
        生成 Skill 脚本
      </button>
    </section>
  );
}

function McpServerRow({ server }: { server: McpServerSummary }): JSX.Element {
  const logs = server.recentLogs ?? [];
  return (
    <article className="mcp-server-row">
      <div className="mcp-server-main">
        <div className="mcp-server-title">
          <span>
            <strong>{server.name}</strong>
            <small>{server.transport} · {server.enabled ? "启用" : "禁用"} · 声明 {server.toolCount} 个 · 工具 {server.discoveredToolCount ?? 0} · 资源 {server.discoveredResourceCount ?? 0} · Prompt {server.discoveredPromptCount ?? 0}</small>
          </span>
          <span className={classNames("mcp-status", `is-${server.status ?? "notStarted"}`)}>{mcpStatusLabel(server.status)}</span>
        </div>
        {server.command ? <code>{server.command}</code> : null}
        {server.url ? <code>{server.url}</code> : null}
        {server.pid ? <small className="mcp-meta">PID {server.pid}</small> : null}
        {server.lastError ? <small className="mcp-error">{server.lastError}</small> : null}
      </div>
      <div className="mcp-server-actions">
        <button type="button" onClick={() => postCommand("restartMcpServer", { serverName: server.name })}>
          <RefreshCw size={13} />
          重连
        </button>
        <button type="button" onClick={() => postCommand("stopMcpServer", { serverName: server.name })}>
          <Square size={13} />
          停止
        </button>
        <button type="button" onClick={() => postCommand("clearMcpLogs", { serverName: server.name })}>
          <Trash2 size={13} />
          清空日志
        </button>
      </div>
      <div className="mcp-log-list">
        {logs.length > 0 ? logs.slice().reverse().map((log, index) => (
          <div key={`${server.name}-log-${log.time}-${index}`} className={classNames("mcp-log-row", `is-${log.level}`)}>
            <span>{mcpLogLevelLabel(log.level)} · {formatTime(log.time)}</span>
            <strong>{log.message}</strong>
            {log.detail ? <small>{log.detail}</small> : null}
          </div>
        )) : <span className="mcp-log-empty">暂无运行日志。</span>}
      </div>
    </article>
  );
}

function McpCatalogPanel({ catalog }: { catalog: McpDiscoveredServerCatalog[] }): JSX.Element {
  const visible = catalog.filter((server) => server.tools.length > 0 || server.resources.length > 0 || server.prompts.length > 0);
  if (visible.length === 0) {
    return (
      <div className="mcp-catalog-empty">
        <Layers size={15} />
        <span>尚未发现 MCP 目录。点击“发现 MCP 能力”后，这里会显示可调用工具、可读取资源和可复用 Prompt。</span>
      </div>
    );
  }

  return (
    <section className="mcp-catalog" aria-label="MCP 能力目录">
      {visible.map((server) => (
        <article key={server.name} className="mcp-catalog-server">
          <div className="mcp-catalog-title">
            <strong>{server.name}</strong>
            <span>{server.tools.length} 工具 · {server.resources.length} 资源 · {server.prompts.length} Prompt</span>
          </div>
          {server.tools.length > 0 ? (
            <div className="mcp-catalog-section">
              <span className="mcp-catalog-label">工具</span>
              {server.tools.slice(0, 6).map((tool) => (
                <div key={`${server.name}-tool-${tool.name}`} className="mcp-catalog-item">
                  <Layers size={13} />
                  <span>
                    <strong>{tool.label || tool.name}</strong>
                    <small>{tool.description || tool.name}</small>
                  </span>
                </div>
              ))}
            </div>
          ) : null}
          {server.resources.length > 0 ? (
            <div className="mcp-catalog-section">
              <span className="mcp-catalog-label">资源</span>
              {server.resources.slice(0, 6).map((resource) => (
                <div key={`${server.name}-resource-${resource.uri}`} className="mcp-catalog-item has-action">
                  <FileCode2 size={13} />
                  <span>
                    <strong>{resource.name || resource.uri}</strong>
                    <small>{resource.description || resource.mimeType || resource.uri}</small>
                  </span>
                  <button type="button" onClick={() => postCommand("readMcpResource", { serverName: server.name, resourceUri: resource.uri })}>
                    读取
                  </button>
                </div>
              ))}
            </div>
          ) : null}
          {server.prompts.length > 0 ? (
            <div className="mcp-catalog-section">
              <span className="mcp-catalog-label">Prompt</span>
              {server.prompts.slice(0, 6).map((prompt) => (
                <McpPromptCatalogItem key={`${server.name}-prompt-${prompt.name}`} serverName={server.name} prompt={prompt} />
              ))}
            </div>
          ) : null}
        </article>
      ))}
    </section>
  );
}

function McpPromptCatalogItem({ serverName, prompt }: { serverName: string; prompt: McpDiscoveredPrompt }): JSX.Element {
  const [values, setValues] = useState<Record<string, string>>({});
  const args = prompt.arguments ?? [];
  const missingRequired = args.some((arg) => arg.required && !values[arg.name]?.trim());
  const promptArguments = Object.fromEntries(
    args
      .map((arg) => [arg.name, values[arg.name]?.trim() ?? ""] as const)
      .filter(([, value]) => Boolean(value))
  );

  return (
    <div className={classNames("mcp-catalog-item", "mcp-prompt-item", args.length > 0 ? "has-form" : undefined)}>
      <div className="mcp-prompt-main">
        <MessageSquare size={13} />
        <span>
          <strong>{prompt.label || prompt.name}</strong>
          <small>{prompt.description || prompt.name}</small>
        </span>
        <button
          type="button"
          disabled={missingRequired}
          title={missingRequired ? "请先填写必填参数" : "把这个 Prompt 加入当前会话上下文"}
          onClick={() => postCommand("useMcpPrompt", { serverName, promptName: prompt.name, promptArguments })}
        >
          使用
        </button>
      </div>
      {args.length > 0 ? (
        <div className="mcp-prompt-form" aria-label={`${prompt.label || prompt.name} 参数`}>
          {args.map((arg) => (
            <label key={`${prompt.name}-${arg.name}`} className="mcp-prompt-field">
              <span>
                {arg.name}
                {arg.required ? <strong>*</strong> : null}
              </span>
              <input
                value={values[arg.name] ?? ""}
                placeholder={arg.description || "可选参数"}
                onChange={(event) => setValues((current) => ({ ...current, [arg.name]: event.target.value }))}
              />
            </label>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function CapabilityDiagnosticsPanel({ diagnostics }: { diagnostics: CapabilityDiagnostic[] }): JSX.Element {
  const counts = {
    error: diagnostics.filter((item) => item.severity === "error").length,
    warning: diagnostics.filter((item) => item.severity === "warning").length,
    info: diagnostics.filter((item) => item.severity === "info").length
  };
  const topDiagnostics = diagnostics.slice(0, 8);

  if (diagnostics.length === 0) {
    return (
      <section className="capability-diagnostics is-clean" aria-label="配置诊断">
        <div className="capability-diagnostics-header">
          <CheckCircle2 size={15} />
          <span>
            <strong>配置诊断</strong>
            <small>Skill、工具和 MCP 基础配置可用。</small>
          </span>
        </div>
      </section>
    );
  }

  return (
    <section className="capability-diagnostics" aria-label="配置诊断">
      <div className="capability-diagnostics-header">
        <AlertTriangle size={15} />
        <span>
          <strong>配置诊断</strong>
          <small>{counts.error} 个错误 · {counts.warning} 个提醒 · {counts.info} 条信息</small>
        </span>
      </div>
      <div className="diagnostic-list">
        {topDiagnostics.map((diagnostic) => {
          const Icon = diagnostic.severity === "error" ? AlertTriangle : diagnostic.severity === "warning" ? Info : CheckCircle2;
          const target = diagnostic.target;
          return (
            <div key={diagnostic.id} className={classNames("diagnostic-row", `is-${diagnostic.severity}`)}>
              <Icon size={14} />
              <span>
                <strong>{diagnostic.title}</strong>
                <small>{diagnostic.detail}</small>
                {diagnostic.action ? <small className="diagnostic-action">{diagnostic.action}</small> : null}
              </span>
              {target ? (
                <button
                  type="button"
                  onClick={() => diagnostic.targetKind === "file"
                    ? postCommand("openWorkspaceFile", { path: target })
                    : postCommand("openSettingsTarget", { settingKey: target })}
                >
                  {diagnostic.actionLabel ?? "打开设置"}
                </button>
              ) : null}
            </div>
          );
        })}
      </div>
    </section>
  );
}

function CapabilityWorkbench({ skills, tools }: { skills: ChoiceItem[]; tools: ChoiceItem[] }): JSX.Element {
  const runnableSkills = skills.filter(isRunnableCapability);
  const runnableTools = tools.filter(isRunnableCapability);
  return (
    <section className="capability-workbench" aria-label="扩展能力工作台">
      <div className="capability-summary-grid">
        <CapabilitySummary label="内置 Skill" value={String(skills.filter((item) => item.kind === "builtin").length)} />
        <CapabilitySummary label="自定义 Skill" value={String(skills.filter((item) => item.kind === "custom").length)} />
        <CapabilitySummary label="MCP 工具" value={String(tools.filter((item) => item.kind === "mcp").length)} />
        <CapabilitySummary label="可执行脚本" value={String(runnableSkills.length + runnableTools.length)} />
      </div>
      <div className="capability-columns">
        <CapabilityColumn title="Skill" type="skill" items={skills} empty="暂无自定义 Skill" />
        <CapabilityColumn title="工具 / MCP" type="tool" items={tools} empty="暂无可用工具" />
      </div>
    </section>
  );
}

function CapabilitySummary({ label, value }: { label: string; value: string }): JSX.Element {
  return (
    <div className="capability-summary">
      <strong>{value}</strong>
      <span>{label}</span>
    </div>
  );
}

function CapabilityColumn({ title, type, items, empty }: { title: string; type: "skill" | "tool"; items: ChoiceItem[]; empty: string }): JSX.Element {
  return (
    <div className="capability-column">
      <div className="capability-column-title">{title}</div>
      <div className="capability-list">
        {items.length === 0 ? <span className="muted-line">{empty}</span> : items.slice(0, 8).map((item) => {
          const Icon = item.icon;
          const canOpenScript = Boolean(item.script);
          const canRun = isRunnableCapability(item);
          return (
            <div key={`${title}-${item.id}`} className="capability-row">
              <Icon size={14} />
              <span>
                <strong>{item.label}</strong>
                <small>{capabilityKindLabel(item.kind)}{item.server ? ` · ${item.server}` : ""}{item.script ? ` · ${item.script}` : ""}</small>
              </span>
              {(canOpenScript || canRun) ? (
                <div className="capability-row-actions">
                  {canOpenScript ? (
                    <button type="button" title="打开脚本文件" onClick={() => postCommand("openWorkspaceFile", { path: item.script })}>
                      <FileCode2 size={12} />
                      打开
                    </button>
                  ) : null}
                  {canRun ? (
                    <button
                      type="button"
                      title="用一段测试输入运行，会先请求页面内审批"
                      onClick={() => postCommand("runCapability", {
                        capabilityType: type,
                        capabilityId: item.id,
                        text: `Patchlane 设置页测试运行：${item.label}`
                      })}
                    >
                      <Play size={12} />
                      测试
                    </button>
                  ) : null}
                </div>
              ) : null}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function CapabilityRunHistoryPanel({ runs }: { runs: CapabilityRunRecord[] }): JSX.Element {
  const visibleRuns = runs.slice(0, 8);
  return (
    <section className="capability-run-history" aria-label="扩展能力运行记录">
      <div className="capability-run-header">
        <span>
          <strong>最近运行</strong>
          <small>记录本会话里手动测试和 Agent 自动调用的 Skill、工具、MCP。</small>
        </span>
        <span>{runs.length} 条</span>
      </div>
      {visibleRuns.length === 0 ? (
        <div className="capability-run-empty">
          <Play size={14} />
          <span>还没有运行记录。点击上方“测试”，或在 Agent 模式选择具体 Skill / MCP 后执行任务。</span>
        </div>
      ) : (
        <div className="capability-run-list">
          {visibleRuns.map((run) => (
            <CapabilityRunRow key={run.id} run={run} />
          ))}
        </div>
      )}
    </section>
  );
}

function CapabilityRunRow({ run }: { run: CapabilityRunRecord }): JSX.Element {
  const StatusIcon = capabilityRunStatusIcon(run.status);
  const output = [run.stdout, run.stderr].filter(Boolean).join("\n\n").trim();
  return (
    <article className={classNames("capability-run-row", `is-${run.status}`)}>
      <StatusIcon size={14} />
      <div className="capability-run-main">
        <div className="capability-run-title">
          <strong title={run.label}>{run.label}</strong>
          <span>{capabilityRunStatusLabel(run.status)}</span>
        </div>
        <div className="capability-run-meta">
          <span>{run.type === "skill" ? "Skill" : "工具"}</span>
          <span>{run.capabilityKind === "mcp" ? "MCP" : run.capabilityKind === "custom" ? "自定义" : "内置"}</span>
          <span>{run.source === "agent" ? "Agent 自动调用" : "设置页测试"}</span>
          {typeof run.exitCode !== "undefined" ? <span>exit {run.exitCode ?? "n/a"}</span> : null}
          {typeof run.durationMs === "number" ? <span>{formatRunDuration(run.durationMs)}</span> : null}
          <span>{formatTime(run.createdAt)}</span>
        </div>
        <p>{run.summary}</p>
        {run.command ? <code title={run.command}>{run.command}</code> : null}
        {output ? (
          <details className="capability-run-output">
            <summary>查看输出摘要</summary>
            <pre>{output}</pre>
            <button type="button" onClick={() => postCommand("copyText", { text: output })}>
              <Copy size={12} />
              复制输出
            </button>
          </details>
        ) : null}
      </div>
    </article>
  );
}

function fileMentionPrefix(draft: string): string {
  if (!draft.trim()) {
    return "";
  }
  return draft.endsWith(" ") ? draft : `${draft} `;
}

function labelChoices(ids: string[], options: ChoiceItem[]): string[] {
  return ids.map((id) => options.find((item) => item.id === id)?.label).filter(Boolean) as string[];
}

function matchChoices(ids: string[], options: ChoiceItem[]): ChoiceItem[] {
  return ids.map((id) => options.find((item) => item.id === id)).filter((item): item is ChoiceItem => Boolean(item));
}

function isRunnableCapability(item: ChoiceItem): boolean {
  return Boolean(item.script || item.command);
}

function approvalTitle(approval: ApprovalPrompt): string {
  switch (approval.kind) {
    case "skill":
      return `运行 Skill：${approval.label}`;
    case "command":
      return `执行命令：${approval.label}`;
    case "web":
      return `联网搜索：${approval.query ?? approval.label}`;
    case "tool":
      return `使用工具：${approval.label}`;
    default:
      return approval.label;
  }
}

function approvalKindLabel(kind: ApprovalPrompt["kind"]): string {
  switch (kind) {
    case "skill":
      return "Skill 审批";
    case "command":
      return "命令审批";
    case "web":
      return "联网审批";
    case "tool":
      return "工具审批";
    default:
      return "审批";
  }
}

function extractMessageContext(content: string): MessageContext {
  const lines = content.split(/\r?\n/);
  const skills: string[] = [];
  const tools: string[] = [];
  let index = 0;

  while (index < lines.length) {
    const line = lines[index].trim();
    const skillMatch = line.match(/^使用 Skill[:：]\s*(.+)$/);
    const toolMatch = line.match(/^可用工具[:：]\s*(.+)$/);

    if (skillMatch) {
      skills.push(...splitContextLabels(skillMatch[1]));
      index += 1;
      continue;
    }

    if (toolMatch) {
      tools.push(...splitContextLabels(toolMatch[1]));
      index += 1;
      continue;
    }

    if (line === "") {
      index += 1;
      continue;
    }

    break;
  }

  return {
    content: lines.slice(index).join("\n").trim() || content,
    skills: uniqueLabels(skills),
    tools: uniqueLabels(tools)
  };
}

function splitContextLabels(value: string): string[] {
  return value.split(/[、,，]/).map((item) => item.trim()).filter(Boolean);
}

function uniqueLabels(values: string[]): string[] {
  return [...new Set(values)];
}

function formatApprovalSummary(approvals?: { trustedTools: string[]; trustedSkills: string[]; trustedCommands: string[] }): string {
  if (!approvals) {
    return "打开会话后会显示已授权的 Skill、工具和命令。";
  }
  return `Skill ${approvals.trustedSkills.length} 个，工具 ${approvals.trustedTools.length} 个，记住命令 ${approvals.trustedCommands.length} 条。`;
}

function displayModelName(model?: string): string {
  if (!model || model === "local") {
    return "Patchlane";
  }
  return model;
}

function fileSourceLabel(file: WorkspaceFileSummary, currentFile?: string): string {
  if (file.path === currentFile || file.source === "active") {
    return "当前文件";
  }
  if (file.source === "open") {
    return "已打开";
  }
  return "工作区";
}

function qualityStatusLabel(status: PatchQualityReport["status"]): string {
  switch (status) {
    case "pass":
      return "通过";
    case "warn":
      return "需注意";
    case "fail":
      return "未通过";
    default:
      return "未知";
  }
}

function qualityStatusIcon(status: PatchQualityReport["status"]): string {
  switch (status) {
    case "pass":
      return "✓";
    case "warn":
      return "!";
    case "fail":
      return "×";
    default:
      return "?";
  }
}

function capabilityRunStatusLabel(status: CapabilityRunRecord["status"]): string {
  switch (status) {
    case "success":
      return "成功";
    case "failed":
      return "失败";
    case "rejected":
      return "已拒绝";
    case "stopped":
      return "已停止";
    case "error":
    default:
      return "异常";
  }
}

function capabilityRunStatusIcon(status: CapabilityRunRecord["status"]): LucideIcon {
  switch (status) {
    case "success":
      return CheckCircle2;
    case "failed":
    case "error":
      return AlertTriangle;
    case "stopped":
      return Square;
    case "rejected":
    default:
      return Info;
  }
}

function formatRunDuration(durationMs: number): string {
  if (!Number.isFinite(durationMs) || durationMs < 0) {
    return "耗时未知";
  }
  if (durationMs < 1000) {
    return `${durationMs}ms`;
  }
  return `${(durationMs / 1000).toFixed(1)}s`;
}

function capabilityOriginLabel(item: ChoiceItem): string {
  if (item.kind === "mcp") {
    return "MCP";
  }
  if (item.kind === "custom") {
    return "自定义";
  }
  return "内置";
}

function findPreviousUserMessageIndex(transcript: TranscriptItem[], beforeIndex: number): number | undefined {
  for (let index = beforeIndex - 1; index >= 0; index -= 1) {
    if (transcript[index]?.role === "user") {
      return index;
    }
  }
  return undefined;
}

function mcpStatusLabel(status?: "notStarted" | "starting" | "running" | "stopped" | "error"): string {
  switch (status) {
    case "running":
      return "运行中";
    case "starting":
      return "启动中";
    case "stopped":
      return "已停止";
    case "error":
      return "异常";
    default:
      return "未启动";
  }
}

function mcpLogLevelLabel(level: "info" | "warning" | "error"): string {
  switch (level) {
    case "error":
      return "错误";
    case "warning":
      return "提醒";
    case "info":
    default:
      return "信息";
  }
}

function contextBudgetLabel(value?: "economy" | "balanced" | "quality"): string {
  switch (value) {
    case "economy":
      return "省 token";
    case "quality":
      return "高质量";
    default:
      return "均衡";
  }
}

function taskKindLabel(kind: "chat" | "agent" | "apply" | "verify" | "capability" | "web"): string {
  switch (kind) {
    case "agent":
      return "Agent";
    case "apply":
      return "应用修改";
    case "verify":
      return "验证";
    case "capability":
      return "扩展能力";
    case "web":
      return "联网";
    case "chat":
    default:
      return "聊天";
  }
}

function canContinueStagedTask(task: ReturnType<typeof useCodeAgentStore.getState>["extensionState"]["patch"]["stagedTask"]): boolean {
  const current = task?.phases[task.currentPhaseIndex];
  return Boolean(current && task?.status !== "done" && (current.status === "applied" || current.status === "done"));
}

function isCurrentStageFailed(task: ReturnType<typeof useCodeAgentStore.getState>["extensionState"]["patch"]["stagedTask"]): boolean {
  return task?.phases[task.currentPhaseIndex]?.status === "failed";
}

function SectionTitle({ title }: { title: string }): JSX.Element {
  return <h2 className="section-title">{title}</h2>;
}

function InfoRow({ label, value }: { label: string; value: string }): JSX.Element {
  return (
    <div className="info-row">
      <span>{label}</span>
      <strong title={value}>{value}</strong>
    </div>
  );
}

function ActionButton({ action }: { action: ActionItem }): JSX.Element {
  const { extensionState } = useCodeAgentStore();
  const disabledReasonText = getDisabledReason(action, extensionState);
  const Icon = action.icon;

  return (
    <button
      type="button"
      disabled={Boolean(disabledReasonText)}
      title={disabledReasonText ?? action.description}
      onClick={() => postCommand(action.command)}
    >
      <Icon size={14} />
      {action.label}
    </button>
  );
}

function isActionDisabled(action: ActionItem, state: ReturnType<typeof useCodeAgentStore.getState>["extensionState"]): boolean {
  return Boolean(getDisabledReason(action, state));
}

function getDisabledReason(action: ActionItem, state: ReturnType<typeof useCodeAgentStore.getState>["extensionState"]): string | undefined {
  if (state.busy) {
    return "正在处理";
  }
  if (action.requiresFile && !state.context.hasFile) {
    return "请先打开一个文件";
  }
  if (action.requiresPatch && !state.patch.pendingPatch) {
    return "暂无待确认修改";
  }
  if (action.requiresStagedTask && !canContinueStagedTask(state.patch.stagedTask)) {
    return "当前阶段尚未完成或没有下一阶段";
  }
  if (action.requiresFailedStage && !isCurrentStageFailed(state.patch.stagedTask)) {
    return "当前阶段没有失败状态";
  }
  if (action.id === "apply" && state.patch.pendingPatch?.quality?.status === "fail") {
    return "质量审查未通过，先修复草稿再应用";
  }
  if (action.requiresBackup && !state.patch.lastBackupId) {
    return "暂无可撤回记录";
  }
  return undefined;
}

function parsePatchPreview(patch?: PatchDraft): PatchFilePreview[] {
  if (!patch?.patchText.trim()) {
    return [];
  }

  const lines = patch.patchText.split(/\r?\n/);
  const files: PatchFilePreview[] = [];
  let index = 0;

  while (index < lines.length) {
    const line = lines[index];
    if (!line.startsWith("--- ")) {
      index += 1;
      continue;
    }

    const oldPath = normalizeDiffHeaderPath(line);
    const nextLine = lines[index + 1] ?? "";
    if (!nextLine.startsWith("+++ ")) {
      index += 1;
      continue;
    }

    const newPath = normalizeDiffHeaderPath(nextLine);
    const rawLines = [line, nextLine];
    index += 2;

    while (index < lines.length && !lines[index].startsWith("--- ") && !lines[index].startsWith("diff --git ")) {
      rawLines.push(lines[index]);
      index += 1;
    }

    const operation = resolvePatchOperation(oldPath, newPath);
    const path = operation === "delete" ? oldPath : newPath;
    const additions = rawLines.filter((item) => item.startsWith("+") && !item.startsWith("+++")).length;
    const deletions = rawLines.filter((item) => item.startsWith("-") && !item.startsWith("---")).length;
    const hunks = rawLines.filter((item) => item.startsWith("@@")).length;
    const patchLabel = patch.files[files.length] ?? `${operation} ${path}`;

    files.push({
      id: `${files.length}-${path}`,
      label: patchLabel,
      path,
      operation,
      additions,
      deletions,
      hunks,
      rawLines
    });
  }

  return files;
}

function normalizeDiffHeaderPath(line: string): string {
  const value = line.replace(/^---\s+/, "").replace(/^\+\+\+\s+/, "").split("\t")[0].trim();
  if (value === "/dev/null") {
    return value;
  }
  return value.replace(/^a\//, "").replace(/^b\//, "");
}

function resolvePatchOperation(oldPath: string, newPath: string): PatchFilePreview["operation"] {
  if (oldPath === "/dev/null") {
    return "create";
  }
  if (newPath === "/dev/null") {
    return "delete";
  }
  if (oldPath !== newPath) {
    return "rename";
  }
  return "modify";
}

function operationLabel(operation: PatchFilePreview["operation"]): string {
  const labels: Record<PatchFilePreview["operation"], string> = {
    create: "新建",
    modify: "修改",
    delete: "删除",
    rename: "重命名"
  };
  return labels[operation];
}

function changePanelDescription(status: ChangeStatus): string {
  switch (status) {
    case "generating":
      return "模型正在生成修改，内容会在这里实时刷新；你可以随时停止。";
    case "reviewing":
      return "模型输出已完成，正在解析和审查修改质量。";
    case "repairing":
      return "质量审查发现问题，正在尝试自动修复草稿。";
    case "stopped":
      return "生成已停止，未完成的草稿不会自动写入工作区。";
    case "failed":
      return "生成失败，下面保留最后收到的内容，方便判断是否需要重试。";
    case "ready":
      return "这些内容还没有写入工作区，请先检查再应用。";
    case "applied":
      return "最近一次已经应用的修改。";
    default:
      return "Agent 生成的文件修改会显示在这里，确认后才会写入工作区。";
  }
}

function changeStatusLabel(status: ChangeStatus): string {
  switch (status) {
    case "generating":
      return "正在生成修改";
    case "reviewing":
      return "正在审查修改";
    case "repairing":
      return "正在修复草稿";
    case "stopped":
      return "已停止生成";
    case "failed":
      return "生成失败";
    case "ready":
      return "待确认修改";
    case "applied":
      return "已应用修改";
    default:
      return "修改结果";
  }
}

function changeStatusClass(status: ChangeStatus): string {
  if (status === "ready") {
    return "is-pending";
  }
  if (status === "applied") {
    return "is-applied";
  }
  if (status === "failed") {
    return "is-failed";
  }
  if (status === "stopped") {
    return "is-stopped";
  }
  if (status === "generating" || status === "reviewing" || status === "repairing") {
    return "is-live";
  }
  return "is-empty";
}

function stagedTaskStatusLabel(status: "active" | "failed" | "done"): string {
  switch (status) {
    case "done":
      return "已完成";
    case "failed":
      return "当前阶段失败";
    case "active":
    default:
      return "执行中";
  }
}

function stagePhaseStatusLabel(status: "pending" | "generating" | "ready" | "applied" | "verifying" | "failed" | "done"): string {
  switch (status) {
    case "pending":
      return "待执行";
    case "generating":
      return "生成中";
    case "ready":
      return "待应用";
    case "applied":
      return "已应用";
    case "verifying":
      return "验证中";
    case "failed":
      return "失败";
    case "done":
      return "完成";
  }
}

function stagePhaseIcon(status: "pending" | "generating" | "ready" | "applied" | "verifying" | "failed" | "done"): string {
  switch (status) {
    case "done":
      return "✓";
    case "failed":
      return "!";
    case "generating":
    case "verifying":
      return "…";
    case "ready":
    case "applied":
      return "•";
    case "pending":
    default:
      return "";
  }
}

function diffLineClass(line: string): string {
  if (line.startsWith("+") && !line.startsWith("+++")) {
    return "is-add";
  }
  if (line.startsWith("-") && !line.startsWith("---")) {
    return "is-remove";
  }
  if (line.startsWith("@@")) {
    return "is-hunk";
  }
  if (line.startsWith("---") || line.startsWith("+++")) {
    return "is-header";
  }
  return "is-context";
}

function diffMarker(line: string): string {
  if (line.startsWith("+") && !line.startsWith("+++")) {
    return "+";
  }
  if (line.startsWith("-") && !line.startsWith("---")) {
    return "-";
  }
  if (line.startsWith("@@")) {
    return "@";
  }
  return "";
}
