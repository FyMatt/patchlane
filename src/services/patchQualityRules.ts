import { PatchRiskLevel } from "./patchRisk";

export type PatchQualityStatus = "pass" | "warn" | "fail";

export interface PatchQualityCheck {
  id: string;
  label: string;
  status: PatchQualityStatus;
  detail: string;
}

export interface PatchQualityPlan {
  riskLevel: PatchRiskLevel;
  checkpoints?: Array<{ verification: string[] }>;
  verification: string[];
  contextGaps: string[];
}

export function buildPlanRiskChecks(plan: PatchQualityPlan): PatchQualityCheck[] {
  if (plan.riskLevel !== "high") {
    return [];
  }

  const checks: PatchQualityCheck[] = [];
  const concreteVerification = hasConcreteVerification(plan);
  checks.push({
    id: "risk-verification",
    label: "高风险验证计划",
    status: concreteVerification ? "pass" : "fail",
    detail: concreteVerification
      ? "高风险任务已包含具体验证方式。"
      : "高风险任务必须包含具体验证命令或明确人工验证步骤。"
  });
  checks.push({
    id: "risk-checkpoints",
    label: "高风险检查点",
    status: (plan.checkpoints ?? []).length > 0 ? "pass" : "fail",
    detail: (plan.checkpoints ?? []).length > 0
      ? "高风险任务已拆分检查点。"
      : "高风险任务必须拆分为可审查检查点。"
  });
  if (plan.contextGaps.length > 0) {
    checks.push({
      id: "risk-context",
      label: "高风险上下文",
      status: "warn",
      detail: `高风险任务仍存在上下文缺口：${plan.contextGaps.join("、")}`
    });
  }
  return checks;
}

export function hasConcreteVerification(plan: PatchQualityPlan): boolean {
  const verificationText = [
    ...plan.verification,
    ...(plan.checkpoints ?? []).flatMap((checkpoint) => checkpoint.verification)
  ].join("\n");
  return /((npm|pnpm|yarn|bun)\s+(test|run\s+(test|typecheck|lint|build)|lint|build)|go test|cargo test|pytest|vitest|jest|mocha|playwright|cypress|tsc|typecheck|lint|build|人工验证|手动验证|手工验证|manual verification)/i.test(verificationText);
}
