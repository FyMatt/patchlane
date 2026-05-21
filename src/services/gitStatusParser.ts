export interface GitFileChange {
  path: string;
  originalPath?: string;
  indexStatus: string;
  workingTreeStatus: string;
  status: string;
  label: string;
  isStaged: boolean;
  isUnstaged: boolean;
  isUntracked: boolean;
  isConflicted: boolean;
}

export interface GitRepositorySnapshot {
  branch: string;
  upstream?: string;
  ahead: number;
  behind: number;
  staged: number;
  unstaged: number;
  untracked: number;
  conflicted: number;
  clean: boolean;
  files: GitFileChange[];
  raw: string;
}

export function parseGitStatus(raw: string): GitRepositorySnapshot {
  const lines = raw.split(/\r?\n/).map((line) => line.trimEnd()).filter(Boolean);
  const branchLine = lines.find((line) => line.startsWith("## "));
  const files = lines.filter((line) => !line.startsWith("## ")).map(parseStatusLine);
  const branchInfo = branchLine ? parseBranchLine(branchLine) : { branch: "unknown", upstream: undefined, ahead: 0, behind: 0 };

  return {
    branch: branchInfo.branch,
    upstream: branchInfo.upstream,
    ahead: branchInfo.ahead,
    behind: branchInfo.behind,
    staged: files.filter((file) => file.isStaged).length,
    unstaged: files.filter((file) => file.isUnstaged).length,
    untracked: files.filter((file) => file.isUntracked).length,
    conflicted: files.filter((file) => file.isConflicted).length,
    clean: files.length === 0,
    files,
    raw
  };
}

function parseBranchLine(line: string): Pick<GitRepositorySnapshot, "branch" | "upstream" | "ahead" | "behind"> {
  const value = line.replace(/^##\s+/, "");
  const [branchPart, trackingPart] = value.split("...");
  const branch = branchPart || "unknown";
  const upstream = trackingPart?.replace(/\s+\[.*\]$/, "");
  const aheadMatch = value.match(/ahead\s+(\d+)/);
  const behindMatch = value.match(/behind\s+(\d+)/);

  return {
    branch,
    upstream,
    ahead: aheadMatch ? Number(aheadMatch[1]) : 0,
    behind: behindMatch ? Number(behindMatch[1]) : 0
  };
}

function parseStatusLine(line: string): GitFileChange {
  const indexStatus = line[0] ?? " ";
  const workingTreeStatus = line[1] ?? " ";
  const status = `${indexStatus}${workingTreeStatus}`;
  const rawPath = line.slice(3);
  const renameParts = rawPath.split(" -> ");
  const originalPath = renameParts.length === 2 ? renameParts[0] : undefined;
  const path = renameParts.length === 2 ? renameParts[1] : rawPath;
  const isUntracked = status === "??";
  const isIgnored = status === "!!";
  const isConflicted = isConflictStatus(status);
  const isStaged = !isIgnored && !isUntracked && indexStatus !== " ";
  const isUnstaged = !isIgnored && (isUntracked || workingTreeStatus !== " ");

  return {
    path,
    originalPath,
    indexStatus,
    workingTreeStatus,
    status,
    label: statusLabel(status, indexStatus, workingTreeStatus),
    isStaged,
    isUnstaged,
    isUntracked,
    isConflicted
  };
}

function isConflictStatus(status: string): boolean {
  return ["DD", "AU", "UD", "UA", "DU", "AA", "UU"].includes(status);
}

function statusLabel(status: string, indexStatus: string, workingTreeStatus: string): string {
  if (status === "??") {
    return "untracked";
  }
  if (isConflictStatus(status)) {
    return "conflict";
  }
  if (indexStatus === "A" || workingTreeStatus === "A") {
    return "added";
  }
  if (indexStatus === "D" || workingTreeStatus === "D") {
    return "deleted";
  }
  if (indexStatus === "R") {
    return "renamed";
  }
  if (indexStatus === "C") {
    return "copied";
  }
  if (indexStatus === "M" || workingTreeStatus === "M") {
    return "modified";
  }
  return status.trim() || "changed";
}
