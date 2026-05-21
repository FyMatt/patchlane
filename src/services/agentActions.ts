import * as vscode from "vscode";
import { getModelForTask, getModelMaxTokens, getModelTemperature, getModelTopP } from "../config";
import { ProviderRegistry } from "../providers/registry";
import { GitService } from "./gitService";

const MAX_DIFF_CHARS = 16000;

export async function generateCommitMessage(gitService: GitService, providers: ProviderRegistry): Promise<string> {
  const diff = await gitService.currentDiffForPrompt();
  const activeModel = getModelForTask("commitMessage");
  const response = await providers.get(activeModel.providerId).chat({
    model: activeModel.modelId,
    messages: [
      {
        role: "system",
        content: "You write concise, conventional commit messages. Return one subject line and optional bullet body. Do not wrap the result in markdown."
      },
      {
        role: "user",
        content: `Generate a commit message for this diff:\n\n${trim(diff, MAX_DIFF_CHARS)}`
      }
    ],
    temperature: getModelTemperature(),
    maxTokens: getModelMaxTokens(),
    topP: getModelTopP()
  });

  return response.content.trim();
}

export async function summarizeDiff(gitService: GitService, providers: ProviderRegistry): Promise<string> {
  const diff = await gitService.currentDiffForPrompt();
  const activeModel = getModelForTask("chat");
  const response = await providers.get(activeModel.providerId).chat({
    model: activeModel.modelId,
    messages: [
      {
        role: "system",
        content: "Summarize Git diffs for developers. Be concrete, mention changed areas, risks, and suggested verification. Use short markdown."
      },
      {
        role: "user",
        content: `Summarize this diff:\n\n${trim(diff, MAX_DIFF_CHARS)}`
      }
    ],
    temperature: getModelTemperature(),
    maxTokens: getModelMaxTokens(),
    topP: getModelTopP()
  });

  return response.content.trim();
}

export async function generatePrDescription(gitService: GitService, providers: ProviderRegistry): Promise<string> {
  const diff = await gitService.currentDiffForPrompt();
  const log = await gitService.log();
  const activeModel = getModelForTask("chat");
  const response = await providers.get(activeModel.providerId).chat({
    model: activeModel.modelId,
    messages: [
      {
        role: "system",
        content: "Write a clear pull request description. Include Summary, Testing, and Risk sections. Keep it concise."
      },
      {
        role: "user",
        content: `Recent commits:\n${log}\n\nDiff:\n${trim(diff, MAX_DIFF_CHARS)}`
      }
    ],
    temperature: getModelTemperature(),
    maxTokens: getModelMaxTokens(),
    topP: getModelTopP()
  });

  return response.content.trim();
}

export function getSelectedTextOrActiveFile(): { path?: string; content: string } {
  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    throw new Error("请先打开一个文件。");
  }

  const selection = !editor.selection.isEmpty ? editor.document.getText(editor.selection) : editor.document.getText();
  return {
    path: vscode.workspace.asRelativePath(editor.document.uri, false),
    content: selection
  };
}

function trim(text: string, maxChars: number): string {
  if (text.length <= maxChars) {
    return text;
  }

  return `${text.slice(0, maxChars)}\n\n[truncated ${text.length - maxChars} chars]`;
}
