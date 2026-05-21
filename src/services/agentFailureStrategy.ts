import type { PatchQualityCheck, PatchQualityReport, PatchQualityStatus } from "./patchWorkflow";
import type { VerifyFailureKind, VerifyResult, VerifySuiteResult } from "./verifyService";

export type AgentFailureKind =
  | "model_missing_api_key"
  | "model_empty_response"
  | "model_context_length"
  | "model_rate_limit"
  | "patch_parse_error"
  | "patch_incomplete"
  | "patch_scope_drift"
  | "patch_generated_output"
  | "patch_apply_conflict"
  | "verify_typescript"
  | "verify_test"
  | "verify_lint"
  | "verify_build"
  | "verify_missing_dependency"
  | "verify_runtime"
  | "verify_timeout"
  | "verify_aborted"
  | "unknown";

export interface AgentFailureStrategy {
  kind: AgentFailureKind;
  title: string;
  summary: string;
  promptGuidance: string[];
  userActions: string[];
}

export function createFailureStrategyFromProviderMessage(message: string): AgentFailureStrategy {
  const lower = message.toLowerCase();
  if (/api key|鉴权|unauthorized|401|403/.test(lower)) {
    return strategy("model_missing_api_key");
  }
  if (/没有返回可用内容|最终内容为空|思考内容|empty response|reasoning/.test(lower)) {
    return strategy("model_empty_response");
  }
  if (/上下文|context|token|too many tokens|413/.test(lower)) {
    return strategy("model_context_length");
  }
  if (/限流|rate limit|too many requests|429/.test(lower)) {
    return strategy("model_rate_limit");
  }
  return strategy("unknown");
}

export function createFailureStrategyFromQuality(quality: PatchQualityReport): AgentFailureStrategy {
  const failedChecks = quality.checks.filter((check) => check.status === "fail");
  const checks = failedChecks.length > 0 ? failedChecks : quality.checks;
  const ids = checks.map((check) => check.id.toLowerCase());
  const details = checks.map((check) => check.detail.toLowerCase()).join("\n");

  if (ids.includes("complete") || /截断|行数|协议|finish_reason|length/.test(details)) {
    return strategy("patch_incomplete");
  }
  if (ids.includes("parse") || /diff 格式|unsafe path|hunk|parse/.test(details)) {
    return strategy("patch_parse_error");
  }
  if (ids.includes("scope") || /计划外|范围|outside/.test(details)) {
    return strategy("patch_scope_drift");
  }
  if (ids.includes("generated") || /node_modules|dist|build|coverage|生成目录|构建产物/.test(details)) {
    return strategy("patch_generated_output");
  }
  return strategy("unknown");
}

export function createFailureStrategyFromApplyError(message: string): AgentFailureStrategy {
  const lower = message.toLowerCase();
  if (/上下文不匹配|context mismatch|failed to apply|hunk|patch/.test(lower)) {
    return strategy("patch_apply_conflict");
  }
  return strategy("unknown");
}

export function createFailureStrategyFromVerify(result: VerifyResult | VerifySuiteResult): AgentFailureStrategy {
  const kind = "results" in result ? result.failureKind : result.failureKind;
  return strategy(verifyKindToFailureKind(kind ?? "unknown"));
}

export function formatFailureStrategyForPrompt(strategy: AgentFailureStrategy): string {
  return [
    `失败归因：${strategy.title}`,
    `策略摘要：${strategy.summary}`,
    "下一步策略：",
    ...strategy.promptGuidance.map((item) => `- ${item}`)
  ].join("\n");
}

export function strategyChecks(strategy: AgentFailureStrategy, status: PatchQualityStatus = "warn"): PatchQualityCheck[] {
  return [
    {
      id: "failure-kind",
      label: "失败归因",
      status,
      detail: `${strategy.title}：${strategy.summary}`
    },
    {
      id: "next-strategy",
      label: "下一步策略",
      status: "warn",
      detail: strategy.userActions.join("；")
    }
  ];
}

function verifyKindToFailureKind(kind: VerifyFailureKind): AgentFailureKind {
  switch (kind) {
    case "typescript":
      return "verify_typescript";
    case "test":
      return "verify_test";
    case "lint":
      return "verify_lint";
    case "build":
      return "verify_build";
    case "missingDependency":
      return "verify_missing_dependency";
    case "runtime":
      return "verify_runtime";
    case "timeout":
      return "verify_timeout";
    case "aborted":
      return "verify_aborted";
    default:
      return "unknown";
  }
}

function strategy(kind: AgentFailureKind): AgentFailureStrategy {
  switch (kind) {
    case "model_missing_api_key":
      return {
        kind,
        title: "模型密钥或鉴权失败",
        summary: "模型调用没有进入有效生成阶段，继续重试通常不会解决。",
        promptGuidance: [
          "不要继续生成代码；先提示用户配置正确的 API Key、Base URL 和接口协议。",
          "如果用户切换模型后重试，再重新读取当前任务上下文。"
        ],
        userActions: ["检查 API Key", "确认 Base URL 和协议", "必要时切换模型"]
      };
    case "model_empty_response":
      return {
        kind,
        title: "模型空响应",
        summary: "模型没有返回可用最终内容，常见于思考模型、输出上限过小或任务过大。",
        promptGuidance: [
          "把任务拆成更小步骤，只生成当前最小可审查 diff。",
          "减少引用文件和历史上下文，优先当前文件、显式引用文件和失败相关文件。",
          "避免要求模型输出大段解释；只要求 unified diff。"
        ],
        userActions: ["重试一次", "调大 max_tokens", "切换非思考模型", "拆小任务或切换省 token 档位"]
      };
    case "model_context_length":
      return {
        kind,
        title: "上下文过长",
        summary: "请求超过模型上下文限制，需要先压缩输入再继续。",
        promptGuidance: [
          "只保留当前任务直接相关的文件片段、错误摘要和前文计划摘要。",
          "不要注入完整历史、完整 diff 或完整日志。",
          "如果仍不足，先生成阶段性计划或请求用户引用关键文件。"
        ],
        userActions: ["减少引用文件", "切换省 token 或均衡档位", "把任务拆成多个小任务"]
      };
    case "model_rate_limit":
      return {
        kind,
        title: "模型限流",
        summary: "服务端限制请求频率，立即重试可能继续失败。",
        promptGuidance: [
          "不要扩大上下文或重复调用工具。",
          "等待用户稍后重试，或切换模型供应商后继续。"
        ],
        userActions: ["稍后重试", "切换模型或供应商"]
      };
    case "patch_parse_error":
      return {
        kind,
        title: "Diff 格式错误",
        summary: "模型输出不是可解析的 unified diff。",
        promptGuidance: [
          "只输出标准 unified diff，不要输出 Markdown、解释、JSON 或计划。",
          "每个文件必须包含 ---、+++ 和 @@ hunk。",
          "路径必须是仓库相对路径，不能使用绝对路径或跳出工作区。"
        ],
        userActions: ["让 Agent 重新生成 diff", "减少任务范围"]
      };
    case "patch_incomplete":
      return {
        kind,
        title: "Patch 疑似截断",
        summary: "hunk 行数不一致或末尾含模型协议残留，不能安全应用。",
        promptGuidance: [
          "缩小到更少文件，优先修复第一个失败文件。",
          "降低解释文本，要求模型只返回 diff。",
          "如果文件过长，只读取当前 hunk 附近的相关片段。"
        ],
        userActions: ["调大 max_tokens", "拆小任务", "只引用关键文件"]
      };
    case "patch_scope_drift":
      return {
        kind,
        title: "修改范围偏离计划",
        summary: "Patch 修改了计划外文件或任务范围过宽。",
        promptGuidance: [
          "严格限制在计划文件和用户显式引用文件内。",
          "移除无关重构、示例项目和临时文件。",
          "如果必须新增文件，需要在计划和验收标准中说明必要性。"
        ],
        userActions: ["查看计划外文件", "要求 Agent 缩小修改范围"]
      };
    case "patch_generated_output":
      return {
        kind,
        title: "修改了生成目录或依赖目录",
        summary: "Patch 触碰了 node_modules、dist、build、coverage 等不应由 Agent 直接修改的文件。",
        promptGuidance: [
          "移除依赖目录、缓存目录和构建产物的修改。",
          "只修改源码、配置、测试或文档。",
          "如果构建产物需要更新，应改为说明验证或构建命令。"
        ],
        userActions: ["放弃生成目录修改", "只保留源码修改"]
      };
    case "patch_apply_conflict":
      return {
        kind,
        title: "Patch 应用冲突",
        summary: "当前文件内容和 diff hunk 上下文不一致，需要基于最新文件重新生成。",
        promptGuidance: [
          "以当前文件内容为准，重新定位要修改的代码位置。",
          "不要照抄失败 patch 的旧 hunk 上下文。",
          "保持修复最小，只改失败 patch 涉及的文件。"
        ],
        userActions: ["重新读取失败文件当前内容", "生成修复草稿后再审查"]
      };
    case "verify_typescript":
      return verifyStrategy(kind, "类型检查失败", "优先修复 TypeScript 类型、导入、泛型、空值和接口不匹配。");
    case "verify_test":
      return verifyStrategy(kind, "测试失败", "优先根据失败断言和测试名修复行为，不要为了通过测试删除或弱化测试。");
    case "verify_lint":
      return verifyStrategy(kind, "代码规范失败", "优先修复格式、未使用变量、导入顺序和 lint 规则。");
    case "verify_build":
      return verifyStrategy(kind, "构建失败", "优先修复编译、打包配置、导入路径和运行时入口问题。");
    case "verify_missing_dependency":
      return {
        kind,
        title: "依赖或命令缺失",
        summary: "验证失败可能不是代码逻辑问题，而是环境、依赖或脚本缺失。",
        promptGuidance: [
          "不要直接改业务代码来掩盖环境问题。",
          "先检查 package.json、脚本名、依赖声明和项目使用的包管理器。",
          "如果需要安装依赖，应明确提示用户审批命令。"
        ],
        userActions: ["检查依赖和脚本", "确认验证命令是否存在", "必要时安装依赖"]
      };
    case "verify_runtime":
      return verifyStrategy(kind, "运行时错误", "优先根据堆栈定位直接报错位置，修复最小运行时问题。");
    case "verify_timeout":
      return {
        kind,
        title: "验证超时",
        summary: "验证命令未在合理时间内结束，可能是死循环、等待输入或测试太重。",
        promptGuidance: [
          "不要扩大自动修复范围。",
          "检查最近修改是否引入死循环、未关闭句柄或等待外部服务。",
          "建议改用更窄的验证命令定位问题。"
        ],
        userActions: ["运行更小范围验证", "检查死循环或未关闭资源"]
      };
    case "verify_aborted":
      return {
        kind,
        title: "验证已停止",
        summary: "用户或系统中断了验证，不应继续自动修复。",
        promptGuidance: [
          "停止继续生成修复草稿。",
          "保留现有上下文，等待用户重新发起验证或修改任务。"
        ],
        userActions: ["等待用户重新运行验证"]
      };
    default:
      return {
        kind: "unknown",
        title: "未知失败",
        summary: "失败原因不明确，需要保守处理。",
        promptGuidance: [
          "保持修改最小，优先读取失败相关文件和最近日志摘要。",
          "不要重建项目或做无关重构。",
          "如果上下文不足，明确说明缺少哪些文件或命令输出。"
        ],
        userActions: ["查看错误详情", "必要时引用关键文件后重试"]
      };
  }
}

function verifyStrategy(kind: AgentFailureKind, title: string, focus: string): AgentFailureStrategy {
  return {
    kind,
    title,
    summary: focus,
    promptGuidance: [
      focus,
      "只修复导致首个失败命令失败的直接问题。",
      "保留已有可通过的行为，不做大范围重构。",
      "修复后生成可审查 diff，并建议重新运行相同验证命令。"
    ],
    userActions: ["查看验证输出", "应用修复草稿后重新运行验证"]
  };
}
