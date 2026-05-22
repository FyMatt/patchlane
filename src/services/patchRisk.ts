export type PatchRiskLevel = "low" | "medium" | "high";

export interface PatchRiskFile {
  path: string;
  operation?: "create" | "modify" | "delete";
}

const highRiskPathPattern = /(^|\/)(auth|security|permission|permissions|billing|payment|payments|migration|migrations|database|db|schema|secrets?)(\/|\.|$)/i;
const mediumRiskPathPattern = /(^|\/)(package\.json|pnpm-lock\.yaml|package-lock\.json|yarn\.lock|tsconfig|vite\.config|webpack\.config|rollup\.config|eslint\.config|\.github\/workflows)(\.|\/|$)/i;
const highRiskTextPattern = /(认证|鉴权|权限|安全|支付|账单|迁移|数据库|schema|数据丢失|破坏性|API\s*合同|breaking|security|auth|permission|payment|billing|migration|database|schema|destructive)/i;

export function normalizePatchRiskLevel(value: unknown): PatchRiskLevel | undefined {
  if (value === "low" || value === "medium" || value === "high") {
    return value;
  }
  return undefined;
}

export function inferPatchRiskLevel(files: PatchRiskFile[], riskNotes: string[] = []): PatchRiskLevel {
  const normalizedFiles = files.filter((file) => file.path.trim().length > 0);
  const joinedRisks = riskNotes.join("\n");

  if (
    normalizedFiles.length > 4 ||
    normalizedFiles.some((file) => file.operation === "delete") ||
    normalizedFiles.some((file) => highRiskPathPattern.test(normalizePath(file.path))) ||
    highRiskTextPattern.test(joinedRisks)
  ) {
    return "high";
  }

  if (
    normalizedFiles.length > 1 ||
    normalizedFiles.some((file) => file.operation === "create") ||
    normalizedFiles.some((file) => mediumRiskPathPattern.test(normalizePath(file.path))) ||
    riskNotes.length > 0
  ) {
    return "medium";
  }

  return "low";
}

function normalizePath(path: string): string {
  return path.replace(/\\/g, "/");
}
