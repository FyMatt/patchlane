import * as vscode from "vscode";

export type ApprovalKind = "tool" | "command" | "skill" | "web";

export interface ToolApprovalRequest {
  sessionId: string;
  toolId: string;
  label: string;
  reason?: string;
}

export interface WebApprovalRequest extends ToolApprovalRequest {
  query: string;
  provider: string;
  allowDomains?: string[];
}

export interface CommandApprovalRequest extends ToolApprovalRequest {
  command: string;
  cwd?: string;
}

export interface SkillApprovalRequest {
  sessionId: string;
  skillId: string;
  label: string;
  script?: string;
  reason?: string;
}

export interface ApprovalSnapshot {
  trustedTools: string[];
  trustedSkills: string[];
  trustedCommands: string[];
}

export interface ApprovalPromptRequest {
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

export type ApprovalDecision = "approveOnce" | "approveSession" | "reject";
export type ApprovalResult = "approved" | "rejected";
export type ApprovalPromptHandler = (request: ApprovalPromptRequest) => Promise<ApprovalDecision>;

export class ApprovalService {
  private readonly trustedToolsBySession = new Map<string, Set<string>>();
  private readonly trustedSkillsBySession = new Map<string, Set<string>>();
  private readonly trustedCommandsBySession = new Map<string, Set<string>>();
  private readonly promptHandlersBySession = new Map<string, ApprovalPromptHandler>();

  public registerPromptHandler(sessionId: string, handler: ApprovalPromptHandler): vscode.Disposable {
    this.promptHandlersBySession.set(sessionId, handler);
    return {
      dispose: () => {
        if (this.promptHandlersBySession.get(sessionId) === handler) {
          this.promptHandlersBySession.delete(sessionId);
        }
      }
    };
  }

  public getSnapshot(sessionId: string): ApprovalSnapshot {
    return {
      trustedTools: [...(this.trustedToolsBySession.get(sessionId) ?? new Set<string>())],
      trustedSkills: [...(this.trustedSkillsBySession.get(sessionId) ?? new Set<string>())],
      trustedCommands: [...(this.trustedCommandsBySession.get(sessionId) ?? new Set<string>())]
    };
  }

  public clearSession(sessionId: string): void {
    this.trustedToolsBySession.delete(sessionId);
    this.trustedSkillsBySession.delete(sessionId);
    this.trustedCommandsBySession.delete(sessionId);
  }

  public async ensureToolApproval(request: ToolApprovalRequest): Promise<ApprovalResult> {
    const trustedTools = getOrCreateSet(this.trustedToolsBySession, request.sessionId);
    if (trustedTools.has(request.toolId)) {
      return "approved";
    }

    const handled = await this.tryRequestApproval({
      id: createApprovalId(),
      kind: "tool",
      sessionId: request.sessionId,
      targetId: request.toolId,
      label: request.label,
      reason: request.reason,
      rememberable: false
    });
    if (handled) {
      if (handled === "approveSession") {
        trustedTools.add(request.toolId);
        return "approved";
      }
      return "rejected";
    }

    const choice = await vscode.window.showWarningMessage(
      [
        `允许本会话使用工具 "${request.label}" 吗？`,
        request.reason ? `用途：${request.reason}` : undefined,
        "同一个会话里同一个工具审批一次即可。"
      ].filter(Boolean).join("\n"),
      { modal: true },
      "允许本会话",
      "拒绝"
    );

    if (choice === "允许本会话") {
      trustedTools.add(request.toolId);
      return "approved";
    }

    return "rejected";
  }

  public async ensureSkillApproval(request: SkillApprovalRequest): Promise<ApprovalResult> {
    const trustedSkills = getOrCreateSet(this.trustedSkillsBySession, request.sessionId);
    if (trustedSkills.has(request.skillId)) {
      return "approved";
    }

    const handled = await this.tryRequestApproval({
      id: createApprovalId(),
      kind: "skill",
      sessionId: request.sessionId,
      targetId: request.skillId,
      label: request.label,
      reason: request.reason,
      script: request.script,
      rememberable: false
    });
    if (handled) {
      if (handled === "approveSession") {
        trustedSkills.add(request.skillId);
        return "approved";
      }
      return "rejected";
    }

    const choice = await vscode.window.showWarningMessage(
      [
        `允许本会话使用 Skill "${request.label}" 吗？`,
        request.script ? `脚本：${request.script}` : undefined,
        request.reason ? `用途：${request.reason}` : undefined,
        "Skill 可兼容 Claude、GPT、DeepSeek 等模型，但脚本执行必须先审批。"
      ].filter(Boolean).join("\n"),
      { modal: true },
      "允许本会话",
      "拒绝"
    );

    if (choice === "允许本会话") {
      trustedSkills.add(request.skillId);
      return "approved";
    }

    return "rejected";
  }

  public async ensureWebSearchApproval(request: WebApprovalRequest): Promise<ApprovalResult> {
    const trustedTools = getOrCreateSet(this.trustedToolsBySession, request.sessionId);
    const key = `web:${request.provider}:${request.query.trim()}`;
    if (trustedTools.has(key)) {
      return "approved";
    }

    const handled = await this.tryRequestApproval({
      id: createApprovalId(),
      kind: "web",
      sessionId: request.sessionId,
      targetId: key,
      label: "联网搜索",
      reason: request.reason ?? "查询最新网页资料",
      query: request.query,
      provider: request.provider,
      allowDomains: request.allowDomains,
      rememberable: true
    });
    if (handled) {
      if (handled === "approveSession") {
        trustedTools.add(key);
        return "approved";
      }
      return handled === "approveOnce" ? "approved" : "rejected";
    }

    const domainText = request.allowDomains && request.allowDomains.length > 0 ? `允许域名：${request.allowDomains.join("、")}` : undefined;
    const choice = await vscode.window.showWarningMessage(
      [
        `允许本会话进行联网搜索吗？`,
        `查询：${request.query}`,
        `服务商：${request.provider}`,
        domainText,
        request.reason ? `用途：${request.reason}` : undefined,
        "同一个会话中同一个搜索查询可以记住一次。"
      ].filter(Boolean).join("\n"),
      { modal: true },
      "允许一次",
      "允许本会话",
      "拒绝"
    );

    if (choice === "允许本会话") {
      trustedTools.add(key);
      return "approved";
    }
    return choice === "允许一次" ? "approved" : "rejected";
  }

  public async ensureCommandApproval(request: CommandApprovalRequest): Promise<ApprovalResult> {
    const commandKey = buildCommandKey(request.toolId, request.command);
    const trustedCommands = getOrCreateSet(this.trustedCommandsBySession, request.sessionId);
    if (trustedCommands.has(commandKey)) {
      return "approved";
    }

    const handled = await this.tryRequestApproval({
      id: createApprovalId(),
      kind: "command",
      sessionId: request.sessionId,
      targetId: commandKey,
      label: request.label,
      reason: request.reason,
      command: request.command,
      cwd: request.cwd,
      rememberable: true
    });
    if (handled) {
      if (handled === "approveSession") {
        trustedCommands.add(commandKey);
        return "approved";
      }
      return handled === "approveOnce" ? "approved" : "rejected";
    }

    const choice = await vscode.window.showWarningMessage(
      [
        `工具 "${request.label}" 想执行命令：`,
        request.command,
        request.cwd ? `目录：${request.cwd}` : undefined,
        "命令默认每次都要审批。选择“本会话记住此命令”后，仅这条命令在当前会话内自动放行。"
      ].filter(Boolean).join("\n"),
      { modal: true },
      "允许一次",
      "本会话记住此命令",
      "拒绝"
    );

    if (choice === "本会话记住此命令") {
      trustedCommands.add(commandKey);
      return "approved";
    }

    return choice === "允许一次" ? "approved" : "rejected";
  }

  private async tryRequestApproval(request: ApprovalPromptRequest): Promise<ApprovalDecision | undefined> {
    const handler = this.promptHandlersBySession.get(request.sessionId);
    if (!handler) {
      return undefined;
    }
    return handler(request);
  }
}

function getOrCreateSet(map: Map<string, Set<string>>, key: string): Set<string> {
  const existing = map.get(key);
  if (existing) {
    return existing;
  }

  const next = new Set<string>();
  map.set(key, next);
  return next;
}

function buildCommandKey(toolId: string, command: string): string {
  return `${toolId}:${command.trim()}`;
}

function createApprovalId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}
