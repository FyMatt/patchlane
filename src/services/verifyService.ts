import * as cp from "child_process";
import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";
import { getConfig } from "../config";
import { buildScopedVerifyPlan, ScopedVerifyPlan } from "./verifyPlanner";

export interface VerifyResult {
  command: string;
  exitCode: number | null;
  output: string;
  keyLines?: string[];
  durationMs: number;
  aborted?: boolean;
  failureKind?: VerifyFailureKind;
  summary?: string;
}

export interface VerifyRunOptions {
  signal?: AbortSignal;
}

export type VerifyFailureKind =
  | "pass"
  | "typescript"
  | "test"
  | "lint"
  | "build"
  | "missingDependency"
  | "runtime"
  | "timeout"
  | "aborted"
  | "unknown";

export interface VerifySuiteOptions extends VerifyRunOptions {
  commands?: string[];
  stopOnFailure?: boolean;
  onCommandStart?: (command: string, index: number, total: number) => void;
  onCommandResult?: (result: VerifyResult, index: number, total: number) => void;
}

export interface VerifySuiteResult {
  commands: string[];
  results: VerifyResult[];
  passed: boolean;
  failedCommand?: string;
  failureKind: VerifyFailureKind;
  durationMs: number;
  aborted?: boolean;
}

export class VerifyService {
  public getConfiguredCommands(): string[] {
    const config = getConfig();
    const inspected = config.inspect<string[]>("verify.commands");
    const explicit = inspected?.workspaceFolderValue ?? inspected?.workspaceValue ?? inspected?.globalValue;
    const explicitCommands = normalizeCommands(explicit);
    if (explicitCommands.length > 0) {
      return explicitCommands;
    }

    const discovered = this.discoverWorkspaceCommands();
    if (discovered.length > 0) {
      return discovered;
    }

    return normalizeCommands(inspected?.defaultValue ?? ["npm test"]);
  }

  public getScopedCommands(changedFiles: string[] = []): ScopedVerifyPlan {
    return buildScopedVerifyPlan(this.getConfiguredCommands(), changedFiles);
  }

  public getWorkspaceRoot(): string {
    const folder = vscode.workspace.workspaceFolders?.[0];
    if (!folder) {
      throw new Error("运行验证命令前请先打开一个工作区文件夹。");
    }

    return folder.uri.fsPath;
  }

  public async run(command: string, options: VerifyRunOptions = {}): Promise<VerifyResult> {
    const cwd = this.getWorkspaceRoot();
    const startedAt = Date.now();

    return new Promise((resolve) => {
      const child = cp.exec(command, { cwd, maxBuffer: 1024 * 1024 * 10, windowsHide: true }, (error, stdout, stderr) => {
        const output = [stdout.trim(), stderr.trim()].filter(Boolean).join("\n") || "(no output)";
        const aborted = options.signal?.aborted;
        const exitCode = typeof error?.code === "number" ? error.code : 0;
        const failureKind = classifyVerifyFailure(command, output, exitCode, aborted);
        resolve({
          command,
          exitCode,
          output,
          keyLines: extractVerifyKeyLines(output),
          durationMs: Date.now() - startedAt,
          aborted,
          failureKind,
          summary: summarizeVerifyResult(command, output, exitCode, failureKind, aborted)
        });
      });

      if (options.signal) {
        if (options.signal.aborted) {
          child.kill();
          return;
        }
        options.signal.addEventListener("abort", () => child.kill(), { once: true });
      }
    });
  }

  public async runSuite(options: VerifySuiteOptions = {}): Promise<VerifySuiteResult> {
    const commands = (options.commands ?? this.getConfiguredCommands()).filter((command) => command.trim().length > 0);
    const startedAt = Date.now();
    const results: VerifyResult[] = [];
    const stopOnFailure = options.stopOnFailure !== false;

    for (const [index, command] of commands.entries()) {
      if (options.signal?.aborted) {
        break;
      }
      options.onCommandStart?.(command, index, commands.length);
      const result = await this.run(command, { signal: options.signal });
      results.push(result);
      options.onCommandResult?.(result, index, commands.length);
      if (result.aborted || (stopOnFailure && result.exitCode !== 0)) {
        break;
      }
    }

    const firstFailed = results.find((result) => result.aborted || result.exitCode !== 0);
    return {
      commands,
      results,
      passed: commands.length > 0 && results.length === commands.length && results.every((result) => !result.aborted && result.exitCode === 0),
      failedCommand: firstFailed?.command,
      failureKind: firstFailed?.failureKind ?? (commands.length === 0 ? "unknown" : "pass"),
      durationMs: Date.now() - startedAt,
      aborted: results.some((result) => result.aborted) || options.signal?.aborted
    };
  }

  private discoverWorkspaceCommands(): string[] {
    const folder = vscode.workspace.workspaceFolders?.[0];
    if (!folder) {
      return [];
    }

    const root = folder.uri.fsPath;
    const commands: string[] = [];
    const packageJson = readJsonFile(path.join(root, "package.json"));
    if (packageJson && typeof packageJson === "object") {
      const scripts = (packageJson as { scripts?: Record<string, unknown> }).scripts ?? {};
      const packageRunner = detectPackageRunner(root);
      for (const script of ["typecheck", "test", "lint", "build"]) {
        if (typeof scripts[script] === "string") {
          commands.push(formatPackageScriptCommand(packageRunner, script));
        }
      }
    }

    if (fileExists(path.join(root, "go.mod"))) {
      commands.push("go test ./...");
    }
    if (fileExists(path.join(root, "Cargo.toml"))) {
      commands.push("cargo test");
    }
    if (fileExists(path.join(root, "pyproject.toml"))) {
      commands.push("python -m pytest");
    } else if (fileExists(path.join(root, "pytest.ini")) || fileExists(path.join(root, "requirements.txt"))) {
      commands.push("python -m pytest");
    }

    return [...new Set(commands)].slice(0, 4);
  }
}

function normalizeCommands(commands?: string[]): string[] {
  return [...new Set((commands ?? []).map((command) => command.trim()).filter(Boolean))];
}

function readJsonFile(filePath: string): unknown {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8")) as unknown;
  } catch {
    return undefined;
  }
}

function fileExists(filePath: string): boolean {
  try {
    return fs.statSync(filePath).isFile();
  } catch {
    return false;
  }
}

function detectPackageRunner(root: string): "npm" | "pnpm" | "yarn" | "bun" {
  if (fileExists(path.join(root, "pnpm-lock.yaml"))) {
    return "pnpm";
  }
  if (fileExists(path.join(root, "yarn.lock"))) {
    return "yarn";
  }
  if (fileExists(path.join(root, "bun.lock")) || fileExists(path.join(root, "bun.lockb"))) {
    return "bun";
  }
  return "npm";
}

function formatPackageScriptCommand(runner: "npm" | "pnpm" | "yarn" | "bun", script: string): string {
  if (runner === "npm") {
    return script === "test" ? "npm test" : `npm run ${script}`;
  }
  if (runner === "pnpm") {
    return script === "test" ? "pnpm test" : `pnpm run ${script}`;
  }
  if (runner === "yarn") {
    return script === "test" ? "yarn test" : `yarn ${script}`;
  }
  return script === "test" ? "bun test" : `bun run ${script}`;
}

export function classifyVerifyFailure(command: string, output: string, exitCode: number | null, aborted?: boolean): VerifyFailureKind {
  if (aborted) {
    return "aborted";
  }
  if (exitCode === 0) {
    return "pass";
  }
  const text = `${command}\n${output}`.toLowerCase();
  if (/timed out|timeout|etimedout/.test(text)) {
    return "timeout";
  }
  if (/cannot find module|module not found|command not found|not recognized as|enoent|missing script|找不到|无法识别/.test(text)) {
    return "missingDependency";
  }
  if (/tsc|typescript|type error|ts\d{4}|typecheck|类型/.test(text)) {
    return "typescript";
  }
  if (/eslint|lint|prettier|stylelint|格式|规则/.test(text)) {
    return "lint";
  }
  if (/jest|vitest|mocha|playwright|cypress|assert|expect|test failed|failed tests|测试/.test(text)) {
    return "test";
  }
  if (/build|webpack|vite|rollup|esbuild|compil|编译|构建/.test(text)) {
    return "build";
  }
  if (/exception|traceback|stack trace|runtime|panic|segmentation|崩溃|异常/.test(text)) {
    return "runtime";
  }
  return "unknown";
}

export function extractVerifyKeyLines(output: string, limit = 10): string[] {
  const seen = new Set<string>();
  const usefulLines = output
    .split(/\r?\n/)
    .map((line) => line.trim().replace(/\s+/g, " "))
    .filter((line) => {
      if (!line || seen.has(line) || isVerifyNoiseLine(line)) {
        return false;
      }
      seen.add(line);
      return true;
    });

  const priorityLines = usefulLines.filter((line) => isVerifyPriorityLine(line));
  return (priorityLines.length > 0 ? priorityLines : usefulLines).slice(0, limit);
}

function summarizeVerifyResult(command: string, output: string, exitCode: number | null, failureKind: VerifyFailureKind, aborted?: boolean): string {
  if (aborted) {
    return `命令已停止：${command}`;
  }
  if (exitCode === 0) {
    return `验证通过：${command}`;
  }
  const firstUsefulLine = extractVerifyKeyLines(output, 1)[0];
  return `${failureKindLabel(failureKind)}：${firstUsefulLine ?? command}`;
}

function isVerifyNoiseLine(line: string): boolean {
  return /^(>|npm|yarn|pnpm|bun|run-script|lifecycle|found \d+ vulnerabilities|audited \d+ packages|added \d+ packages|up to date)/i.test(line);
}

function isVerifyPriorityLine(line: string): boolean {
  return /(\berror\b|\bfailed\b|\bfailure\b|\bexpected\b|\breceived\b|\bassert\b|ts\d{4}|eslint|prettier|cannot|not found|exception|traceback|stack trace|:\d+:\d+|^\s*at\s+)/i.test(line);
}

function failureKindLabel(kind: VerifyFailureKind): string {
  switch (kind) {
    case "typescript":
      return "类型检查失败";
    case "test":
      return "测试失败";
    case "lint":
      return "代码规范失败";
    case "build":
      return "构建失败";
    case "missingDependency":
      return "依赖或命令缺失";
    case "runtime":
      return "运行时错误";
    case "timeout":
      return "验证超时";
    case "aborted":
      return "验证已停止";
    case "pass":
      return "验证通过";
    default:
      return "验证失败";
  }
}
