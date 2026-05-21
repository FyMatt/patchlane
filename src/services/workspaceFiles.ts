import * as vscode from "vscode";
import { getConfig } from "../config";

const MAX_FILE_CHARS = 10000;
const DEFAULT_EXCLUDE = "**/{node_modules,dist,out,build,.next,.git,.codex,coverage,.turbo,.cache,tmp,temp}/**";
const IGNORED_PATH_PARTS = new Set([
  "node_modules",
  "dist",
  "out",
  "build",
  ".next",
  ".git",
  ".codex",
  "coverage",
  ".turbo",
  ".cache",
  "tmp",
  "temp"
]);
const IGNORED_EXTENSIONS = new Set([
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".webp",
  ".ico",
  ".svg",
  ".pdf",
  ".zip",
  ".gz",
  ".tar",
  ".tgz",
  ".7z",
  ".rar",
  ".wasm",
  ".map",
  ".lock",
  ".mp4",
  ".mov",
  ".mp3",
  ".wav",
  ".woff",
  ".woff2",
  ".ttf",
  ".eot"
]);

export interface WorkspaceFileSummary {
  path: string;
  languageId: string;
  lineCount: number;
  source?: "active" | "open" | "workspace";
}

export interface WorkspaceFileReference extends WorkspaceFileSummary {
  content: string;
}

export async function listWorkspaceFiles(limit?: number): Promise<WorkspaceFileSummary[]> {
  const maxFiles = limit ?? getConfig().get<number>("index.maxFiles", 250);
  const exclude = getConfig().get<string>("index.exclude", DEFAULT_EXCLUDE);
  const uris = await vscode.workspace.findFiles("**/*", exclude, maxFiles);

  const files: WorkspaceFileSummary[] = [];
  for (const uri of uris) {
    const path = toWorkspacePath(uri);
    if (!path || !isReferenceCandidatePath(path)) {
      continue;
    }

    try {
      const document = await vscode.workspace.openTextDocument(uri);
      files.push({
        path,
        languageId: document.languageId,
        lineCount: document.lineCount,
        source: "workspace"
      });
    } catch {
      files.push({
        path,
        languageId: "unknown",
        lineCount: 0,
        source: "workspace"
      });
    }
  }

  return files.sort((left, right) => left.path.localeCompare(right.path));
}

export async function getPreferredReferenceFiles(limit = 8): Promise<WorkspaceFileSummary[]> {
  const result: WorkspaceFileSummary[] = [];
  const seen = new Set<string>();

  const pushDocument = (document: vscode.TextDocument | undefined, source: WorkspaceFileSummary["source"]) => {
    const summary = documentToSummary(document, source);
    if (!summary || seen.has(summary.path)) {
      return;
    }
    seen.add(summary.path);
    result.push(summary);
  };

  pushDocument(vscode.window.activeTextEditor?.document, "active");

  for (const document of getOpenTabDocuments()) {
    pushDocument(document, "open");
  }

  for (const document of vscode.workspace.textDocuments) {
    pushDocument(document, "open");
  }

  const others = (await listWorkspaceFiles(limit + 80)).filter((file) => !seen.has(file.path));
  return [...result, ...others].slice(0, limit);
}

export async function readWorkspaceFile(path: string, maxChars = MAX_FILE_CHARS): Promise<WorkspaceFileReference> {
  const uri = resolveWorkspaceFile(path);
  const document = await vscode.workspace.openTextDocument(uri);
  const content = trimWithNotice(document.getText(), maxChars);
  return {
    path: vscode.workspace.asRelativePath(uri, false),
    languageId: document.languageId,
    lineCount: document.lineCount,
    content
  };
}

export async function collectPromptFileReferences(prompt: string, maxFiles = 8): Promise<WorkspaceFileReference[]> {
  const paths = extractMentionedPaths(prompt).slice(0, maxFiles);
  const references: WorkspaceFileReference[] = [];
  for (const path of paths) {
    try {
      references.push(await readWorkspaceFile(path));
    } catch {
      // Ignore unresolved @file mentions so normal prose with @ does not break chat.
    }
  }
  return references;
}

export async function openWorkspaceFile(path: string): Promise<void> {
  const uri = resolveWorkspaceFile(path);
  const document = await vscode.workspace.openTextDocument(uri);
  await vscode.window.showTextDocument(document, {
    preview: false
  });
}

function resolveWorkspaceFile(path: string): vscode.Uri {
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (!folder) {
    throw new Error("请先打开一个工作区文件夹。");
  }

  const normalized = path.replace(/^@/, "").replace(/\\/g, "/").replace(/^\/+/, "");
  const segments = normalized.split("/").filter(Boolean);
  if (segments.length === 0 || segments.some((segment) => segment === "..")) {
    throw new Error(`无效的工作区文件路径：${path}`);
  }

  return vscode.Uri.joinPath(folder.uri, ...segments);
}

function getOpenTabDocuments(): vscode.TextDocument[] {
  const documents: vscode.TextDocument[] = [];
  for (const group of vscode.window.tabGroups.all) {
    for (const tab of group.tabs) {
      const input = tab.input;
      if (input instanceof vscode.TabInputText) {
        const document = vscode.workspace.textDocuments.find((item) => item.uri.toString() === input.uri.toString());
        if (document) {
          documents.push(document);
        }
      }
    }
  }
  return documents;
}

function documentToSummary(document: vscode.TextDocument | undefined, source: WorkspaceFileSummary["source"]): WorkspaceFileSummary | undefined {
  if (!document || document.uri.scheme !== "file") {
    return undefined;
  }

  const path = toWorkspacePath(document.uri);
  if (!path || !isReferenceCandidatePath(path)) {
    return undefined;
  }

  return {
    path,
    languageId: document.languageId,
    lineCount: document.lineCount,
    source
  };
}

function toWorkspacePath(uri: vscode.Uri): string | undefined {
  const folder = vscode.workspace.getWorkspaceFolder(uri);
  if (!folder) {
    return undefined;
  }
  return vscode.workspace.asRelativePath(uri, false).replace(/\\/g, "/");
}

function isReferenceCandidatePath(path: string): boolean {
  const normalized = path.replace(/\\/g, "/");
  const parts = normalized.split("/");
  if (parts.some((part) => IGNORED_PATH_PARTS.has(part))) {
    return false;
  }

  const fileName = parts.at(-1)?.toLowerCase() ?? "";
  if (!fileName || fileName.startsWith(".")) {
    return false;
  }

  const lastDot = fileName.lastIndexOf(".");
  if (lastDot >= 0 && IGNORED_EXTENSIONS.has(fileName.slice(lastDot))) {
    return false;
  }

  return true;
}

function extractMentionedPaths(prompt: string): string[] {
  const paths = new Set<string>();
  const pattern = /(?:^|\s)@([^\s`'"]+)/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(prompt)) !== null) {
    const value = match[1].replace(/[),.;:!?]+$/, "");
    if (value.includes("/") || value.includes("\\") || value.includes(".")) {
      paths.add(value);
    }
  }
  return [...paths];
}

function trimWithNotice(text: string, maxChars: number): string {
  if (text.length <= maxChars) {
    return text;
  }

  const head = Math.max(800, Math.min(maxChars, Math.floor(maxChars * 0.72)));
  const tail = Math.max(800, Math.min(Math.floor(maxChars * 0.22), 2500));
  return `${text.slice(0, head)}\n\n[truncated ${text.length - head - tail} chars]\n\n${text.slice(-tail)}`;
}
