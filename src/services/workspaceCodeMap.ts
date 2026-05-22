import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";
import { getConfig } from "../config";

export interface CodeMapFile {
  path: string;
  languageId: string;
  lineCount: number;
  symbols: string[];
  imports: string[];
  exports: string[];
  roles: string[];
}

export interface CodeMap {
  packageScripts: string[];
  files: CodeMapFile[];
}

export interface TextSearchMatch {
  path: string;
  line: number;
  text: string;
}

const DEFAULT_EXCLUDE = "**/{node_modules,dist,out,build,.next,.git,.codex,coverage,.turbo,.cache,tmp,temp}/**";
const MAX_FILE_BYTES = 1024 * 512;
const SYMBOL_LIMIT_PER_FILE = 10;
const IMPORT_LIMIT_PER_FILE = 8;

const TEXT_EXTENSIONS = new Set([
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".vue",
  ".svelte",
  ".py",
  ".go",
  ".rs",
  ".java",
  ".kt",
  ".cs",
  ".php",
  ".rb",
  ".swift",
  ".json",
  ".md",
  ".yml",
  ".yaml",
  ".toml",
  ".css",
  ".scss",
  ".html"
]);

export async function buildWorkspaceCodeMap(maxFiles = 80): Promise<CodeMap> {
  const uris = await findCandidateUris(maxFiles);
  const files: CodeMapFile[] = [];

  for (const uri of uris) {
    const text = await readSmallText(uri);
    if (!text) {
      continue;
    }
    const relativePath = normalizeWorkspacePath(uri);
    files.push({
      path: relativePath,
      languageId: inferLanguageId(relativePath),
      lineCount: countLines(text),
      symbols: extractSymbols(text, relativePath),
      imports: extractImports(text).slice(0, IMPORT_LIMIT_PER_FILE),
      exports: extractExports(text).slice(0, SYMBOL_LIMIT_PER_FILE),
      roles: inferFileRoles(relativePath)
    });
  }

  return {
    packageScripts: readPackageScripts(),
    files
  };
}

export function formatCodeMapForPrompt(codeMap: CodeMap, maxChars: number): string {
  const scriptLines = codeMap.packageScripts.length > 0
    ? codeMap.packageScripts.map((script) => `- ${script}`)
    : ["- none"];
  const fileLines = codeMap.files.flatMap((file) => [
    `- ${file.path} (${file.languageId}, ${file.lineCount} lines${file.roles.length > 0 ? `, ${file.roles.join("/")}` : ""})`,
    file.symbols.length > 0 ? `  symbols: ${file.symbols.join(", ")}` : "",
    file.exports.length > 0 ? `  exports: ${file.exports.join(", ")}` : "",
    file.imports.length > 0 ? `  imports: ${file.imports.join(", ")}` : ""
  ]).filter(Boolean);

  return compactText([
    "Workspace code map:",
    "Package scripts:",
    ...scriptLines,
    "",
    "Key source files:",
    ...(fileLines.length > 0 ? fileLines : ["- none"])
  ].join("\n"), maxChars);
}

export async function searchWorkspaceText(query: string, options: { maxFiles?: number; maxMatches?: number; maxLineLength?: number } = {}): Promise<TextSearchMatch[]> {
  const normalizedQuery = query.trim();
  if (!normalizedQuery) {
    return [];
  }

  const maxFiles = options.maxFiles ?? 220;
  const maxMatches = options.maxMatches ?? 24;
  const maxLineLength = options.maxLineLength ?? 220;
  const queryTokens = tokenizeQuery(normalizedQuery);
  const uris = await findCandidateUris(maxFiles);
  const matches: TextSearchMatch[] = [];

  for (const uri of uris) {
    const text = await readSmallText(uri);
    if (!text) {
      continue;
    }
    const relativePath = normalizeWorkspacePath(uri);
    const lines = text.split(/\r?\n/);
    for (const [index, line] of lines.entries()) {
      if (!lineMatches(line, normalizedQuery, queryTokens)) {
        continue;
      }
      matches.push({
        path: relativePath,
        line: index + 1,
        text: compactSingleLine(line, maxLineLength)
      });
      if (matches.length >= maxMatches) {
        return matches;
      }
    }
  }

  return matches;
}

export function formatTextSearchMatches(query: string, matches: TextSearchMatch[], maxChars: number): string {
  if (matches.length === 0) {
    return `Search query: ${query}\nNo workspace text matches found.`;
  }
  return compactText([
    `Search query: ${query}`,
    `Matches: ${matches.length}`,
    ...matches.map((match) => `- ${match.path}:${match.line} ${match.text}`)
  ].join("\n"), maxChars);
}

async function findCandidateUris(maxFiles: number): Promise<vscode.Uri[]> {
  const exclude = getConfig().get<string>("index.exclude", DEFAULT_EXCLUDE);
  const uris = await vscode.workspace.findFiles("**/*", exclude, maxFiles);
  return uris.filter((uri) => isTextCandidate(uri.fsPath));
}

async function readSmallText(uri: vscode.Uri): Promise<string | undefined> {
  try {
    const stat = await vscode.workspace.fs.stat(uri);
    if (stat.size > MAX_FILE_BYTES) {
      return undefined;
    }
    const bytes = await vscode.workspace.fs.readFile(uri);
    return new TextDecoder("utf-8", { fatal: false }).decode(bytes);
  } catch {
    return undefined;
  }
}

function normalizeWorkspacePath(uri: vscode.Uri): string {
  return vscode.workspace.asRelativePath(uri, false).replace(/\\/g, "/");
}

function isTextCandidate(filePath: string): boolean {
  const basename = path.basename(filePath);
  if (!basename || basename.startsWith(".")) {
    return false;
  }
  const extension = path.extname(filePath).toLowerCase();
  return TEXT_EXTENSIONS.has(extension);
}

function inferLanguageId(filePath: string): string {
  const extension = path.extname(filePath).toLowerCase();
  const byExtension: Record<string, string> = {
    ".ts": "typescript",
    ".tsx": "typescriptreact",
    ".js": "javascript",
    ".jsx": "javascriptreact",
    ".mjs": "javascript",
    ".cjs": "javascript",
    ".py": "python",
    ".go": "go",
    ".rs": "rust",
    ".json": "json",
    ".md": "markdown",
    ".css": "css",
    ".scss": "scss",
    ".html": "html",
    ".vue": "vue",
    ".svelte": "svelte"
  };
  return byExtension[extension] ?? (extension.replace(/^\./, "") || "text");
}

function extractSymbols(text: string, filePath: string): string[] {
  const symbols = new Set<string>();
  const patterns = [
    /\b(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/g,
    /\b(?:export\s+)?class\s+([A-Za-z_$][\w$]*)/g,
    /\b(?:export\s+)?interface\s+([A-Za-z_$][\w$]*)/g,
    /\b(?:export\s+)?type\s+([A-Za-z_$][\w$]*)\s*=/g,
    /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?\(/g,
    /^\s*def\s+([A-Za-z_]\w*)/gm,
    /^\s*class\s+([A-Za-z_]\w*)/gm,
    /^\s*func\s+([A-Za-z_]\w*)/gm
  ];
  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) {
      symbols.add(match[1]);
      if (symbols.size >= SYMBOL_LIMIT_PER_FILE) {
        return [...symbols];
      }
    }
  }

  if (symbols.size === 0 && path.basename(filePath).toLowerCase() === "package.json") {
    symbols.add("package.json");
  }
  return [...symbols];
}

function extractImports(text: string): string[] {
  const imports = new Set<string>();
  const patterns = [
    /\bimport\s+(?:[^'"]+\s+from\s+)?["']([^"']+)["']/g,
    /\brequire\(["']([^"']+)["']\)/g,
    /^\s*from\s+([\w.]+)\s+import\s+/gm,
    /^\s*import\s+([\w.]+)/gm
  ];
  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) {
      imports.add(match[1]);
    }
  }
  return [...imports];
}

function extractExports(text: string): string[] {
  const exports = new Set<string>();
  for (const match of text.matchAll(/\bexport\s+(?:default\s+)?(?:class|function|interface|type|const|let|var)\s+([A-Za-z_$][\w$]*)/g)) {
    exports.add(match[1]);
  }
  for (const match of text.matchAll(/\bexport\s*\{([^}]+)\}/g)) {
    for (const name of match[1].split(",")) {
      const trimmed = name.trim().split(/\s+as\s+/i)[0]?.trim();
      if (trimmed) {
        exports.add(trimmed);
      }
    }
  }
  return [...exports];
}

function inferFileRoles(filePath: string): string[] {
  const lower = filePath.toLowerCase();
  const roles: string[] = [];
  if (/(^|\/)(test|tests|__tests__|spec)(\/|$)|\.(test|spec)\.[tj]sx?$/.test(lower)) {
    roles.push("test");
  }
  if (/(^|\/)(src|lib|app)(\/|$)/.test(lower)) {
    roles.push("source");
  }
  if (/(^|\/)(config|configs)(\/|$)|\.(config|rc)\./.test(lower)) {
    roles.push("config");
  }
  if (/package\.json$|pyproject\.toml$|cargo\.toml$|go\.mod$/.test(lower)) {
    roles.push("manifest");
  }
  if (/(readme|contributing|changelog|docs\/)/.test(lower)) {
    roles.push("docs");
  }
  return roles;
}

function readPackageScripts(): string[] {
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (!folder) {
    return [];
  }
  try {
    const packageJsonPath = path.join(folder.uri.fsPath, "package.json");
    const raw = fs.readFileSync(packageJsonPath, "utf8");
    const parsed = JSON.parse(raw) as { scripts?: Record<string, unknown> };
    return Object.entries(parsed.scripts ?? {})
      .filter(([, value]) => typeof value === "string")
      .slice(0, 16)
      .map(([name, value]) => `${name}: ${value}`);
  } catch {
    return [];
  }
}

function tokenizeQuery(query: string): string[] {
  return query
    .toLowerCase()
    .split(/[^a-z0-9_$.\-/\u4e00-\u9fa5]+/i)
    .map((token) => token.trim())
    .filter((token) => token.length >= 2)
    .slice(0, 8);
}

function lineMatches(line: string, query: string, queryTokens: string[]): boolean {
  const lowerLine = line.toLowerCase();
  const lowerQuery = query.toLowerCase();
  if (lowerLine.includes(lowerQuery)) {
    return true;
  }
  return queryTokens.length > 0 && queryTokens.every((token) => lowerLine.includes(token));
}

function countLines(text: string): number {
  return text.length === 0 ? 0 : text.split(/\r?\n/).length;
}

function compactSingleLine(value: string, maxChars: number): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxChars) {
    return normalized;
  }
  return `${normalized.slice(0, maxChars - 16)}...[truncated]`;
}

function compactText(value: string, maxChars: number): string {
  const normalized = value.trim();
  if (normalized.length <= maxChars) {
    return normalized;
  }
  const head = Math.floor(maxChars * 0.72);
  const tail = maxChars - head;
  return `${normalized.slice(0, head)}\n\n[truncated ${normalized.length - maxChars} chars]\n\n${normalized.slice(-tail)}`;
}
