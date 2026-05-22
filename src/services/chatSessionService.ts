import * as vscode from "vscode";

export type ChatMode = "chat" | "agent";

export type ChatTranscriptKind = "chat" | "codeExplanation" | "local" | "agentProgress" | "webSearch" | "taskInterrupted";
export type ChatProgressStatus = "pending" | "running" | "done" | "error";

export interface ChatProgressStep {
  label: string;
  status: ChatProgressStatus;
  detail?: string;
  kind?: "think" | "tool" | "file" | "approval" | "model" | "patch" | "verify";
  startedAt?: string;
  endedAt?: string;
}

export interface ChatTranscriptItem {
  role: "user" | "assistant";
  content: string;
  model?: string;
  mode?: ChatMode;
  createdAt: string;
  skillIds?: string[];
  toolIds?: string[];
  kind?: ChatTranscriptKind;
  title?: string;
  file?: string;
  selection?: string;
  sources?: Array<{
    title: string;
    url: string;
    snippet?: string;
    source?: string;
    publishedAt?: string;
    updatedAt?: string;
    trustLabel?: "official" | "docs" | "github" | "news" | "community" | "unknown";
    citation?: string;
    isOfficial?: boolean;
  }>;
  status?: Exclude<ChatProgressStatus, "pending">;
  progressSteps?: ChatProgressStep[];
}

export interface ChatSession {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  messages: ChatTranscriptItem[];
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

const STORAGE_KEY = "codeAgent.workspaceSessions.v1";

export class ChatSessionService {
  public constructor(private readonly state: vscode.Memento) {}

  public getSessions(): ChatSession[] {
    return this.readSessions().sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  }

  public getSession(id: string): ChatSession | undefined {
    return this.readSessions().find((session) => session.id === id);
  }

  public async createSession(title = "新会话"): Promise<ChatSession> {
    const now = new Date().toISOString();
    const session: ChatSession = {
      id: createId(),
      title,
      createdAt: now,
      updatedAt: now,
      messages: [],
      capabilityRuns: [],
      taskState: undefined
    };
    await this.writeSessions([session, ...this.readSessions()]);
    return session;
  }

  public async updateMessages(id: string, messages: ChatTranscriptItem[]): Promise<ChatSession> {
    const sessions = this.readSessions();
    const index = sessions.findIndex((session) => session.id === id);
    if (index === -1) {
      throw new Error(`Chat session not found: ${id}`);
    }

    const current = sessions[index];
    const title = (current.title === "New chat" || current.title === "新会话") && messages.length > 0
      ? createTitle(messages.find((message) => message.role === "user")?.content ?? current.title)
      : current.title;

    const updated: ChatSession = {
      ...current,
      title,
      messages,
      updatedAt: new Date().toISOString(),
      taskState: current.taskState
    };
    sessions[index] = updated;
    await this.writeSessions(sessions);
    return updated;
  }

  public async updateTaskState(id: string, taskState: ChatSessionTaskState | undefined): Promise<ChatSession | undefined> {
    const sessions = this.readSessions();
    const index = sessions.findIndex((session) => session.id === id);
    if (index === -1) {
      return undefined;
    }

    sessions[index] = {
      ...sessions[index],
      taskState,
      updatedAt: new Date().toISOString()
    };
    await this.writeSessions(sessions);
    return sessions[index];
  }

  public async addCapabilityRun(id: string, record: CapabilityRunRecord): Promise<ChatSession | undefined> {
    const sessions = this.readSessions();
    const index = sessions.findIndex((session) => session.id === id);
    if (index === -1) {
      return undefined;
    }

    sessions[index] = {
      ...sessions[index],
      capabilityRuns: [record, ...(sessions[index].capabilityRuns ?? [])].slice(0, 30),
      updatedAt: new Date().toISOString()
    };
    await this.writeSessions(sessions);
    return sessions[index];
  }

  public async renameSession(id: string, title: string): Promise<void> {
    const sessions = this.readSessions();
    const index = sessions.findIndex((session) => session.id === id);
    if (index === -1) {
      return;
    }

    sessions[index] = {
      ...sessions[index],
      title: title.trim() || "未命名会话",
      updatedAt: new Date().toISOString()
    };
    await this.writeSessions(sessions);
  }

  public async deleteSession(id: string): Promise<void> {
    await this.writeSessions(this.readSessions().filter((session) => session.id !== id));
  }

  private readSessions(): ChatSession[] {
    return this.state.get<ChatSession[]>(STORAGE_KEY, []);
  }

  private async writeSessions(sessions: ChatSession[]): Promise<void> {
    await this.state.update(STORAGE_KEY, sessions.slice(0, 80));
  }
}

function createTitle(content: string): string {
  const normalized = content.replace(/\s+/g, " ").trim();
  if (!normalized) {
    return "新会话";
  }
  return normalized.length > 46 ? `${normalized.slice(0, 46)}...` : normalized;
}

function createId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}
