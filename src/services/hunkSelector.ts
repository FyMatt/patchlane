import { ParsedFilePatch, parseUnifiedDiff } from "./unifiedDiff";

export interface HunkChoice {
  label: string;
  description: string;
  fileIndex: number;
  hunkIndex: number;
}

export function getHunkChoices(patchText: string): HunkChoice[] {
  const parsed = parseUnifiedDiff(patchText);
  const choices: HunkChoice[] = [];

  parsed.files.forEach((filePatch, fileIndex) => {
    filePatch.hunks.forEach((hunk, hunkIndex) => {
      choices.push({
        label: `${resolvePatchPathLabel(filePatch)} hunk ${hunkIndex + 1}`,
        description: `-${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines}`,
        fileIndex,
        hunkIndex
      });
    });
  });

  return choices;
}

export function filterPatchHunks(patchText: string, selected: HunkChoice[]): string {
  const parsed = parseUnifiedDiff(patchText);
  const selectedKeys = new Set(selected.map((choice) => `${choice.fileIndex}:${choice.hunkIndex}`));
  const chunks: string[] = [];

  parsed.files.forEach((filePatch, fileIndex) => {
    const hunks = filePatch.hunks.filter((_, hunkIndex) => selectedKeys.has(`${fileIndex}:${hunkIndex}`));
    if (hunks.length === 0) {
      return;
    }

    chunks.push(`--- ${formatPatchPath(filePatch.oldPath, "a")}`);
    chunks.push(`+++ ${formatPatchPath(filePatch.newPath, "b")}`);
    for (const hunk of hunks) {
      chunks.push(`@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`);
      for (const line of hunk.lines) {
        const prefix = line.type === "context" ? " " : line.type === "add" ? "+" : "-";
        chunks.push(`${prefix}${line.text}`);
      }
    }
  });

  return chunks.join("\n");
}

function resolvePatchPathLabel(filePatch: ParsedFilePatch): string {
  if (filePatch.oldPath === "/dev/null") {
    return `create ${filePatch.newPath}`;
  }
  if (filePatch.newPath === "/dev/null") {
    return `delete ${filePatch.oldPath}`;
  }
  return filePatch.newPath;
}

function formatPatchPath(filePath: string, prefix: "a" | "b"): string {
  if (filePath === "/dev/null") {
    return filePath;
  }

  return `${prefix}/${filePath}`;
}

