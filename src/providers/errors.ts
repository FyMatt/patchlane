export type LLMProviderErrorKind =
  | "missingApiKey"
  | "emptyResponse"
  | "contextLength"
  | "rateLimit"
  | "auth"
  | "network"
  | "server"
  | "unknown";

export interface LLMProviderErrorOptions {
  provider: string;
  kind: LLMProviderErrorKind;
  message: string;
  status?: number;
  finishReason?: string | null;
  reasoningOnly?: boolean;
  cause?: unknown;
}

export class LLMProviderError extends Error {
  public readonly provider: string;
  public readonly kind: LLMProviderErrorKind;
  public readonly status?: number;
  public readonly finishReason?: string | null;
  public readonly reasoningOnly?: boolean;

  public constructor(options: LLMProviderErrorOptions) {
    super(options.message);
    this.name = "LLMProviderError";
    this.provider = options.provider;
    this.kind = options.kind;
    this.status = options.status;
    this.finishReason = options.finishReason;
    this.reasoningOnly = options.reasoningOnly;
    if (options.cause !== undefined) {
      this.cause = options.cause;
    }
  }
}

export function createMissingApiKeyError(provider: string): LLMProviderError {
  return new LLMProviderError({
    provider,
    kind: "missingApiKey",
    message: `${provider} API Key 未配置。`
  });
}

export function createEmptyResponseError(
  provider: string,
  options: { finishReason?: string | null; reasoningOnly?: boolean } = {}
): LLMProviderError {
  const details = [
    options.reasoningOnly ? "模型只返回了思考内容，没有返回最终回答" : "模型最终内容为空",
    options.finishReason ? `finish_reason=${options.finishReason}` : undefined
  ].filter(Boolean).join("；");
  return new LLMProviderError({
    provider,
    kind: "emptyResponse",
    finishReason: options.finishReason,
    reasoningOnly: options.reasoningOnly,
    message: `${provider} 没有返回可用内容：${details || "模型最终内容为空"}。`
  });
}

export function createRequestError(provider: string, fallbackMessage: string, status?: number): LLMProviderError {
  return new LLMProviderError({
    provider,
    kind: classifyStatus(status, fallbackMessage),
    status,
    message: fallbackMessage
  });
}

export function formatProviderErrorForUser(error: unknown): string {
  if (error instanceof LLMProviderError) {
    return formatKnownProviderError(error);
  }

  const message = error instanceof Error ? error.message : String(error);
  const lower = message.toLowerCase();

  if (/api key is not configured|api key 未配置|missing api key|unauthorized|401|403/.test(lower)) {
    return "当前模型的 API Key 还没有配置，或服务端拒绝鉴权。请在设置里填写对应厂商的 API Key，并确认 Base URL 与接口协议正确。";
  }
  if (/empty response|没有返回可用内容|最终内容为空|only returned reasoning|只返回了思考内容/.test(lower)) {
    return "模型没有返回可用内容。常见原因是思考模型只返回了 reasoning、服务端输出为空、任务过长被截断，或 max_tokens 太小。请重试一次；如果仍失败，建议切换非思考模型、调大输出上限，或把任务拆小。";
  }
  if (/context_length|maximum context|token limit|too many tokens|上下文|超出.*token|413/.test(lower)) {
    return "请求上下文超过模型限制。请切换到“省 token”或“均衡”档位，减少引用文件，或把任务拆成更小步骤后重试。";
  }
  if (/rate limit|too many requests|429|限流|频率/.test(lower)) {
    return "模型服务触发限流。请稍后重试，或切换模型/供应商。";
  }
  if (/network|fetch failed|econn|timeout|timed out|dns|socket|网络|超时/.test(lower)) {
    return "模型请求网络失败或超时。请检查网络、代理、Base URL，或稍后重试。";
  }

  return message;
}

function formatKnownProviderError(error: LLMProviderError): string {
  switch (error.kind) {
    case "missingApiKey":
      return `${error.provider} 的 API Key 还没有配置。请在设置里填写 API Key 后再试。`;
    case "emptyResponse":
      return [
        `${error.provider} 没有返回可用内容。`,
        error.reasoningOnly ? "这通常表示模型只返回了思考内容，没有给出最终回答。" : "这通常表示服务端输出为空、任务过长被截断，或输出上限太小。",
        error.finishReason ? `服务端 finish_reason：${error.finishReason}。` : "",
        "建议重试一次；如果仍失败，切换非思考模型、调大 max_tokens，或把任务拆小。"
      ].filter(Boolean).join("");
    case "contextLength":
      return "请求上下文超过模型限制。请减少引用文件，切换更省 token 的上下文档位，或把任务拆小。";
    case "rateLimit":
      return `${error.provider} 触发限流。请稍后重试，或切换模型/供应商。`;
    case "auth":
      return `${error.provider} 鉴权失败。请检查 API Key、Base URL 和接口协议是否匹配。`;
    case "network":
      return `${error.provider} 网络请求失败。请检查网络、代理和 Base URL。`;
    case "server":
      return `${error.provider} 服务端返回错误${error.status ? `（HTTP ${error.status}）` : ""}：${error.message}`;
    default:
      return error.message;
  }
}

function classifyStatus(status: number | undefined, message: string): LLMProviderErrorKind {
  const lower = message.toLowerCase();
  if (status === 401 || status === 403 || /unauthorized|forbidden|invalid api key|鉴权/.test(lower)) {
    return "auth";
  }
  if (status === 429 || /rate limit|too many requests|限流/.test(lower)) {
    return "rateLimit";
  }
  if (status === 400 && /context|token|too long|上下文/.test(lower)) {
    return "contextLength";
  }
  if (status && status >= 500) {
    return "server";
  }
  return "unknown";
}
