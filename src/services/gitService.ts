import * as cp from "child_process";
import * as vscode from "vscode";
import { parseGitStatus, type GitRepositorySnapshot } from "./gitStatusParser";
export type { GitFileChange, GitRepositorySnapshot } from "./gitStatusParser";

export class GitService {
  public async status(): Promise<string> {
    return this.runGit(["status", "--short", "--branch"]);
  }

  public async structuredStatus(): Promise<GitRepositorySnapshot> {
    const raw = await this.status();
    return parseGitStatus(raw);
  }

  public async diff(args: string[]): Promise<string> {
    return this.runGit(["diff", ...args]);
  }

  public async diffFile(path: string, staged = false): Promise<string> {
    const args = staged ? ["diff", "--cached", "--", path] : ["diff", "--", path];
    return this.runGit(args);
  }

  public async combinedDiffFile(path: string): Promise<string> {
    const unstaged = await this.diffFile(path, false);
    const staged = await this.diffFile(path, true);
    const parts = [
      unstaged && unstaged !== "(no output)" ? ["Unstaged diff:", unstaged].join("\n") : "",
      staged && staged !== "(no output)" ? ["Staged diff:", staged].join("\n") : ""
    ].filter(Boolean);

    return parts.join("\n\n") || "(no output)";
  }

  public async currentDiffForPrompt(): Promise<string> {
    return this.runGit(["diff", "--patch"]);
  }

  public async log(): Promise<string> {
    return this.runGit(["log", "--oneline", "--decorate", "-n", "20"]);
  }

  public async currentBranch(): Promise<string> {
    return this.runGit(["branch", "--show-current"]);
  }

  public async stage(paths: string[]): Promise<string> {
    return this.runGit(["add", "--", ...paths]);
  }

  public async stageAll(): Promise<string> {
    return this.runGit(["add", "-A"]);
  }

  public async unstage(paths: string[]): Promise<string> {
    return this.runGit(["restore", "--staged", "--", ...paths]);
  }

  public async unstageAll(): Promise<string> {
    return this.runGit(["restore", "--staged", "--", "."]);
  }

  public async commit(message: string): Promise<string> {
    return this.runGit(["commit", "-m", message]);
  }

  public async createBranch(name: string): Promise<string> {
    return this.runGit(["checkout", "-b", name]);
  }

  public async checkoutBranch(name: string): Promise<string> {
    return this.runGit(["checkout", name]);
  }

  public async stashPush(message?: string): Promise<string> {
    const args = message ? ["stash", "push", "-u", "-m", message] : ["stash", "push", "-u"];
    return this.runGit(args);
  }

  public async stashPop(): Promise<string> {
    return this.runGit(["stash", "pop"]);
  }

  public async stashList(): Promise<string> {
    return this.runGit(["stash", "list"]);
  }

  private async runGit(args: string[]): Promise<string> {
    const cwd = this.getWorkspaceRoot();

    return new Promise((resolve, reject) => {
      cp.execFile("git", args, { cwd, maxBuffer: 1024 * 1024 * 10 }, (error, stdout, stderr) => {
        if (error) {
          reject(new Error(stderr.trim() || error.message));
          return;
        }

        resolve(stdout.trim() || "(no output)");
      });
    });
  }

  private getWorkspaceRoot(): string {
    const folder = vscode.workspace.workspaceFolders?.[0];
    if (!folder) {
      throw new Error("Open a workspace folder before running Git commands.");
    }

    return folder.uri.fsPath;
  }
}
