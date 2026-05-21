import * as vscode from "vscode";
import { GitService } from "./gitService";

const MAX_CONTEXT_CHARS = 12000;
const MAX_DIFF_HEAD_CHARS = 7000;
const MAX_DIFF_TAIL_CHARS = 2500;

export interface WorkspaceContext {
  workspaceRoot: string;
  activeFilePath?: string;
  activeFileContent?: string;
  activeSelection?: string;
  changeSummary: string;
  diffContext: string;
}

export async function collectWorkspaceContext(gitService: GitService): Promise<WorkspaceContext> {
  const workspaceRoot = getWorkspaceRoot();
  const activeEditor = vscode.window.activeTextEditor;

  const activeSelection = activeEditor && !activeEditor.selection.isEmpty
    ? activeEditor.document.getText(activeEditor.selection)
    : undefined;

  const activeFileContent = activeEditor
    ? trimWithNotice(activeEditor.document.getText(), MAX_CONTEXT_CHARS)
    : undefined;

  const changeSummary = await optionalGitText(() => gitService.status());
  const diffContext = await optionalGitText(() => gitService.currentDiffForPrompt());

  return {
    workspaceRoot,
    activeFilePath: activeEditor ? vscode.workspace.asRelativePath(activeEditor.document.uri, false) : undefined,
    activeFileContent,
    activeSelection,
    changeSummary,
    diffContext
  };
}

async function optionalGitText(task: () => Promise<string>): Promise<string> {
  try {
    return trimWithNotice(await task(), MAX_CONTEXT_CHARS);
  } catch {
    return "(no workspace change context available)";
  }
}

function getWorkspaceRoot(): string {
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (!folder) {
    throw new Error("生成修改前请先打开一个工作区文件夹。");
  }

  return folder.uri.fsPath;
}

function trimWithNotice(text: string, maxChars: number): string {
  if (text.length <= maxChars) {
    return text;
  }

  const head = Math.max(800, Math.min(maxChars, MAX_DIFF_HEAD_CHARS));
  const tail = Math.max(800, Math.min(Math.floor(maxChars * 0.28), MAX_DIFF_TAIL_CHARS));
  return `${text.slice(0, head)}\n\n[truncated ${text.length - head - tail} chars]\n\n${text.slice(-tail)}`;
}
