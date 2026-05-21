import * as cp from "child_process";
import * as fs from "fs/promises";
import * as path from "path";
import * as vscode from "vscode";
import { AgentCapabilityConfig } from "../config";
import { ApprovalService } from "./approvalService";
import { McpClientService } from "./mcpClient";

export type CapabilityRunKind = "skill" | "tool";

export interface CapabilityRunRequest {
  sessionId: string;
  kind: CapabilityRunKind;
  capability: AgentCapabilityConfig;
  input?: string;
  signal?: AbortSignal;
}

export interface CapabilityRunResult {
  capabilityId: string;
  label: string;
  command: string;
  cwd: string;
  exitCode: number | null;
  stdout: string;
  stderr: string;
}

interface CommandSpec {
  executable: string;
  args: string[];
  displayCommand: string;
}

const MAX_OUTPUT_BYTES = 1024 * 1024 * 8;

export class CapabilityRunner {
  public constructor(
    private readonly approvals: ApprovalService,
    private readonly mcpClient?: McpClientService
  ) {}

  public async run(request: CapabilityRunRequest): Promise<CapabilityRunResult | undefined> {
    const workspaceRoot = getWorkspaceRoot();
    const capability = request.capability;
    if (request.kind === "tool" && capability.kind === "mcp" && capability.server && capability.command && this.mcpClient) {
      return this.runMcpTool(request, workspaceRoot);
    }

    const scriptPath = capability.script ? resolveWorkspacePath(workspaceRoot, capability.script) : undefined;
    const commandSpec = await buildCommandSpec(capability, workspaceRoot, scriptPath);

    const capabilityApproved = request.kind === "skill"
      ? await this.approvals.ensureSkillApproval({
          sessionId: request.sessionId,
          skillId: capability.id,
          label: capability.label,
          script: capability.script,
          reason: "运行 Skill 脚本"
        })
      : await this.approvals.ensureToolApproval({
          sessionId: request.sessionId,
          toolId: capability.id,
          label: capability.label,
          reason: capability.kind === "mcp" ? "运行 MCP 工具脚本" : "运行工具脚本"
        });

    if (capabilityApproved !== "approved") {
      return undefined;
    }

    const commandApproved = await this.approvals.ensureCommandApproval({
      sessionId: request.sessionId,
      toolId: `${request.kind}:${capability.id}`,
      label: capability.label,
      command: commandSpec.displayCommand,
      cwd: workspaceRoot,
      reason: "执行工作区内声明的扩展脚本"
    });

    if (commandApproved !== "approved") {
      return undefined;
    }

    const result = await execFile(commandSpec.executable, commandSpec.args, workspaceRoot, request.input, request.signal);
    return {
      capabilityId: capability.id,
      label: capability.label,
      command: commandSpec.displayCommand,
      cwd: workspaceRoot,
      ...result
    };
  }

  private async runMcpTool(request: CapabilityRunRequest, workspaceRoot: string): Promise<CapabilityRunResult | undefined> {
    const capability = request.capability;
    if (!capability.server || !capability.command || !this.mcpClient) {
      throw new Error(`${capability.label} 缺少 MCP server 或 tool 配置。`);
    }

    const capabilityApproved = await this.approvals.ensureToolApproval({
      sessionId: request.sessionId,
      toolId: capability.id,
      label: capability.label,
      reason: `调用 MCP 服务 ${capability.server} 的工具 ${capability.command}`
    });
    if (capabilityApproved !== "approved") {
      return undefined;
    }

    const commandText = `mcp://${capability.server}/${capability.command}`;
    const commandApproved = await this.approvals.ensureCommandApproval({
      sessionId: request.sessionId,
      toolId: `mcp:${capability.id}`,
      label: capability.label,
      command: commandText,
      cwd: workspaceRoot,
      reason: "调用 MCP 工具，参数来自当前输入。"
    });
    if (commandApproved !== "approved") {
      return undefined;
    }

    const result = await this.mcpClient.callTool(capability.server, capability.command, request.input, { signal: request.signal });
    return {
      capabilityId: capability.id,
      label: capability.label,
      command: commandText,
      cwd: workspaceRoot,
      exitCode: 0,
      stdout: result.content,
      stderr: ""
    };
  }
}

function getWorkspaceRoot(): string {
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (!folder) {
    throw new Error("运行 Skill 或 MCP 前请先打开一个工作区文件夹。");
  }
  return folder.uri.fsPath;
}

function resolveWorkspacePath(workspaceRoot: string, value: string): string {
  const resolved = path.resolve(workspaceRoot, replaceWorkspaceToken(value, workspaceRoot));
  const relative = path.relative(workspaceRoot, resolved);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`脚本必须位于当前工作区内：${value}`);
  }
  return resolved;
}

async function buildCommandSpec(capability: AgentCapabilityConfig, workspaceRoot: string, scriptPath?: string): Promise<CommandSpec> {
  const runtime = capability.runtime ?? inferRuntime(capability.script);
  const staticArgs = (capability.args ?? []).map((arg) => replaceWorkspaceToken(arg, workspaceRoot));

  if (scriptPath) {
    await ensureFileExists(scriptPath);
  }

  if (runtime === "node" || runtime === "mcp") {
    if (!scriptPath) {
      throw new Error(`${capability.label} 缺少 script 配置。`);
    }
    const args = [scriptPath, ...staticArgs];
    return {
      executable: "node",
      args,
      displayCommand: formatCommand("node", args)
    };
  }

  if (runtime === "python") {
    if (!scriptPath) {
      throw new Error(`${capability.label} 缺少 script 配置。`);
    }
    const args = [scriptPath, ...staticArgs];
    return {
      executable: process.platform === "win32" ? "python" : "python3",
      args,
      displayCommand: formatCommand(process.platform === "win32" ? "python" : "python3", args)
    };
  }

  if (runtime === "shell") {
    const executable = scriptPath ?? capability.command;
    if (!executable) {
      throw new Error(`${capability.label} 缺少 script 或 command 配置。`);
    }
    return {
      executable,
      args: staticArgs,
      displayCommand: formatCommand(executable, staticArgs)
    };
  }

  const executable = capability.command ?? scriptPath;
  if (!executable) {
    throw new Error(`${capability.label} 缺少可执行 command 或 script 配置。`);
  }
  return {
    executable,
    args: staticArgs,
    displayCommand: formatCommand(executable, staticArgs)
  };
}

function inferRuntime(script?: string): NonNullable<AgentCapabilityConfig["runtime"]> {
  if (!script) {
    return "custom";
  }

  const extension = path.extname(script).toLowerCase();
  if (extension === ".js" || extension === ".mjs" || extension === ".cjs") {
    return "node";
  }
  if (extension === ".py") {
    return "python";
  }
  if (extension === ".sh" || extension === ".cmd" || extension === ".bat" || extension === ".ps1") {
    return "shell";
  }
  return "custom";
}

async function ensureFileExists(filePath: string): Promise<void> {
  const stat = await fs.stat(filePath).catch(() => undefined);
  if (!stat?.isFile()) {
    throw new Error(`找不到脚本文件：${filePath}`);
  }
}

function replaceWorkspaceToken(value: string, workspaceRoot: string): string {
  return value.replace(/\$\{workspaceFolder\}/g, workspaceRoot);
}

function formatCommand(executable: string, args: string[]): string {
  return [executable, ...args].map(quoteArg).join(" ");
}

function quoteArg(value: string): string {
  if (!/[\s"']/.test(value)) {
    return value;
  }
  return `"${value.replace(/"/g, '\\"')}"`;
}

function execFile(executable: string, args: string[], cwd: string, input?: string, signal?: AbortSignal): Promise<Omit<CapabilityRunResult, "capabilityId" | "label" | "command" | "cwd">> {
  return new Promise((resolve) => {
    const child = cp.spawn(executable, args, {
      cwd,
      shell: false,
      windowsHide: true,
      env: {
        ...process.env,
        PATCHLANE_WORKSPACE: cwd
      }
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];

    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.on("error", (error) => {
      resolve({
        exitCode: null,
        stdout: "",
        stderr: error.message
      });
    });
    child.on("close", (exitCode) => {
      resolve({
        exitCode,
        stdout: limitOutput(Buffer.concat(stdout).toString("utf8")),
        stderr: signal?.aborted
          ? limitOutput([Buffer.concat(stderr).toString("utf8"), "已停止执行。"].filter(Boolean).join("\n"))
          : limitOutput(Buffer.concat(stderr).toString("utf8"))
      });
    });

    if (signal) {
      if (signal.aborted) {
        child.kill();
      } else {
        signal.addEventListener("abort", () => child.kill(), { once: true });
      }
    }

    if (input) {
      child.stdin.write(input);
    }
    child.stdin.end();
  });
}

function limitOutput(value: string): string {
  if (Buffer.byteLength(value, "utf8") <= MAX_OUTPUT_BYTES) {
    return value.trim();
  }
  return `${value.slice(0, MAX_OUTPUT_BYTES)}\n\n[output truncated]`;
}
