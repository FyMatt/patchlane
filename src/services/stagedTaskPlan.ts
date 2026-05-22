export type StagedTaskStatus = "active" | "failed" | "done";
export type StagedTaskPhaseStatus = "pending" | "generating" | "ready" | "applied" | "verifying" | "failed" | "done";
export type StagedTaskRiskLevel = "low" | "medium" | "high";

export interface StagedTaskPlanFile {
  path: string;
  reason: string;
  operation?: "create" | "modify" | "delete";
}

export interface StagedTaskPlanCheckpoint {
  id: string;
  title: string;
  files: string[];
  acceptanceCriteria: string[];
  verification: string[];
}

export interface StagedTaskPlan {
  summary: string;
  riskLevel: StagedTaskRiskLevel;
  files: StagedTaskPlanFile[];
  checkpoints: StagedTaskPlanCheckpoint[];
  steps: string[];
  acceptanceCriteria: string[];
  verification: string[];
  risks: string[];
  contextGaps: string[];
  assumptions: string[];
}

export interface StagedTaskPhase {
  id: string;
  title: string;
  files: string[];
  acceptanceCriteria: string[];
  verification: string[];
  status: StagedTaskPhaseStatus;
  attempt: number;
  draftId?: string;
  patchFiles?: string[];
  failureReason?: string;
  startedAt?: string;
  completedAt?: string;
  updatedAt: string;
}

export interface StagedTaskState {
  id: string;
  request: string;
  plan: StagedTaskPlan;
  status: StagedTaskStatus;
  currentPhaseIndex: number;
  phaseCount: number;
  phases: StagedTaskPhase[];
  createdAt: string;
  updatedAt: string;
}

export interface PatchDraftStageInfo {
  taskId: string;
  phaseId: string;
  phaseIndex: number;
  phaseCount: number;
  phaseTitle: string;
  attempt: number;
}

export function shouldUseStagedExecution(plan: StagedTaskPlan, request = ""): boolean {
  const distinctFiles = distinct(plan.files.map((file) => file.path)).length;
  const checkpointCount = (plan.checkpoints ?? []).length;
  const text = [request, plan.summary, ...plan.steps, ...plan.risks].join("\n");
  const complexSignal = /(分阶段|多阶段|复杂|重构|迁移|跨模块|全项目|逐步|phase|staged|migration|refactor)/i.test(text);
  const wantsStaging = checkpointCount > 1
    || distinctFiles >= 3
    || (plan.riskLevel === "high" && distinctFiles > 1)
    || complexSignal;
  return wantsStaging && createStagedTaskPhases(plan).length > 1;
}

export function createStagedTaskState(plan: StagedTaskPlan, request: string, now = new Date()): StagedTaskState {
  const timestamp = toIso(now);
  const phases = createStagedTaskPhases(plan).map((phase) => ({
    ...phase,
    status: "pending" as const,
    attempt: 0,
    updatedAt: timestamp
  }));

  return {
    id: createId("task"),
    request,
    plan: clonePlan(plan),
    status: "active",
    currentPhaseIndex: 0,
    phaseCount: phases.length,
    phases,
    createdAt: timestamp,
    updatedAt: timestamp
  };
}

export function createStagedTaskPhases(plan: StagedTaskPlan): Array<Omit<StagedTaskPhase, "status" | "attempt" | "updatedAt">> {
  const planFiles = distinct(plan.files.map((file) => file.path));
  if ((plan.checkpoints ?? []).length > 1) {
    return plan.checkpoints.map((checkpoint, index) => ({
      id: checkpoint.id || `phase-${index + 1}`,
      title: checkpoint.title || `阶段 ${index + 1}`,
      files: checkpoint.files.length > 0 ? distinct(checkpoint.files) : planFiles,
      acceptanceCriteria: checkpoint.acceptanceCriteria.length > 0 ? checkpoint.acceptanceCriteria : plan.acceptanceCriteria.slice(0, 3),
      verification: checkpoint.verification.length > 0 ? checkpoint.verification : plan.verification.slice(0, 3)
    }));
  }

  if (planFiles.length <= 1) {
    return [{
      id: "phase-1",
      title: plan.checkpoints?.[0]?.title || "完成最小可审查修改",
      files: planFiles,
      acceptanceCriteria: plan.checkpoints?.[0]?.acceptanceCriteria?.length ? plan.checkpoints[0].acceptanceCriteria : plan.acceptanceCriteria.slice(0, 3),
      verification: plan.checkpoints?.[0]?.verification?.length ? plan.checkpoints[0].verification : plan.verification.slice(0, 3)
    }];
  }

  const targetPhaseCount = plan.riskLevel === "high"
    ? Math.min(4, planFiles.length)
    : Math.min(4, Math.max(2, Math.ceil(planFiles.length / 2)));
  const groupSize = Math.max(1, Math.ceil(planFiles.length / targetPhaseCount));
  return chunk(planFiles, groupSize).map((files, index) => ({
    id: `phase-${index + 1}`,
    title: files.length === 1 ? `修改 ${files[0]}` : `修改第 ${index + 1} 组文件`,
    files,
    acceptanceCriteria: plan.acceptanceCriteria.slice(0, 3),
    verification: plan.verification.slice(0, 3)
  }));
}

export function getCurrentStagedPhase(state?: StagedTaskState): StagedTaskPhase | undefined {
  if (!state || state.currentPhaseIndex < 0) {
    return undefined;
  }
  return state.phases[state.currentPhaseIndex];
}

export function startCurrentPhaseGeneration(state: StagedTaskState, now = new Date()): StagedTaskState {
  return updateCurrentPhase(state, now, (phase, timestamp) => ({
    ...phase,
    status: "generating",
    attempt: phase.attempt + 1,
    failureReason: phase.failureReason,
    startedAt: phase.startedAt ?? timestamp,
    updatedAt: timestamp
  }), "active");
}

export function markCurrentPhaseDraftReady(
  state: StagedTaskState,
  draftId: string,
  patchFiles: string[],
  now = new Date()
): StagedTaskState {
  return updateCurrentPhase(state, now, (phase, timestamp) => ({
    ...phase,
    status: "ready",
    draftId,
    patchFiles: distinct(patchFiles),
    failureReason: undefined,
    updatedAt: timestamp
  }), "active");
}

export function markCurrentPhaseApplied(state: StagedTaskState, now = new Date()): StagedTaskState {
  return updateCurrentPhase(state, now, (phase, timestamp) => ({
    ...phase,
    status: "applied",
    updatedAt: timestamp
  }), "active");
}

export function markCurrentPhaseVerifying(state: StagedTaskState, now = new Date()): StagedTaskState {
  return updateCurrentPhase(state, now, (phase, timestamp) => ({
    ...phase,
    status: "verifying",
    updatedAt: timestamp
  }), "active");
}

export function markCurrentPhaseFailed(state: StagedTaskState, reason: string, now = new Date()): StagedTaskState {
  return updateCurrentPhase(state, now, (phase, timestamp) => ({
    ...phase,
    status: "failed",
    failureReason: reason,
    updatedAt: timestamp
  }), "failed");
}

export function markCurrentPhaseDone(state: StagedTaskState, now = new Date()): StagedTaskState {
  return updateCurrentPhase(state, now, (phase, timestamp) => ({
    ...phase,
    status: "done",
    failureReason: undefined,
    completedAt: timestamp,
    updatedAt: timestamp
  }), "active");
}

export function advanceStagedTask(state: StagedTaskState, now = new Date()): StagedTaskState {
  const timestamp = toIso(now);
  if (state.currentPhaseIndex >= state.phases.length - 1) {
    return {
      ...state,
      status: "done",
      updatedAt: timestamp
    };
  }

  return {
    ...state,
    status: "active",
    currentPhaseIndex: state.currentPhaseIndex + 1,
    updatedAt: timestamp
  };
}

export function createPhasePatchPlan<T extends StagedTaskPlan>(
  plan: T,
  phase: StagedTaskPhase,
  phaseIndex: number,
  phaseCount: number
): T {
  const allowedFiles = new Set(phase.files);
  const phaseFiles = allowedFiles.size > 0
    ? plan.files.filter((file) => allowedFiles.has(file.path))
    : plan.files;
  const acceptanceCriteria = mergeText(phase.acceptanceCriteria, plan.acceptanceCriteria).slice(0, 5);
  const verification = mergeText(phase.verification, plan.verification).slice(0, 5);

  return {
    ...plan,
    summary: `阶段 ${phaseIndex + 1}/${phaseCount}：${phase.title}。${plan.summary}`,
    files: phaseFiles.length > 0 ? phaseFiles : plan.files,
    checkpoints: [{
      id: phase.id,
      title: phase.title,
      files: phase.files,
      acceptanceCriteria,
      verification
    }],
    steps: [`仅实现阶段 ${phaseIndex + 1}/${phaseCount}：${phase.title}`, ...plan.steps].slice(0, 6),
    acceptanceCriteria,
    verification
  };
}

export function buildStagedPhaseRequest(
  request: string,
  state: StagedTaskState,
  phase: StagedTaskPhase,
  retryContext?: string
): string {
  const phaseNumber = state.currentPhaseIndex + 1;
  const finished = state.phases
    .slice(0, state.currentPhaseIndex)
    .filter((item) => item.status === "done" || item.status === "applied")
    .map((item, index) => `${index + 1}. ${item.title}`)
    .join("\n");
  const remaining = state.phases
    .slice(state.currentPhaseIndex + 1)
    .map((item, index) => `${phaseNumber + index + 1}. ${item.title}`)
    .join("\n");
  return [
    "原始复杂任务：",
    state.request,
    "",
    request !== state.request ? ["当前续跑/修复请求：", request, ""].join("\n") : "",
    `当前只执行阶段 ${phaseNumber}/${state.phaseCount}：${phase.title}`,
    phase.files.length > 0 ? `阶段文件：${phase.files.join("、")}` : "阶段文件：按阶段计划推断",
    phase.acceptanceCriteria.length > 0 ? `阶段验收：${phase.acceptanceCriteria.join("；")}` : "",
    phase.verification.length > 0 ? `阶段验证：${phase.verification.join("；")}` : "",
    finished ? `已完成/已应用阶段：\n${finished}` : "已完成/已应用阶段：无",
    remaining ? `后续阶段（本次不要实现）：\n${remaining}` : "后续阶段：无",
    retryContext ? `续跑原因：${retryContext}` : "",
    "",
    "分阶段执行约束：",
    "- 只生成当前阶段的 unified diff。",
    "- 不要提前实现后续阶段；后续阶段会在本阶段应用并验证后单独生成 diff。",
    "- 如果当前阶段依赖后续阶段，先落地最小兼容接口或局部改动，并在验收标准内保持可审查。",
    "- 保持当前阶段 diff 小而完整，确保可以单独应用。"
  ].filter(Boolean).join("\n");
}

export function createDraftStageInfo(state: StagedTaskState, phase: StagedTaskPhase): PatchDraftStageInfo {
  return {
    taskId: state.id,
    phaseId: phase.id,
    phaseIndex: state.currentPhaseIndex + 1,
    phaseCount: state.phaseCount,
    phaseTitle: phase.title,
    attempt: phase.attempt
  };
}

export function isCurrentStageDraft(state: StagedTaskState | undefined, stage: PatchDraftStageInfo | undefined): boolean {
  const phase = getCurrentStagedPhase(state);
  return Boolean(state && phase && stage && state.id === stage.taskId && phase.id === stage.phaseId);
}

function updateCurrentPhase(
  state: StagedTaskState,
  now: Date,
  update: (phase: StagedTaskPhase, timestamp: string) => StagedTaskPhase,
  status: StagedTaskStatus
): StagedTaskState {
  const timestamp = toIso(now);
  return {
    ...state,
    status,
    phases: state.phases.map((phase, index) => index === state.currentPhaseIndex ? update(phase, timestamp) : phase),
    updatedAt: timestamp
  };
}

function clonePlan(plan: StagedTaskPlan): StagedTaskPlan {
  return {
    summary: plan.summary,
    riskLevel: plan.riskLevel,
    files: plan.files.map((file) => ({ ...file })),
    checkpoints: plan.checkpoints.map((checkpoint) => ({
      ...checkpoint,
      files: [...checkpoint.files],
      acceptanceCriteria: [...checkpoint.acceptanceCriteria],
      verification: [...checkpoint.verification]
    })),
    steps: [...plan.steps],
    acceptanceCriteria: [...plan.acceptanceCriteria],
    verification: [...plan.verification],
    risks: [...plan.risks],
    contextGaps: [...plan.contextGaps],
    assumptions: [...plan.assumptions]
  };
}

function mergeText(primary: string[], fallback: string[]): string[] {
  return distinct([...primary, ...fallback].map((item) => item.trim()).filter(Boolean));
}

function distinct(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function chunk<T>(values: T[], size: number): T[][] {
  const result: T[][] = [];
  for (let index = 0; index < values.length; index += size) {
    result.push(values.slice(index, index + size));
  }
  return result;
}

function toIso(value: Date): string {
  return value.toISOString();
}

function createId(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}
