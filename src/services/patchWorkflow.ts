import * as vscode from "vscode";
import { AgentContextBudget, getAgentContextBudget, getAgentMaxRepairAttempts, getModelForTask, getModelMaxTokens, getModelTemperature, getModelTopP } from "../config";
import { formatProviderErrorForUser } from "../providers/errors";
import { ChatResponse } from "../providers/types";
import { ProviderRegistry } from "../providers/registry";
import {
  createFailureStrategyFromApplyError,
  createFailureStrategyFromProviderMessage,
  createFailureStrategyFromQuality,
  formatFailureStrategyForPrompt,
  strategyChecks
} from "./agentFailureStrategy";
import { GitService } from "./gitService";
import { PatchService, extractUnifiedDiff, parseUnifiedDiff } from "./patchService";
import { collectWorkspaceContext } from "./workspaceContext";
import { collectPromptFileReferences, readWorkspaceFile, WorkspaceFileReference } from "./workspaceFiles";
import { ParsedFilePatch } from "./unifiedDiff";

export interface PatchDraft {
  id: string;
  request: string;
  model: string;
  createdAt: string;
  patchText: string;
  fileCount: number;
  files: string[];
  plan?: PatchPlan;
  quality?: PatchQualityReport;
  repairOf?: string;
  repairError?: string;
  verifyRepair?: PatchVerifyRepairInfo;
}

export type PatchDraftStatus = "generating" | "reviewing" | "repairing" | "stopped" | "failed";

export interface PatchVerifyRepairInfo {
  round: number;
  maxRounds: number;
  source: "manualVerify" | "postApply";
  failedCommand?: string;
  failureKind?: string;
  summary?: string;
  createdAt: string;
}

export interface PatchPlan {
  summary: string;
  files: PatchPlanFile[];
  steps: string[];
  acceptanceCriteria: string[];
  verification: string[];
  risks: string[];
  contextGaps: string[];
  assumptions: string[];
}

export interface PatchPlanFile {
  path: string;
  reason: string;
  operation?: "create" | "modify" | "delete";
}

export interface PatchWorkflowState {
  pendingPatch?: PatchDraft;
  activeDraft?: PatchDraft;
  activeDraftStatus?: PatchDraftStatus;
  activeDraftDetail?: string;
  lastAppliedPatch?: PatchDraft;
  lastBackupId?: string;
  lastApplyError?: string;
  repairCount: number;
}

export type PatchQualityStatus = "pass" | "warn" | "fail";

export interface PatchQualityCheck {
  id: string;
  label: string;
  status: PatchQualityStatus;
  detail: string;
}

export interface PatchQualityReport {
  status: PatchQualityStatus;
  summary: string;
  checks: PatchQualityCheck[];
  reviewModel?: string;
  repaired?: boolean;
}

export type PatchApplyStatus = "applied" | "repaired" | "cancelled";

export interface PatchApplyWorkflowResult {
  status: PatchApplyStatus;
  appliedFiles?: number;
  appliedDraft?: PatchDraft;
  repairedDraft?: PatchDraft;
  error?: string;
}

export interface PatchGenerationProgress {
  stage: "context" | "references" | "plan" | "model" | "parse" | "review" | "repair" | "ready";
  label: string;
  detail?: string;
}

export interface PatchGenerationOptions {
  signal?: AbortSignal;
  onProgress?: (progress: PatchGenerationProgress) => void;
  onDraft?: (draft: PatchDraft, status: PatchDraftStatus, detail?: string) => void;
  draftMetadata?: Pick<PatchDraft, "verifyRepair">;
}

export interface PatchApplyWorkflowOptions {
  requireConfirmation?: boolean;
  signal?: AbortSignal;
}

export class PatchWorkflowService {
  private pendingPatch?: PatchDraft;
  private activeDraft?: PatchDraft;
  private activeDraftStatus?: PatchDraftStatus;
  private activeDraftDetail?: string;
  private lastAppliedPatch?: PatchDraft;
  private lastApplyError?: string;
  private repairCount = 0;

  public constructor(
    private readonly providers: ProviderRegistry,
    private readonly gitService: GitService,
    private readonly patchService: PatchService
  ) {}

  public getState(): PatchWorkflowState {
    return {
      pendingPatch: this.pendingPatch,
      activeDraft: this.activeDraft,
      activeDraftStatus: this.activeDraftStatus,
      activeDraftDetail: this.activeDraftDetail,
      lastAppliedPatch: this.lastAppliedPatch,
      lastBackupId: this.patchService.getLastBackupId(),
      lastApplyError: this.lastApplyError,
      repairCount: this.repairCount
    };
  }

  public async generatePatch(request: string, options: PatchGenerationOptions = {}): Promise<PatchDraft> {
    const activeModel = getModelForTask("patch");
    const budget = getAgentContextBudget();
    const streamDraftBase = {
      id: createId(),
      request,
      model: `${activeModel.providerId}/${activeModel.modelId}`,
      createdAt: new Date().toISOString(),
      plan: undefined as PatchPlan | undefined
    };
    let streamedContent = "";
    let lastDraftUpdate = 0;
    const publishDraft = (status: PatchDraftStatus, detail?: string, force = false): void => {
      const now = Date.now();
      if (!force && now - lastDraftUpdate < 140) {
        return;
      }
      lastDraftUpdate = now;
      const patchText = extractUnifiedDiff(streamedContent);
      const files = parsePatchFilesLoose(patchText);
      const draft: PatchDraft = {
        ...streamDraftBase,
        ...options.draftMetadata,
        plan: streamDraftBase.plan,
        patchText,
        fileCount: files.length,
        files: files.map((filePatch) => resolvePatchLabel(filePatch))
      };
      this.setActiveDraft(draft, status, detail);
      options.onDraft?.(draft, status, detail);
    };

    options.onProgress?.({ stage: "context", label: "读取工作区上下文", detail: "当前文件、选区和项目变更" });
    const context = await collectWorkspaceContext(this.gitService);
    options.onProgress?.({ stage: "references", label: "整理引用文件", detail: "解析 @文件 和当前编辑器上下文" });
    const fileReferences = await collectPromptFileReferences(request);
    options.onProgress?.({ stage: "plan", label: "制定执行计划", detail: "识别目标文件、步骤和验证方式" });
    const plan = await this.createPatchPlan(request, context, fileReferences, activeModel, options);
    streamDraftBase.plan = plan;
    options.onProgress?.({ stage: "plan", label: "制定执行计划", detail: summarizePlan(plan) });
    const scopedReferences = await collectPlannedFileReferences(plan, context, fileReferences, budget.patchFileChars, budget.readFiles + 2);
    options.onProgress?.({ stage: "model", label: "请求模型生成修改", detail: `${activeModel.providerId} / ${activeModel.modelId}` });
    publishDraft("generating", "正在等待模型开始输出。", true);
    let response: ChatResponse;
    try {
      response = await this.providers.get(activeModel.providerId).chat({
        model: activeModel.modelId,
        messages: [
          {
            role: "system",
            content: [
              "You are a senior code agent inside VS Code.",
              "Operate like an engineering agent: follow the supplied implementation plan and output the exact patch.",
              "Return only a unified diff.",
              "Do not add explanations, markdown prose, or bullet points.",
              "Use standard unified diff format with ---/+++ and @@ hunks.",
              "Only change files listed in the plan unless the request is impossible without one additional directly related file.",
              "Do not rename files unless it is unavoidable.",
              "Keep the patch minimal and directly relevant to the request.",
              "Do not invent project files, dependencies, scripts, or APIs that are not visible in the provided context.",
              "Preserve existing style, naming, formatting, and framework conventions."
            ].join(" ")
          },
          {
            role: "user",
            content: buildPatchPrompt(request, context, scopedReferences, plan, budget)
          }
        ],
        temperature: getModelTemperature(),
        maxTokens: getPatchGenerationMaxTokens(),
        topP: getModelTopP()
      }, {
        signal: options.signal,
        onDelta: (delta) => {
          streamedContent += delta;
          publishDraft("generating", "正在接收模型输出，修改结果会持续刷新。");
        }
      });
      streamedContent = response.content;
    } catch (error) {
      const message = formatProviderErrorForUser(error);
      if (isAbortError(error)) {
        publishDraft("stopped", "已停止生成。未完成的草稿不会自动写入工作区。", true);
      } else if (streamedContent.trim()) {
        publishDraft("failed", message, true);
      } else {
        const failedDraft: PatchDraft = {
          ...streamDraftBase,
          ...options.draftMetadata,
          plan: streamDraftBase.plan,
          patchText: "",
          fileCount: 0,
          files: [],
          quality: createGenerationFailureQuality(message)
        };
        this.setActiveDraft(failedDraft, "failed", message);
        options.onDraft?.(failedDraft, "failed", message);
      }
      throw error;
    }

    if (isLengthFinishReason(response.finishReason)) {
      const message = createTruncatedGenerationMessage(response.finishReason);
      const patchText = extractUnifiedDiff(response.content);
      const files = parsePatchFilesLoose(patchText);
      const failedDraft: PatchDraft = {
        ...streamDraftBase,
        ...options.draftMetadata,
        plan,
        patchText,
        fileCount: files.length,
        files: files.map((filePatch) => resolvePatchLabel(filePatch)),
        quality: createTruncatedGenerationQuality(response.finishReason)
      };
      this.setActiveDraft(failedDraft, "failed", message);
      options.onDraft?.(failedDraft, "failed", message);
      throw new Error(message);
    }

    publishDraft("reviewing", "模型输出完成，正在解析和审查修改。", true);
    options.onProgress?.({ stage: "parse", label: "解析修改草稿", detail: "检查 unified diff 和影响文件" });
    let patchText = extractUnifiedDiff(response.content);
    let parsed = parseUnifiedDiff(patchText);
    let files = parsed.files.map((filePatch) => resolvePatchLabel(filePatch));
    options.onProgress?.({ stage: "review", label: "审查修改质量", detail: "检查计划覆盖、文件范围和潜在风险" });
    publishDraft("reviewing", "正在审查修改质量。", true);
    let quality = await this.reviewPatchQuality(request, patchText, plan, scopedReferences, activeModel, options);
    const maxRepairAttempts = getAgentMaxRepairAttempts();
    for (let attempt = 1; quality.status === "fail" && attempt <= maxRepairAttempts; attempt += 1) {
      options.onProgress?.({ stage: "repair", label: "修复修改草稿", detail: `第 ${attempt}/${maxRepairAttempts} 轮：${quality.summary}` });
      publishDraft("repairing", quality.summary, true);
      try {
        patchText = await this.repairGeneratedPatch(request, patchText, quality, plan, context, scopedReferences, activeModel, options);
        parsed = parseUnifiedDiff(patchText);
        files = parsed.files.map((filePatch) => resolvePatchLabel(filePatch));
        options.onProgress?.({ stage: "review", label: "复查修改质量", detail: `第 ${attempt}/${maxRepairAttempts} 轮修复后复查` });
        quality = {
          ...(await this.reviewPatchQuality(request, patchText, plan, scopedReferences, activeModel, options)),
          repaired: true
        };
      } catch (error) {
        quality = {
          ...quality,
          summary: `质量审查未通过，自动修复失败：${error instanceof Error ? error.message : String(error)}`
        };
        break;
      }
    }

    const draft: PatchDraft = {
      id: createId(),
      request,
      model: response.model,
      createdAt: new Date().toISOString(),
      patchText,
      fileCount: files.length,
      files,
      plan,
      quality,
      ...options.draftMetadata
    };

    this.setPendingPatch(draft);
    this.clearActiveDraft();
    options.onProgress?.({ stage: "ready", label: "修改草稿已生成", detail: `${draft.fileCount} 个文件` });
    showPatchReadyMessage(draft);
    return draft;
  }

  public async applyPendingPatch(options: PatchApplyWorkflowOptions = {}): Promise<PatchApplyWorkflowResult> {
    if (!this.pendingPatch) {
      throw new Error("暂无待确认修改。");
    }

    assertNotAborted(options.signal);
    const confirmed = options.requireConfirmation === false
      ? "应用"
      : await vscode.window.showWarningMessage(
          "要把这份修改应用到当前工作区吗？",
          { modal: true },
          "应用"
        );

    if (confirmed !== "应用") {
      return { status: "cancelled" };
    }

    const draft = this.pendingPatch;
    try {
      const result = await this.patchService.applyUnifiedDiff(draft.patchText, { signal: options.signal });
      this.pendingPatch = undefined;
      this.lastAppliedPatch = draft;
      this.lastApplyError = undefined;
      vscode.window.showInformationMessage(`已应用 ${result.files.length} 个文件的修改。`);
      return {
        status: "applied",
        appliedFiles: result.files.length,
        appliedDraft: draft
      };
    } catch (error) {
      if (isAbortError(error)) {
        throw error;
      }
      const message = error instanceof Error ? error.message : String(error);
      this.lastApplyError = message;
      const repairedDraft = await this.repairPendingPatch(message, draft);
      vscode.window.showWarningMessage("修改没有成功应用，已生成修复后的草稿，请重新确认。");
      return {
        status: "repaired",
        repairedDraft,
        error: message
      };
    }
  }

  public async rollbackLastPatch(): Promise<void> {
    await this.patchService.rollbackLastPatch();
    vscode.window.showInformationMessage("已恢复到上一次应用修改前的状态。");
  }

  public discardPendingPatch(): void {
    this.pendingPatch = undefined;
    this.clearActiveDraft();
    this.lastApplyError = undefined;
  }

  public async replacePendingPatch(patchText: string, request: string): Promise<PatchDraft> {
    const parsed = parseUnifiedDiff(patchText);
    const files = parsed.files.map((filePatch) => resolvePatchLabel(filePatch));
    const draft: PatchDraft = {
      id: createId(),
      request,
      model: "local",
      createdAt: new Date().toISOString(),
      patchText,
      fileCount: files.length,
      files
    };

    this.setPendingPatch(draft);
    showPatchReadyMessage(draft);
    return draft;
  }

  private async repairPendingPatch(errorMessage: string, failedDraft: PatchDraft): Promise<PatchDraft> {
    const activeModel = getModelForTask("patchRepair");
    const budget = getAgentContextBudget();
    const context = await collectWorkspaceContext(this.gitService);
    const failedFileReferences = await collectPatchFileReferences(failedDraft, budget.patchFileChars);
    const response = await this.providers.get(activeModel.providerId).chat({
      model: activeModel.modelId,
      messages: [
        {
          role: "system",
          content: [
            "You repair unified diff patches for a VS Code coding agent.",
            "Return only a corrected unified diff.",
            "Do not add explanations, markdown prose, or bullet points.",
            "Use repository-relative paths and standard ---/+++ plus @@ hunk format.",
            "Keep the patch minimal and preserve the original user request.",
            "Do not introduce unrelated refactors while repairing."
          ].join(" ")
        },
        {
          role: "user",
          content: buildRepairPrompt(failedDraft, errorMessage, context, failedFileReferences, budget)
        }
      ],
      temperature: Math.min(getModelTemperature(), 0.1),
      maxTokens: getPatchRepairMaxTokens(),
      topP: getModelTopP()
    });

    if (isLengthFinishReason(response.finishReason)) {
      throw new Error(createTruncatedRepairMessage(response.finishReason));
    }

    const patchText = extractUnifiedDiff(response.content);
    const parsed = parseUnifiedDiff(patchText);
    const files = parsed.files.map((filePatch) => resolvePatchLabel(filePatch));

    const repairedDraft: PatchDraft = {
      id: createId(),
      request: failedDraft.request,
      model: response.model,
      createdAt: new Date().toISOString(),
      patchText,
      fileCount: files.length,
      files,
      plan: failedDraft.plan,
      repairOf: failedDraft.id,
      repairError: errorMessage,
      verifyRepair: failedDraft.verifyRepair
    };

    this.repairCount += 1;
    this.setPendingPatch(repairedDraft);
    showPatchReadyMessage(repairedDraft);
    return repairedDraft;
  }

  private async reviewPatchQuality(
    request: string,
    patchText: string,
    plan: PatchPlan,
    fileReferences: WorkspaceFileReference[],
    activeModel: ReturnType<typeof getModelForTask>,
    options: PatchGenerationOptions
  ): Promise<PatchQualityReport> {
    const budget = getAgentContextBudget();
    const staticChecks = buildStaticQualityChecks(patchText, plan);
    let modelReport: PatchQualityReport | undefined;

    try {
      const response = await this.providers.get(activeModel.providerId).chat({
        model: activeModel.modelId,
        messages: [
          {
            role: "system",
            content: [
              "You are Patchlane's patch reviewer.",
              "Review whether a unified diff satisfies the user's request and implementation plan.",
              "Return JSON only. No markdown fences.",
              "Use Simplified Chinese for summary and details.",
              "Be strict about invented files, broad rewrites, missing acceptance criteria, unsafe changes, and changes outside the plan.",
              "Do not require perfection; pass minimal correct patches."
            ].join(" ")
          },
          {
            role: "user",
            content: buildQualityReviewPrompt(request, patchText, plan, fileReferences, budget)
          }
        ],
        temperature: Math.min(getModelTemperature(), 0.1),
        maxTokens: getJsonTaskMaxTokens(),
        topP: getModelTopP()
      }, {
        signal: options.signal
      });

      modelReport = normalizeQualityReport(parsePlanJson(response.content), response.model);
    } catch (error) {
      if (isAbortError(error)) {
        throw error;
      }
      modelReport = undefined;
    }

    return mergeQualityReports(staticChecks, modelReport);
  }

  private async repairGeneratedPatch(
    request: string,
    patchText: string,
    quality: PatchQualityReport,
    plan: PatchPlan,
    context: Awaited<ReturnType<typeof collectWorkspaceContext>>,
    fileReferences: WorkspaceFileReference[],
    activeModel: ReturnType<typeof getModelForTask>,
    options: PatchGenerationOptions
  ): Promise<string> {
    const budget = getAgentContextBudget();
    const response = await this.providers.get(activeModel.providerId).chat({
      model: activeModel.modelId,
      messages: [
        {
          role: "system",
          content: [
            "You repair unified diff patches for a VS Code code agent.",
            "Return only a corrected unified diff.",
            "Do not add explanations, markdown prose, or bullet points.",
            "Keep the patch minimal and directly aligned with the implementation plan.",
            "Fix the quality issues without broad unrelated rewrites."
          ].join(" ")
        },
        {
          role: "user",
          content: buildGeneratedPatchRepairPrompt(request, patchText, quality, plan, context, fileReferences, budget)
        }
      ],
      temperature: Math.min(getModelTemperature(), 0.1),
      maxTokens: getPatchRepairMaxTokens(),
      topP: getModelTopP()
    }, {
      signal: options.signal
    });

    if (isLengthFinishReason(response.finishReason)) {
      throw new Error(createTruncatedRepairMessage(response.finishReason));
    }

    return extractUnifiedDiff(response.content);
  }

  private setPendingPatch(draft: PatchDraft): void {
    this.pendingPatch = draft;
    this.clearActiveDraft();
    this.lastAppliedPatch = undefined;
  }

  private setActiveDraft(draft: PatchDraft, status: PatchDraftStatus, detail?: string): void {
    if (this.pendingPatch) {
      this.pendingPatch = undefined;
    }
    this.activeDraft = draft;
    this.activeDraftStatus = status;
    this.activeDraftDetail = detail;
    this.lastAppliedPatch = undefined;
  }

  private clearActiveDraft(): void {
    this.activeDraft = undefined;
    this.activeDraftStatus = undefined;
    this.activeDraftDetail = undefined;
  }

  private async createPatchPlan(
    request: string,
    context: Awaited<ReturnType<typeof collectWorkspaceContext>>,
    fileReferences: Awaited<ReturnType<typeof collectPromptFileReferences>>,
    activeModel: ReturnType<typeof getModelForTask>,
    options: PatchGenerationOptions
  ): Promise<PatchPlan> {
    const budget = getAgentContextBudget();
    try {
      const response = await this.providers.get(activeModel.providerId).chat({
        model: activeModel.modelId,
        messages: [
          {
            role: "system",
            content: [
            "You are Patchlane's planning engine for a VS Code code agent.",
            "Create a small, concrete engineering plan before code changes.",
            "Use only the supplied workspace context.",
            "Return JSON only. Do not include markdown fences or prose.",
            "Keep the plan grounded, minimal, and useful for a weaker coding model.",
            "Use Simplified Chinese for summary, file reasons, steps, verification, and assumptions."
          ].join(" ")
          },
          {
            role: "user",
            content: buildPlanPrompt(request, context, trimFileReferences(fileReferences, budget.planFileChars), budget)
          }
        ],
        temperature: Math.min(getModelTemperature(), 0.2),
        maxTokens: getJsonTaskMaxTokens(),
        topP: getModelTopP()
      }, {
        signal: options.signal
      });

      return normalizePatchPlan(parsePlanJson(response.content), request, context, fileReferences);
    } catch (error) {
      if (isAbortError(error)) {
        throw error;
      }
      return createFallbackPlan(request, context, fileReferences);
    }
  }
}

function assertNotAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new DOMException("The operation was aborted.", "AbortError");
  }
}

function buildPatchPrompt(
  request: string,
  context: Awaited<ReturnType<typeof collectWorkspaceContext>>,
  fileReferences: WorkspaceFileReference[] = [],
  plan?: PatchPlan,
  budget: AgentContextBudget = getAgentContextBudget()
): string {
  const activeFileBlock = context.activeFilePath
    ? [
        `Active file: ${context.activeFilePath}`,
        "Active file content:",
        "```text",
        compactText(context.activeFileContent ?? "", budget.patchFileChars),
        "```"
      ].join("\n")
    : "Active file: none";

  const selectionBlock = context.activeSelection
    ? [
        "Active selection:",
        "```text",
        context.activeSelection,
        "```"
      ].join("\n")
    : "Active selection: none";

  const referenceBlock = fileReferences.length > 0
    ? [
        "Referenced workspace files:",
        ...fileReferences.flatMap((file) => [
          `File: ${file.path}`,
          `\`\`\`${file.languageId}`,
          file.content,
          "```",
          ""
        ])
      ].join("\n")
    : "Referenced workspace files: none";

  return [
    `Workspace root: ${context.workspaceRoot}`,
    `Request: ${request}`,
    "",
    "Approved implementation plan:",
    plan ? formatPlanForPrompt(plan) : "No explicit plan was available. Infer the smallest safe plan from context.",
    "",
    activeFileBlock,
    "",
    selectionBlock,
    "",
    referenceBlock,
    "",
    "Workspace change summary:",
    compactText(context.changeSummary, Math.min(3000, Math.floor(budget.contextChars * 0.18))),
    "",
    "Existing workspace diff summary:",
    compactText(context.diffContext, Math.min(5000, Math.floor(budget.contextChars * 0.28))),
    "",
    "Engineering constraints:",
    "- Read the supplied files as the source of truth.",
    "- Prefer existing local patterns over generic implementations.",
    "- Avoid broad rewrites unless the request explicitly requires them.",
    "- Add or update tests only when they are directly relevant and the existing project structure is visible.",
    "- Do not change generated, dependency, build output, or unrelated files.",
    "- Follow the approved implementation plan step by step.",
    "- Do not edit files outside the plan unless the task cannot be completed otherwise.",
    "",
    "Output requirements:",
    "- Return only a unified diff.",
    "- No prose, no markdown explanation, and no code fences around the final answer if possible.",
    "- Use repository-relative paths.",
    "- Keep the patch minimal.",
    "- Ensure each hunk applies cleanly to the supplied file contents."
  ].join("\n");
}

function buildPlanPrompt(
  request: string,
  context: Awaited<ReturnType<typeof collectWorkspaceContext>>,
  fileReferences: WorkspaceFileReference[] = [],
  budget: AgentContextBudget = getAgentContextBudget()
): string {
  const activeFileBlock = context.activeFilePath
    ? [
        `Active file: ${context.activeFilePath}`,
        "Active file preview:",
        "```text",
        compactText(context.activeFileContent ?? "", budget.planFileChars),
        "```"
      ].join("\n")
    : "Active file: none";

  const selectionBlock = context.activeSelection
    ? [
        "Active selection:",
        "```text",
        context.activeSelection,
        "```"
      ].join("\n")
    : "Active selection: none";

  const referenceBlock = fileReferences.length > 0
    ? [
        "Referenced workspace files:",
        ...fileReferences.flatMap((file) => [
          `File: ${file.path}`,
          `\`\`\`${file.languageId}`,
          file.content,
          "```",
          ""
        ])
      ].join("\n")
    : "Referenced workspace files: none";

  return [
    `Workspace root: ${context.workspaceRoot}`,
    `Request: ${request}`,
    "",
    activeFileBlock,
    "",
    selectionBlock,
    "",
    referenceBlock,
    "",
    "Workspace change summary:",
    compactText(context.changeSummary, Math.min(2500, Math.floor(budget.contextChars * 0.16))),
    "",
    "Return this JSON shape exactly:",
    "{",
    '  "summary": "一句中文说明本次实现目标",',
    '  "files": [',
    '    { "path": "repo-relative/path.ts", "operation": "modify", "reason": "中文说明为什么需要修改这个文件" }',
    "  ],",
    '  "steps": ["简短中文实现步骤"],',
    '  "acceptanceCriteria": ["用户能看到或验证的完成标准"],',
    '  "verification": ["可见时写具体检查或命令，否则写人工检查方式"],',
    '  "risks": ["可能影响质量或兼容性的风险"],',
    '  "contextGaps": ["缺少但会影响决策的上下文，没有则空数组"],',
    '  "assumptions": ["只写重要的不确定性"]',
    "}",
    "",
    "Rules:",
    "- Prefer the active file and referenced files when they are relevant.",
    "- Include at most 6 files and at most 6 steps.",
    "- Include 1-5 acceptanceCriteria that can be checked after the patch.",
    "- operation must be create, modify, or delete.",
    "- Do not include dependency/build output/generated files unless explicitly requested.",
    "- If the request is ambiguous, state the assumption instead of inventing unseen APIs.",
    "- summary, reason, steps, verification, and assumptions must use Simplified Chinese."
  ].join("\n");
}

function buildRepairPrompt(
  draft: PatchDraft,
  errorMessage: string,
  context: Awaited<ReturnType<typeof collectWorkspaceContext>>,
  fileReferences: WorkspaceFileReference[],
  budget: AgentContextBudget = getAgentContextBudget()
): string {
  const failureStrategy = createFailureStrategyFromApplyError(errorMessage);
  const failedFileBlock = fileReferences.length > 0
    ? [
        "Current contents of files touched by the failed patch:",
        ...fileReferences.flatMap((file) => [
          `File: ${file.path}`,
          `\`\`\`${file.languageId}`,
          compactText(file.content, budget.patchFileChars),
          "```",
          ""
        ])
      ].join("\n")
    : "Current contents of files touched by the failed patch: unavailable. Keep the corrected diff conservative and only use visible context.";

  return [
    `Original request: ${draft.request}`,
    "",
    "Original implementation plan:",
    draft.plan ? formatPlanForPrompt(draft.plan) : "No explicit plan.",
    "",
    "The previous patch failed to apply.",
    `Apply error: ${errorMessage}`,
    "",
    "Failure strategy:",
    formatFailureStrategyForPrompt(failureStrategy),
    "",
    "Previous patch:",
    "```diff",
    compactText(draft.patchText, Math.min(10000, budget.contextChars)),
    "```",
    "",
    "Current active file:",
    context.activeFilePath ?? "none",
    "",
    context.activeFileContent
      ? ["Current active file content:", "```text", compactText(context.activeFileContent, budget.patchFileChars), "```"].join("\n")
      : "Current active file content: none",
    "",
    failedFileBlock,
    "",
    "Workspace change summary:",
    compactText(context.changeSummary, Math.min(2500, Math.floor(budget.contextChars * 0.16))),
    "",
    "Repair requirements:",
    "- Return only a corrected unified diff.",
    "- Make the patch apply against the current file contents.",
    "- Prefer the current contents of files touched by the failed patch over the previous hunk context.",
    "- Do not include the failed patch unless it is still correct.",
    "- Follow the failure strategy above; do not broaden the task while repairing."
  ].join("\n");
}

function buildQualityReviewPrompt(
  request: string,
  patchText: string,
  plan: PatchPlan,
  fileReferences: WorkspaceFileReference[],
  budget: AgentContextBudget = getAgentContextBudget()
): string {
  const referenceSummary = fileReferences.length > 0
    ? fileReferences.map((file) => `- ${file.path} (${file.languageId}, ${file.lineCount} 行)`).join("\n")
    : "- 无额外引用文件";

  return [
    `用户需求：${request}`,
    "",
    "执行计划：",
    formatPlanForPrompt(plan),
    "",
    "可见上下文文件：",
    referenceSummary,
    "",
    "待审查 diff：",
    "```diff",
    compactText(patchText, Math.min(14000, budget.contextChars)),
    "```",
    "",
    "请严格返回 JSON：",
    "{",
    '  "status": "pass | warn | fail",',
    '  "summary": "一句中文审查结论",',
    '  "checks": [',
    '    { "id": "plan", "label": "计划覆盖", "status": "pass | warn | fail", "detail": "中文说明" }',
    "  ]",
    "}",
    "",
    "判定规则：",
    "- pass：修改满足需求和计划，风险可接受。",
    "- warn：基本可用，但存在需要用户注意的风险或缺口。",
    "- fail：明显偏离需求、遗漏关键验收标准、修改了无关/生成文件、diff 无法审查或大概率无法应用。"
  ].join("\n");
}

function buildGeneratedPatchRepairPrompt(
  request: string,
  patchText: string,
  quality: PatchQualityReport,
  plan: PatchPlan,
  context: Awaited<ReturnType<typeof collectWorkspaceContext>>,
  fileReferences: WorkspaceFileReference[],
  budget: AgentContextBudget = getAgentContextBudget()
): string {
  const failureStrategy = createFailureStrategyFromQuality(quality);
  const activeFileBlock = context.activeFilePath && context.activeFileContent
    ? [
        `当前文件：${context.activeFilePath}`,
        "```text",
        compactText(context.activeFileContent, budget.patchFileChars),
        "```"
      ].join("\n")
    : "当前文件：无";
  const referenceBlock = fileReferences.length > 0
    ? fileReferences.flatMap((file) => [
      `文件：${file.path}`,
      `\`\`\`${file.languageId}`,
      compactText(file.content, budget.patchFileChars),
      "```"
    ]).join("\n")
    : "额外引用文件：无";

  return [
    `用户需求：${request}`,
    "",
    "执行计划：",
    formatPlanForPrompt(plan),
    "",
    "质量问题：",
    quality.checks.map((check) => `- [${check.status}] ${check.label}: ${check.detail}`).join("\n"),
    "",
    "失败修正策略：",
    formatFailureStrategyForPrompt(failureStrategy),
    "",
    "原始 diff：",
    "```diff",
    compactText(patchText, Math.min(14000, budget.contextChars)),
    "```",
    "",
    activeFileBlock,
    "",
    referenceBlock,
    "",
    "修复要求：",
    "- 返回修复后的 unified diff。",
    "- 必须满足执行计划和验收标准。",
    "- 移除无关、生成目录、依赖目录或过度重写内容。",
    "- 保持修改最小，可审查，可应用。",
    "- 按上面的失败修正策略处理，不要把任务扩大成重新实现整个项目。"
  ].join("\n");
}

function parsePlanJson(content: string): unknown {
  const trimmed = content.trim();
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced?.[1]?.trim() ?? trimmed;

  try {
    return JSON.parse(candidate);
  } catch {
    const start = candidate.indexOf("{");
    const end = candidate.lastIndexOf("}");
    if (start !== -1 && end > start) {
      return JSON.parse(candidate.slice(start, end + 1));
    }
    throw new Error("Model did not return parseable plan JSON.");
  }
}

function buildStaticQualityChecks(patchText: string, plan: PatchPlan): PatchQualityCheck[] {
  const checks: PatchQualityCheck[] = [];
  let parsed: ReturnType<typeof parseUnifiedDiff> | undefined;
  try {
    parsed = parseUnifiedDiff(patchText);
    checks.push({
      id: "parse",
      label: "Diff 格式",
      status: parsed.files.length > 0 ? "pass" : "fail",
      detail: parsed.files.length > 0 ? `解析到 ${parsed.files.length} 个文件修改。` : "没有解析到文件修改。"
    });
  } catch (error) {
    checks.push({
      id: "parse",
      label: "Diff 格式",
      status: "fail",
      detail: error instanceof Error ? error.message : String(error)
    });
    return checks;
  }

  const completeness = detectIncompletePatch(parsed, patchText);
  checks.push({
    id: "complete",
    label: "Patch 完整性",
    status: completeness.status,
    detail: completeness.detail
  });

  const plannedPaths = new Set(plan.files.map((file) => file.path));
  const changedPaths = parsed.files.map((file) => resolvePatchPathForQuality(file));
  const outsidePlan = changedPaths.filter((path) => plannedPaths.size > 0 && !plannedPaths.has(path));
  checks.push({
    id: "scope",
    label: "文件范围",
    status: outsidePlan.length === 0 ? "pass" : outsidePlan.length <= 1 ? "warn" : "fail",
    detail: outsidePlan.length === 0 ? "修改文件都在计划范围内。" : `存在计划外文件：${outsidePlan.join("、")}`
  });

  const generatedFiles = changedPaths.filter((path) => isGeneratedOrDependencyPath(path));
  checks.push({
    id: "generated",
    label: "生成目录",
    status: generatedFiles.length === 0 ? "pass" : "fail",
    detail: generatedFiles.length === 0 ? "未修改依赖、缓存或构建产物。" : `不应修改这些文件：${generatedFiles.join("、")}`
  });

  const hasEmptyHunks = parsed.files.some((file) => file.hunks.length === 0);
  checks.push({
    id: "hunks",
    label: "修改片段",
    status: hasEmptyHunks ? "fail" : "pass",
    detail: hasEmptyHunks ? "存在没有 hunk 的文件修改。" : "每个文件都有可审查的修改片段。"
  });

  return checks;
}

function detectIncompletePatch(parsed: ReturnType<typeof parseUnifiedDiff>, patchText: string): { status: PatchQualityStatus; detail: string } {
  const trimmed = patchText.trimEnd();
  if (!trimmed) {
    return { status: "fail", detail: "Patch 为空。" };
  }

  const lastLine = trimmed.split(/\r?\n/).at(-1) ?? "";
  if (lastLine === "[DONE]" || /finish_reason|content_filter|length/i.test(lastLine)) {
    return { status: "fail", detail: "Patch 末尾包含模型协议或截断标记，不是完整 unified diff。" };
  }

  const malformed = parsed.files.find((file) => file.hunks.some((hunk) => !hunkLineCountsMatchHeader(hunk)));
  if (malformed) {
    return {
      status: "fail",
      detail: `${resolvePatchPathForQuality(malformed)} 的 hunk 行数与头部声明不一致，可能是模型输出被截断。`
    };
  }

  return { status: "pass", detail: "Patch hunk 行数完整，未发现明显截断。" };
}

function createGenerationFailureQuality(message: string): PatchQualityReport {
  const failureStrategy = createFailureStrategyFromProviderMessage(message);
  return {
    status: "fail",
    summary: "模型生成失败，未得到可审查的 diff。",
    checks: [
      {
        id: "model-generation",
        label: "模型输出",
        status: "fail",
        detail: message
      },
      ...strategyChecks(failureStrategy)
    ]
  };
}

function createTruncatedGenerationQuality(finishReason?: string | null): PatchQualityReport {
  const failureStrategy = createFailureStrategyFromQuality({
    status: "fail",
    summary: "模型输出被截断。",
    checks: [
      {
        id: "complete",
        label: "Patch 完整性",
        status: "fail",
        detail: `模型在输出完整 diff 前停止${finishReason ? `：finish_reason=${finishReason}` : ""}。`
      }
    ]
  });
  return {
    status: "fail",
    summary: "模型输出被截断，未得到可安全应用的完整 diff。",
    checks: [
      {
        id: "model-output-length",
        label: "模型输出",
        status: "fail",
        detail: createTruncatedGenerationMessage(finishReason)
      },
      ...strategyChecks(failureStrategy)
    ]
  };
}

function createTruncatedGenerationMessage(finishReason?: string | null): string {
  return [
    `模型输出被截断${finishReason ? `：finish_reason=${finishReason}` : ""}。`,
    "Patchlane 已保留实时草稿供查看，但不会允许应用这份不完整修改。",
    "请拆小任务、减少引用文件，或把 codeAgent.modelParameters.maxTokens 调高后重试。"
  ].join("");
}

function createTruncatedRepairMessage(finishReason?: string | null): string {
  return [
    `模型修复输出被截断${finishReason ? `：finish_reason=${finishReason}` : ""}。`,
    "请拆小任务、减少引用文件，或调大 codeAgent.modelParameters.maxTokens 后重试。"
  ].join("");
}

function isLengthFinishReason(value?: string | null): boolean {
  return typeof value === "string" && /length|max_tokens?|token_limit|output_limit/i.test(value);
}

function getPatchGenerationMaxTokens(): number | undefined {
  return getMaxTokensWithFloor(12000);
}

function getPatchRepairMaxTokens(): number | undefined {
  return getMaxTokensWithFloor(12000);
}

function getJsonTaskMaxTokens(fallback = 4096): number | undefined {
  const configured = getModelMaxTokens();
  return configured && configured > 0 ? configured : fallback;
}

function getMaxTokensWithFloor(floor: number): number | undefined {
  const configured = getModelMaxTokens();
  return configured && configured > 0 ? Math.max(configured, floor) : floor;
}

function hunkLineCountsMatchHeader(hunk: ParsedFilePatch["hunks"][number]): boolean {
  const oldCount = hunk.lines.filter((line) => line.type === "context" || line.type === "remove").length;
  const newCount = hunk.lines.filter((line) => line.type === "context" || line.type === "add").length;
  return oldCount === hunk.oldLines && newCount === hunk.newLines;
}

function normalizeQualityReport(value: unknown, model: string): PatchQualityReport {
  if (!value || typeof value !== "object") {
    return {
      status: "warn",
      summary: "模型审查没有返回可解析的质量报告。",
      reviewModel: model,
      checks: []
    };
  }

  const object = value as Partial<PatchQualityReport>;
  const checks = Array.isArray(object.checks)
    ? object.checks.map(normalizeQualityCheck).filter((item): item is PatchQualityCheck => Boolean(item)).slice(0, 8)
    : [];
  const status = normalizeQualityStatus(object.status) ?? aggregateQualityStatus(checks);
  return {
    status,
    summary: normalizeText(object.summary) || qualityStatusSummary(status),
    checks,
    reviewModel: model
  };
}

function normalizeQualityCheck(value: unknown): PatchQualityCheck | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const item = value as Partial<PatchQualityCheck>;
  const label = normalizeText(item.label);
  const detail = normalizeText(item.detail);
  if (!label || !detail) {
    return undefined;
  }
  return {
    id: normalizeText(item.id) || slugify(label),
    label,
    status: normalizeQualityStatus(item.status) ?? "warn",
    detail
  };
}

function mergeQualityReports(staticChecks: PatchQualityCheck[], modelReport?: PatchQualityReport): PatchQualityReport {
  const checks = [...staticChecks, ...(modelReport?.checks ?? [])];
  const status = aggregateQualityStatus(checks);
  return {
    status,
    summary: modelReport?.summary ?? qualityStatusSummary(status),
    checks,
    reviewModel: modelReport?.reviewModel
  };
}

function aggregateQualityStatus(checks: PatchQualityCheck[]): PatchQualityStatus {
  if (checks.some((check) => check.status === "fail")) {
    return "fail";
  }
  if (checks.some((check) => check.status === "warn")) {
    return "warn";
  }
  return "pass";
}

function normalizeQualityStatus(value: unknown): PatchQualityStatus | undefined {
  return value === "pass" || value === "warn" || value === "fail" ? value : undefined;
}

function qualityStatusSummary(status: PatchQualityStatus): string {
  if (status === "pass") {
    return "质量审查通过，可以进入人工确认。";
  }
  if (status === "warn") {
    return "质量审查发现需要注意的风险，请检查后再应用。";
  }
  return "质量审查未通过，建议修复后再应用。";
}

function normalizePatchPlan(
  value: unknown,
  request: string,
  context: Awaited<ReturnType<typeof collectWorkspaceContext>>,
  fileReferences: Awaited<ReturnType<typeof collectPromptFileReferences>>
): PatchPlan {
  if (!value || typeof value !== "object") {
    return createFallbackPlan(request, context, fileReferences);
  }

  const object = value as Partial<PatchPlan>;
  const files = Array.isArray(object.files)
    ? object.files
        .map((item) => normalizePlanFile(item))
        .filter((item): item is PatchPlanFile => Boolean(item))
        .slice(0, 6)
    : [];

  const plan: PatchPlan = {
    summary: normalizeText(object.summary) || `根据需求生成可审阅的最小修改：${request.slice(0, 80)}`,
    files,
    steps: normalizeTextArray(object.steps, 6),
    acceptanceCriteria: normalizeTextArray(object.acceptanceCriteria, 5),
    verification: normalizeTextArray(object.verification, 5),
    risks: normalizeTextArray(object.risks, 5),
    contextGaps: normalizeTextArray(object.contextGaps, 5),
    assumptions: normalizeTextArray(object.assumptions, 5)
  };

  if (plan.files.length === 0) {
    plan.files = createFallbackPlan(request, context, fileReferences).files;
  }
  if (plan.steps.length === 0) {
    plan.steps = ["阅读上下文并定位最小修改点", "生成可审阅的 unified diff"];
  }
  if (plan.verification.length === 0) {
    plan.verification = ["检查修改结果页面中的 diff，确认后再应用"];
  }
  if (plan.acceptanceCriteria.length === 0) {
    plan.acceptanceCriteria = ["修改内容与用户需求一致", "修改范围保持在计划文件内", "生成的 diff 可以被人工审查后应用"];
  }

  return plan;
}

function normalizePlanFile(value: unknown): PatchPlanFile | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }

  const item = value as Partial<PatchPlanFile>;
  const path = normalizeText(item.path);
  if (!path) {
    return undefined;
  }

  const operation = item.operation === "create" || item.operation === "modify" || item.operation === "delete"
    ? item.operation
    : "modify";

  return {
    path,
    operation,
    reason: normalizeText(item.reason) || "完成用户请求所需的相关文件"
  };
}

function normalizeText(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function normalizeTextArray(value: unknown, limit: number): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.map(normalizeText).filter(Boolean).slice(0, limit);
}

function createFallbackPlan(
  request: string,
  context: Awaited<ReturnType<typeof collectWorkspaceContext>>,
  fileReferences: Awaited<ReturnType<typeof collectPromptFileReferences>>
): PatchPlan {
  const seen = new Set<string>();
  const files: PatchPlanFile[] = [];

  for (const path of [context.activeFilePath, ...fileReferences.map((file) => file.path)]) {
    if (!path || seen.has(path)) {
      continue;
    }
    seen.add(path);
    files.push({
      path,
      operation: "modify",
      reason: path === context.activeFilePath ? "当前打开文件与任务上下文最相关" : "用户显式引用的上下文文件"
    });
  }

  return {
    summary: `根据当前上下文完成最小可审阅修改：${request.slice(0, 80)}`,
    files,
    steps: [
      "读取当前文件和引用文件",
      "定位与需求直接相关的修改点",
      "生成最小 unified diff 草稿"
    ],
    acceptanceCriteria: [
      "修改内容直接回应用户需求",
      "修改范围保持最小且可审阅",
      "不修改依赖、构建产物或无关文件"
    ],
    verification: ["在修改结果页检查 diff，确认无误后应用"],
    risks: [],
    contextGaps: files.length === 0 ? ["当前没有可见文件，缺少项目上下文"] : [],
    assumptions: files.length === 0 ? ["当前没有可见文件，模型只能基于需求生成修改草稿"] : []
  };
}

async function collectPlannedFileReferences(
  plan: PatchPlan,
  context: Awaited<ReturnType<typeof collectWorkspaceContext>>,
  explicitReferences: WorkspaceFileReference[],
  maxChars: number,
  maxFiles: number
): Promise<WorkspaceFileReference[]> {
  const byPath = new Map<string, WorkspaceFileReference>();
  for (const reference of explicitReferences) {
    byPath.set(reference.path, trimFileReference(reference, maxChars));
  }

  if (context.activeFilePath && context.activeFileContent) {
    byPath.set(context.activeFilePath, {
      path: context.activeFilePath,
      languageId: "text",
      lineCount: context.activeFileContent.split(/\r?\n/).length,
      content: compactText(context.activeFileContent, maxChars)
    });
  }

  for (const file of plan.files) {
    if (file.operation === "create" || byPath.has(file.path)) {
      continue;
    }
    try {
      byPath.set(file.path, await readWorkspaceFile(file.path, maxChars));
    } catch {
      // New or unresolved files are still represented by the plan; skip unreadable content.
    }
  }

  return [...byPath.values()].slice(0, maxFiles);
}

async function collectPatchFileReferences(draft: PatchDraft, maxChars: number): Promise<WorkspaceFileReference[]> {
  let parsed: ReturnType<typeof parseUnifiedDiff>;
  try {
    parsed = parseUnifiedDiff(draft.patchText);
  } catch {
    return [];
  }

  const references: WorkspaceFileReference[] = [];
  const seen = new Set<string>();
  for (const filePatch of parsed.files) {
    const path = resolvePatchPathForQuality(filePatch);
    if (!path || path === "/dev/null" || seen.has(path)) {
      continue;
    }
    seen.add(path);
    try {
      references.push(await readWorkspaceFile(path, maxChars));
    } catch {
      // Created or deleted files may not exist; the failed diff still carries their intended content.
    }
  }
  return references;
}

function trimFileReferences(references: WorkspaceFileReference[], maxChars: number): WorkspaceFileReference[] {
  return references.map((reference) => trimFileReference(reference, maxChars));
}

function trimFileReference(reference: WorkspaceFileReference, maxChars: number): WorkspaceFileReference {
  return {
    ...reference,
    content: compactText(reference.content, maxChars)
  };
}

function compactText(value: string, maxChars: number): string {
  if (value.length <= maxChars) {
    return value;
  }
  const head = Math.max(800, Math.min(maxChars, Math.floor(maxChars * 0.68)));
  const tail = Math.max(800, Math.min(Math.floor(maxChars * 0.2), 2600));
  return `${value.slice(0, head)}\n\n[已截断 ${value.length - head - tail} 个字符]\n\n${value.slice(-tail)}`;
}

function formatPlanForPrompt(plan: PatchPlan): string {
  return [
    `计划摘要：${plan.summary}`,
    "涉及文件：",
    ...(plan.files.length > 0
      ? plan.files.map((file) => `- ${file.operation ?? "modify"} ${file.path}: ${file.reason}`)
      : ["- 未指定"]),
    "执行步骤：",
    ...(plan.steps.length > 0 ? plan.steps.map((step) => `- ${step}`) : ["- 推断最小安全修改"]),
    "验收标准：",
    ...(plan.acceptanceCriteria.length > 0 ? plan.acceptanceCriteria.map((item) => `- ${item}`) : ["- 修改内容可人工审查并应用"]),
    "验证方式：",
    ...(plan.verification.length > 0 ? plan.verification.map((step) => `- ${step}`) : ["- 检查生成的 diff"]),
    "风险：",
    ...(plan.risks.length > 0 ? plan.risks.map((risk) => `- ${risk}`) : ["- 未发现明显风险"]),
    "上下文缺口：",
    ...(plan.contextGaps.length > 0 ? plan.contextGaps.map((gap) => `- ${gap}`) : ["- 无"])
  ].join("\n");
}

function summarizePlan(plan: PatchPlan): string {
  const fileSummary = plan.files.length > 0
    ? plan.files.map((file) => `${file.operation ?? "modify"} ${file.path}`).join("、")
    : "未限定文件";
  return `${plan.summary}｜${fileSummary}`;
}

function parsePatchFilesLoose(patchText: string): Array<{ oldPath: string; newPath: string }> {
  const lines = patchText.split(/\r?\n/);
  const files: Array<{ oldPath: string; newPath: string }> = [];
  for (let index = 0; index < lines.length - 1; index += 1) {
    const oldHeader = lines[index];
    const newHeader = lines[index + 1];
    if (!oldHeader.startsWith("--- ") || !newHeader.startsWith("+++ ")) {
      continue;
    }
    files.push({
      oldPath: normalizeDiffHeaderPath(oldHeader),
      newPath: normalizeDiffHeaderPath(newHeader)
    });
  }
  return files;
}

function normalizeDiffHeaderPath(line: string): string {
  const value = line.replace(/^---\s+/, "").replace(/^\+\+\+\s+/, "").split("\t")[0].trim();
  if (value === "/dev/null") {
    return value;
  }
  return value.replace(/^a\//, "").replace(/^b\//, "");
}

function resolvePatchPathForQuality(filePatch: { oldPath: string; newPath: string }): string {
  if (filePatch.newPath && filePatch.newPath !== "/dev/null") {
    return filePatch.newPath;
  }
  return filePatch.oldPath;
}

function isGeneratedOrDependencyPath(path: string): boolean {
  const parts = path.replace(/\\/g, "/").split("/");
  return parts.some((part) => [
    "node_modules",
    "dist",
    "out",
    "build",
    ".next",
    ".git",
    ".codex",
    "coverage",
    ".turbo",
    ".cache"
  ].includes(part));
}

function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fa5]+/gi, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48) || "check";
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && (error.name === "AbortError" || error.message.includes("aborted"));
}

function showPatchReadyMessage(draft: PatchDraft): void {
  vscode.window.showInformationMessage(`已生成 ${draft.fileCount} 个文件的修改草稿。`);
}

function resolvePatchLabel(filePatch: { oldPath: string; newPath: string }): string {
  if (filePatch.oldPath === "/dev/null") {
    return `create ${filePatch.newPath}`;
  }

  if (filePatch.newPath === "/dev/null") {
    return `delete ${filePatch.oldPath}`;
  }

  if (filePatch.oldPath !== filePatch.newPath) {
    return `rename ${filePatch.oldPath} -> ${filePatch.newPath}`;
  }

  return `modify ${filePatch.newPath}`;
}

function createId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}
