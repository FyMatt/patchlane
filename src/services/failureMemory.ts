export type FailureMemorySource = "manualVerify" | "agentVerify" | "postApply" | "commandPalette";

export interface FailureMemoryRecord {
  id: string;
  signature: string;
  command: string;
  failureKind: string;
  summary: string;
  keyLines: string[];
  files: string[];
  source: FailureMemorySource;
  promptHint?: string;
  createdAt: string;
  lastSeenAt: string;
  count: number;
}

export interface FailureMemoryInput {
  result: VerifyFailureLike;
  source: FailureMemorySource;
  files?: string[];
  prompt?: string;
  now?: Date;
}

export interface FailureMemoryQuery {
  prompt?: string;
  files?: string[];
  command?: string;
  failureKind?: string;
}

export interface VerifyResultLike {
  command: string;
  exitCode: number | null;
  output?: string;
  keyLines?: string[];
  aborted?: boolean;
  failureKind?: string;
  summary?: string;
}

export interface VerifySuiteLike {
  results: VerifyResultLike[];
  passed?: boolean;
  failedCommand?: string;
  failureKind?: string;
  aborted?: boolean;
}

export type VerifyFailureLike = VerifyResultLike | VerifySuiteLike;

interface MementoLike {
  get<T>(key: string): T | undefined;
  get<T>(key: string, defaultValue: T): T;
  update(key: string, value: unknown): PromiseLike<void> | void;
}

const STORAGE_KEY = "patchlane.failureMemory.v1";
const MAX_FAILURE_RECORDS = 32;

export class FailureMemoryStore {
  public constructor(private readonly state: MementoLike) {}

  public getAll(): FailureMemoryRecord[] {
    return this.state.get<FailureMemoryRecord[]>(STORAGE_KEY, []);
  }

  public async record(input: FailureMemoryInput): Promise<FailureMemoryRecord | undefined> {
    const next = buildFailureMemoryRecord(input);
    if (!next) {
      return undefined;
    }

    const current = this.getAll();
    const existingIndex = current.findIndex((item) => item.signature === next.signature);
    const records = [...current];
    if (existingIndex >= 0) {
      const existing = records[existingIndex];
      records.splice(existingIndex, 1, {
        ...existing,
        ...next,
        id: existing.id,
        createdAt: existing.createdAt,
        count: existing.count + 1,
        files: mergeFiles(existing.files, next.files),
        keyLines: mergeLines(next.keyLines, existing.keyLines, 8)
      });
    } else {
      records.unshift(next);
    }

    records.sort((left, right) => right.lastSeenAt.localeCompare(left.lastSeenAt));
    await Promise.resolve(this.state.update(STORAGE_KEY, records.slice(0, MAX_FAILURE_RECORDS)));
    return existingIndex >= 0 ? records[existingIndex] : next;
  }

  public getRelevant(query: FailureMemoryQuery, limit = 4): FailureMemoryRecord[] {
    return selectRelevantFailureMemory(this.getAll(), query, limit);
  }
}

export function buildFailureMemoryRecord(input: FailureMemoryInput): FailureMemoryRecord | undefined {
  const failed = firstFailedResult(input.result);
  if (!failed || failed.aborted || failed.exitCode === 0 || failed.failureKind === "pass") {
    return undefined;
  }

  const now = input.now ?? new Date();
  const keyLines = normalizeLines(failed.keyLines?.length ? failed.keyLines : extractKeyLines(failed.output ?? ""));
  const summary = normalizeSpace(failed.summary || keyLines[0] || failed.command);
  const files = normalizeFiles(input.files ?? []);
  const failureKind = normalizeSpace(failed.failureKind || suiteFailureKind(input.result) || "unknown");
  const command = normalizeSpace(failed.command);
  const promptHint = input.prompt ? compactText(normalizeSpace(input.prompt), 220) : undefined;
  const signature = buildSignature(command, failureKind, summary, files);

  return {
    id: `failure-${hashText(`${signature}:${now.toISOString()}`)}`,
    signature,
    command,
    failureKind,
    summary,
    keyLines,
    files,
    source: input.source,
    promptHint,
    createdAt: now.toISOString(),
    lastSeenAt: now.toISOString(),
    count: 1
  };
}

export function selectRelevantFailureMemory(
  records: FailureMemoryRecord[],
  query: FailureMemoryQuery,
  limit = 4
): FailureMemoryRecord[] {
  const normalizedFiles = new Set(normalizeFiles(query.files ?? []));
  const prompt = normalizeSpace(query.prompt ?? "").toLowerCase();
  const command = normalizeSpace(query.command ?? "").toLowerCase();
  const failureKind = normalizeSpace(query.failureKind ?? "").toLowerCase();

  const scored = records.map((record) => ({
    record,
    score: scoreFailureRecord(record, { normalizedFiles, prompt, command, failureKind })
  }));

  const matched = scored
    .filter((item) => item.score > 0)
    .sort((left, right) => right.score - left.score || right.record.lastSeenAt.localeCompare(left.record.lastSeenAt))
    .map((item) => item.record);

  if (matched.length > 0) {
    return matched.slice(0, limit);
  }

  return [...records]
    .sort((left, right) => right.lastSeenAt.localeCompare(left.lastSeenAt))
    .slice(0, Math.min(limit, 2));
}

export function formatFailureMemoryForPrompt(records: FailureMemoryRecord[], maxChars: number): string {
  if (records.length === 0) {
    return "";
  }

  const lines = [
    "Recent verification failure memory:",
    "Use these only when they match the current task or failure. They are compressed local history, not proof.",
    "",
    ...records.flatMap((record, index) => [
      `${index + 1}. [${record.failureKind}] ${record.command}`,
      `   Last seen: ${record.lastSeenAt}; source: ${record.source}; count: ${record.count}`,
      record.files.length > 0 ? `   Files: ${record.files.slice(0, 8).join(", ")}` : "",
      `   Summary: ${record.summary}`,
      record.keyLines.length > 0 ? `   Key lines: ${record.keyLines.slice(0, 4).join(" | ")}` : "",
      record.promptHint ? `   Prompt hint: ${record.promptHint}` : "",
      ""
    ])
  ].filter(Boolean);

  return compactText(lines.join("\n"), maxChars);
}

function firstFailedResult(result: VerifyFailureLike): VerifyResultLike | undefined {
  if (isSuite(result)) {
    if (result.passed || result.aborted) {
      return undefined;
    }
    return result.results.find((item) => item.aborted || item.exitCode !== 0);
  }
  return result;
}

function suiteFailureKind(result: VerifyFailureLike): string | undefined {
  return isSuite(result) ? result.failureKind : result.failureKind;
}

function isSuite(result: VerifyFailureLike): result is VerifySuiteLike {
  return Array.isArray((result as VerifySuiteLike).results);
}

function scoreFailureRecord(
  record: FailureMemoryRecord,
  query: {
    normalizedFiles: Set<string>;
    prompt: string;
    command: string;
    failureKind: string;
  }
): number {
  let score = Math.min(record.count, 4);
  if (query.failureKind && record.failureKind.toLowerCase() === query.failureKind) {
    score += 8;
  }
  if (query.command && record.command.toLowerCase() === query.command) {
    score += 7;
  } else if (query.command && similarCommand(record.command, query.command)) {
    score += 4;
  }

  for (const file of record.files) {
    if (query.normalizedFiles.has(file)) {
      score += 10;
    }
    const basename = file.split("/").pop()?.toLowerCase();
    if (basename && query.prompt.includes(basename)) {
      score += 5;
    }
  }

  const searchable = [
    record.command,
    record.failureKind,
    record.summary,
    record.keyLines.join(" "),
    record.files.join(" ")
  ].join(" ").toLowerCase();
  for (const token of tokenize(query.prompt).slice(0, 24)) {
    if (searchable.includes(token)) {
      score += token.includes("/") || token.includes(".") ? 3 : 1;
    }
  }

  return score;
}

function similarCommand(left: string, right: string): boolean {
  const leftTokens = new Set(tokenize(left.toLowerCase()));
  const rightTokens = tokenize(right.toLowerCase());
  return rightTokens.some((token) => leftTokens.has(token));
}

function buildSignature(command: string, failureKind: string, summary: string, files: string[]): string {
  return hashText([
    command.toLowerCase(),
    failureKind.toLowerCase(),
    compactText(summary.toLowerCase(), 180),
    files.slice(0, 6).join(",")
  ].join("\n"));
}

function normalizeFiles(files: string[]): string[] {
  return [...new Set(files
    .map((file) => file.replace(/\\/g, "/").replace(/^@/, "").trim())
    .filter(Boolean))]
    .slice(0, 12);
}

function mergeFiles(left: string[], right: string[]): string[] {
  return normalizeFiles([...left, ...right]);
}

function mergeLines(primary: string[], fallback: string[], limit: number): string[] {
  return normalizeLines([...primary, ...fallback]).slice(0, limit);
}

function normalizeLines(lines: string[]): string[] {
  const seen = new Set<string>();
  const normalized: string[] = [];
  for (const line of lines.map((item) => normalizeSpace(item)).filter(Boolean)) {
    const key = line.toLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      normalized.push(line);
    }
  }
  return normalized.slice(0, 8);
}

function extractKeyLines(output: string): string[] {
  return normalizeLines(output
    .split(/\r?\n/)
    .filter((line) => /error|failed|failure|expected|received|assert|ts\d{4}|eslint|prettier|cannot|not found|exception|traceback|stack trace|:\d+:\d+/i.test(line)))
    .slice(0, 8);
}

function tokenize(value: string): string[] {
  return [...new Set(value.toLowerCase().match(/[a-z0-9_.:/-]{3,}|[\u4e00-\u9fa5]{2,}/g) ?? [])];
}

function normalizeSpace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function compactText(value: string, maxChars: number): string {
  if (value.length <= maxChars) {
    return value;
  }
  const head = Math.max(80, Math.floor(maxChars * 0.72));
  const tail = Math.max(40, maxChars - head);
  return `${value.slice(0, head)}\n\n[truncated ${value.length - maxChars} chars]\n\n${value.slice(-tail)}`;
}

function hashText(value: string): string {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}
