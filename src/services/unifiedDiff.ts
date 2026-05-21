import * as path from "path";

export interface DiffHunkLine {
  type: "context" | "add" | "remove";
  text: string;
}

export interface DiffHunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: DiffHunkLine[];
}

export interface ParsedFilePatch {
  oldPath: string;
  newPath: string;
  hunks: DiffHunk[];
}

export interface ParsedPatch {
  files: ParsedFilePatch[];
}

export function extractUnifiedDiff(rawText: string): string {
  const fenced = rawText.match(/```(?:diff|patch|unified)?\s*\n([\s\S]*?)```/i);
  if (fenced) {
    return fenced[1].trim();
  }

  const diffIndex = rawText.search(/^(diff --git|---\s)/m);
  if (diffIndex >= 0) {
    return rawText.slice(diffIndex).trim();
  }

  return rawText.trim();
}

export function parseUnifiedDiff(diffText: string): ParsedPatch {
  const lines = diffText.split(/\r?\n/);
  const files: ParsedFilePatch[] = [];
  let index = 0;

  while (index < lines.length) {
    const line = lines[index];

    if (!line || line.startsWith("diff --git ") || line.startsWith("index ") || line.startsWith("new file mode") || line.startsWith("deleted file mode") || line.startsWith("similarity index") || line.startsWith("rename ")) {
      index += 1;
      continue;
    }

    if (!line.startsWith("--- ")) {
      index += 1;
      continue;
    }

    const oldPath = normalizeDiffPath(line.slice(4).trim());
    index += 1;

    if (index >= lines.length || !lines[index].startsWith("+++ ")) {
      throw new Error(`Missing new file header after ${oldPath}.`);
    }

    const newPath = normalizeDiffPath(lines[index].slice(4).trim());
    index += 1;

    const hunks: DiffHunk[] = [];
    while (index < lines.length) {
      const current = lines[index];

      if (current.startsWith("--- ") || current.startsWith("diff --git ")) {
        break;
      }

      if (!current) {
        index += 1;
        continue;
      }

      if (!current.startsWith("@@ ")) {
        index += 1;
        continue;
      }

      const { hunk, nextIndex } = parseHunk(lines, index);
      hunks.push(hunk);
      index = nextIndex;
    }

    files.push({ oldPath, newPath, hunks });
  }

  return { files };
}

export function applyPatchToText(originalText: string, filePatch: ParsedFilePatch, relativePath: string, isCreate: boolean): string {
  const original = splitTextByLine(originalText);
  const output: string[] = [];
  let cursor = 0;

  for (const hunk of filePatch.hunks) {
    const targetIndex = Math.max(0, hunk.oldStart - 1);
    if (targetIndex < cursor) {
      throw new Error(`Overlapping hunks are not supported in ${relativePath}.`);
    }

    while (cursor < targetIndex) {
      output.push(original.lines[cursor]);
      cursor += 1;
    }

    for (const line of hunk.lines) {
      if (line.type === "context") {
        assertLineMatches(original.lines[cursor], line.text, relativePath);
        output.push(original.lines[cursor]);
        cursor += 1;
        continue;
      }

      if (line.type === "remove") {
        assertLineMatches(original.lines[cursor], line.text, relativePath);
        cursor += 1;
        continue;
      }

      output.push(line.text);
    }
  }

  while (cursor < original.lines.length) {
    output.push(original.lines[cursor]);
    cursor += 1;
  }

  const shouldEndWithNewline = isCreate || original.hasTrailingNewline;
  return output.join(original.eol) + (shouldEndWithNewline && output.length > 0 ? original.eol : "");
}

function parseHunk(lines: string[], startIndex: number): { hunk: DiffHunk; nextIndex: number } {
  const header = lines[startIndex];
  const match = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(header);
  if (!match) {
    throw new Error(`Invalid hunk header: ${header}`);
  }

  const hunk: DiffHunk = {
    oldStart: Number(match[1]),
    oldLines: Number(match[2] ?? "1"),
    newStart: Number(match[3]),
    newLines: Number(match[4] ?? "1"),
    lines: []
  };

  let index = startIndex + 1;
  while (index < lines.length) {
    const line = lines[index];
    if (line.startsWith("@@ ") || line.startsWith("--- ") || line.startsWith("diff --git ")) {
      break;
    }

    if (line.startsWith("\\ No newline at end of file")) {
      index += 1;
      continue;
    }

    if (!line.length) {
      index += 1;
      continue;
    }

    const prefix = line[0];
    const text = line.slice(1);

    if (prefix === " ") {
      hunk.lines.push({ type: "context", text });
    } else if (prefix === "+") {
      hunk.lines.push({ type: "add", text });
    } else if (prefix === "-") {
      hunk.lines.push({ type: "remove", text });
    } else {
      throw new Error(`Unexpected hunk line: ${line}`);
    }

    index += 1;
  }

  return { hunk, nextIndex: index };
}

function assertLineMatches(actual: string | undefined, expected: string, relativePath: string): void {
  if (actual === undefined) {
    throw new Error(`修改内容与 ${relativePath} 的当前内容不匹配。`);
  }

  if (actual !== expected) {
    throw new Error(`${relativePath} 的修改上下文不匹配。`);
  }
}

function splitTextByLine(text: string): { lines: string[]; eol: string; hasTrailingNewline: boolean } {
  if (!text) {
    return { lines: [], eol: "\n", hasTrailingNewline: false };
  }

  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const hasTrailingNewline = text.endsWith("\n");
  const lines = text.split(/\r?\n/);
  if (hasTrailingNewline) {
    lines.pop();
  }

  return { lines, eol, hasTrailingNewline };
}

function normalizeDiffPath(rawPath: string): string {
  const stripped = rawPath.split("\t")[0].trim().replace(/^["']|["']$/g, "");
  if (stripped === "/dev/null") {
    return stripped;
  }

  const withoutPrefix = stripped.replace(/^a\//, "").replace(/^b\//, "");
  const normalized = path.posix.normalize(withoutPrefix.replace(/\\/g, "/"));
  const hasUnsafeSegment = normalized.split("/").some((segment) => segment === "..");
  if (normalized === "." || hasUnsafeSegment || path.posix.isAbsolute(normalized)) {
    throw new Error(`Unsafe path in patch: ${rawPath}`);
  }

  return normalized;
}
