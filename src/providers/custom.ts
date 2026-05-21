import { getCustomProviderProtocol } from "../config";
import { createEmptyResponseError, createMissingApiKeyError, createRequestError } from "./errors";
import { ChatRequest, ChatResponse, ChatStreamOptions, LLMProvider } from "./types";

interface OpenAICompatibleResponse {
  model?: string;
  choices?: Array<{
    finish_reason?: string | null;
    message?: {
      content?: string | null;
      reasoning_content?: string | null;
    };
  }>;
  output_text?: string;
  output?: Array<{
    content?: Array<{
      type?: string;
      text?: string;
    }>;
  }>;
  error?: {
    message?: string;
  };
}

interface OpenAICompatibleStreamChunk {
  model?: string;
  type?: string;
  delta?: string;
  response?: {
    model?: string;
  };
  choices?: Array<{
    delta?: {
      content?: string | null;
      reasoning_content?: string | null;
    };
    finish_reason?: string | null;
  }>;
  error?: {
    message?: string;
  };
}

interface AnthropicCompatibleResponse {
  model?: string;
  content?: Array<{
    type?: string;
    text?: string;
  }>;
  stop_reason?: string | null;
  error?: {
    message?: string;
  };
}

interface AnthropicCompatibleStreamEvent {
  type?: string;
  message?: {
    model?: string;
    stop_reason?: string | null;
  };
  delta?: {
    text?: string;
    stop_reason?: string | null;
  };
  error?: {
    message?: string;
  };
}

export interface CustomProviderOptions {
  baseUrlProvider: () => string;
  apiKeyProvider: () => Promise<string | undefined>;
}

export class CustomProvider implements LLMProvider {
  public readonly id = "custom";
  public readonly name = "Custom";

  public constructor(private readonly options: CustomProviderOptions) {}

  public async chat(request: ChatRequest, options?: ChatStreamOptions): Promise<ChatResponse> {
    return getCustomProviderProtocol() === "anthropic"
      ? this.chatAnthropic(request, options)
      : this.chatOpenAI(request, options);
  }

  private async chatOpenAI(request: ChatRequest, options?: ChatStreamOptions): Promise<ChatResponse> {
    const apiKey = await this.options.apiKeyProvider();
    if (!apiKey) {
      throw createMissingApiKeyError("自定义模型");
    }

    const useResponsesApi = /^(gpt-5|o\d|o[1-9]-)/i.test(request.model);
    const body = useResponsesApi ? this.buildResponsesBody(request, options) : this.buildChatCompletionsBody(request, options);
    const endpoint = useResponsesApi ? "responses" : "chat/completions";
    const response = await fetch(`${this.options.baseUrlProvider().replace(/\/+$/, "")}/${endpoint}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`
      },
      signal: options?.signal,
      body: JSON.stringify(body)
    });

    if (options?.onDelta) {
      return this.readOpenAIStreamResponse(response, request, options.onDelta);
    }

    const payload = await response.json() as OpenAICompatibleResponse;
    if (!response.ok) {
      throw createRequestError("自定义模型", payload.error?.message ?? `Custom request failed with status ${response.status}.`, response.status);
    }

    const content = this.extractContent(payload);
    if (!content) {
      throw createOpenAIEmptyResponseError("自定义模型", payload);
    }

    return {
      content,
      model: payload.model ?? request.model,
      providerId: this.id,
      finishReason: payload.choices?.[0]?.finish_reason
    };
  }

  private async chatAnthropic(request: ChatRequest, options?: ChatStreamOptions): Promise<ChatResponse> {
    const apiKey = await this.options.apiKeyProvider();
    if (!apiKey) {
      throw createMissingApiKeyError("自定义模型");
    }

    const { system, messages } = splitSystemMessage(request);
    const body: Record<string, unknown> = {
      model: request.model,
      max_tokens: request.maxTokens ?? 4096,
      temperature: request.temperature ?? 0.2,
      system,
      messages,
      stream: Boolean(options?.onDelta)
    };

    if (request.topP !== undefined) {
      body.top_p = request.topP;
    }

    const response = await fetch(`${this.options.baseUrlProvider().replace(/\/+$/, "")}/messages`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01"
      },
      signal: options?.signal,
      body: JSON.stringify(body)
    });

    if (options?.onDelta) {
      return this.readAnthropicStreamResponse(response, request, options.onDelta);
    }

    const payload = await response.json() as AnthropicCompatibleResponse;
    if (!response.ok) {
      throw createRequestError("自定义模型", payload.error?.message ?? `Custom request failed with status ${response.status}.`, response.status);
    }

    const content = payload.content?.filter((block) => block.type === "text").map((block) => block.text ?? "").join("") ?? "";
    if (!content.trim()) {
      throw createEmptyResponseError("自定义模型", { finishReason: payload.stop_reason });
    }

    return {
      content,
      model: payload.model ?? request.model,
      providerId: this.id,
      finishReason: payload.stop_reason
    };
  }

  private async readOpenAIStreamResponse(response: Response, request: ChatRequest, onDelta: (delta: string) => void): Promise<ChatResponse> {
    if (!response.ok) {
      const payload = await safeReadJson(response);
      throw createRequestError("自定义模型", payload?.error?.message ?? `Custom request failed with status ${response.status}.`, response.status);
    }

    if (!response.body) {
      throw new Error("Custom did not return a stream body.");
    }

    const decoder = new TextDecoder();
    const reader = response.body.getReader();
    let buffer = "";
    let content = "";
    let reasoningReceived = false;
    let finishReason: string | null | undefined;
    let responseModel = request.model;

    while (true) {
      const { value, done } = await reader.read();
      if (done) {
        break;
      }

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() ?? "";

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) {
          continue;
        }

        if (!trimmed.startsWith("data:") && !trimmed.startsWith("{")) {
          continue;
        }

        const data = trimmed.startsWith("data:") ? trimmed.slice("data:".length).trim() : trimmed;
        if (data === "[DONE]") {
          if (!content) {
            throw createOpenAIEmptyResponseError("自定义模型", undefined, { reasoningReceived, finishReason });
          }
          return {
            content,
            model: responseModel,
            providerId: this.id,
            finishReason
          };
        }
        if (!data) {
          continue;
        }

        let payload: OpenAICompatibleStreamChunk;
        try {
          payload = JSON.parse(data) as OpenAICompatibleStreamChunk;
        } catch {
          continue;
        }
        if (payload.error?.message) {
          throw new Error(payload.error.message);
        }

        responseModel = payload.model ?? payload.response?.model ?? responseModel;
        if (payload.choices?.[0]?.delta?.reasoning_content) {
          reasoningReceived = true;
        }
        finishReason = payload.choices?.[0]?.finish_reason ?? finishReason;
        const delta = payload.type === "response.output_text.delta"
          ? payload.delta ?? ""
          : payload.choices?.[0]?.delta?.content ?? "";
        if (delta) {
          content += delta;
          onDelta(delta);
        }
      }
    }

    if (!content) {
      throw createOpenAIEmptyResponseError("自定义模型", undefined, { reasoningReceived, finishReason });
    }

    return {
      content,
      model: responseModel,
      providerId: this.id,
      finishReason
    };
  }

  private async readAnthropicStreamResponse(response: Response, request: ChatRequest, onDelta: (delta: string) => void): Promise<ChatResponse> {
    if (!response.ok) {
      const payload = await safeReadJson(response);
      throw createRequestError("自定义模型", payload?.error?.message ?? `Custom request failed with status ${response.status}.`, response.status);
    }

    if (!response.body) {
      throw new Error("Custom did not return a stream body.");
    }

    const decoder = new TextDecoder();
    const reader = response.body.getReader();
    let buffer = "";
    let content = "";
    let responseModel = request.model;
    let finishReason: string | null | undefined;

    while (true) {
      const { value, done } = await reader.read();
      if (done) {
        break;
      }

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() ?? "";

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith("data:")) {
          continue;
        }

        const data = trimmed.slice("data:".length).trim();
        if (data === "[DONE]") {
          if (!content.trim()) {
            throw createEmptyResponseError("自定义模型", { finishReason });
          }
          return {
            content,
            model: responseModel,
            providerId: this.id,
            finishReason
          };
        }

        const payload = JSON.parse(data) as AnthropicCompatibleStreamEvent;
        if (payload.error?.message) {
          throw new Error(payload.error.message);
        }

        responseModel = payload.message?.model ?? responseModel;
        finishReason = payload.delta?.stop_reason ?? payload.message?.stop_reason ?? finishReason;
        const delta = payload.delta?.text ?? "";
        if (delta) {
          content += delta;
          onDelta(delta);
        }
      }
    }

    if (!content.trim()) {
      throw createEmptyResponseError("自定义模型", { finishReason });
    }

    return {
      content,
      model: responseModel,
      providerId: this.id,
      finishReason
    };
  }

  private buildChatCompletionsBody(request: ChatRequest, options?: ChatStreamOptions): Record<string, unknown> {
    const body: Record<string, unknown> = {
      model: request.model,
      messages: request.messages,
      temperature: request.temperature ?? 0.2,
      top_p: request.topP,
      stream: Boolean(options?.onDelta)
    };

    if (request.maxTokens) {
      body.max_tokens = request.maxTokens;
    }

    return body;
  }

  private buildResponsesBody(request: ChatRequest, options?: ChatStreamOptions): Record<string, unknown> {
    const systemMessages = request.messages.filter((message) => message.role === "system").map((message) => message.content).join("\n\n");
    const input = request.messages
      .filter((message) => message.role !== "system")
      .map((message) => ({
        role: message.role,
        content: message.content
      }));

    const body: Record<string, unknown> = {
      model: request.model,
      input,
      stream: Boolean(options?.onDelta)
    };

    if (systemMessages) {
      body.instructions = systemMessages;
    }
    if (request.maxTokens) {
      body.max_output_tokens = request.maxTokens;
    }
    if (request.temperature !== undefined) {
      body.temperature = request.temperature;
    }
    if (request.topP !== undefined) {
      body.top_p = request.topP;
    }

    return body;
  }

  private extractContent(payload: OpenAICompatibleResponse): string | undefined {
    const chatContent = payload.choices?.[0]?.message?.content;
    if (chatContent) {
      return chatContent;
    }

    if (payload.output_text) {
      return payload.output_text;
    }

    return payload.output
      ?.flatMap((item) => item.content ?? [])
      .map((item) => item.text ?? "")
      .join("");
  }
}

function splitSystemMessage(request: ChatRequest): { system?: string; messages: Array<{ role: "user" | "assistant"; content: string }> } {
  const systemMessages: string[] = [];
  const messages: Array<{ role: "user" | "assistant"; content: string }> = [];

  for (const message of request.messages) {
    if (message.role === "system") {
      systemMessages.push(message.content);
    } else {
      messages.push({
        role: message.role,
        content: message.content
      });
    }
  }

  return {
    system: systemMessages.length > 0 ? systemMessages.join("\n\n") : undefined,
    messages
  };
}

function createOpenAIEmptyResponseError(name: string, payload?: OpenAICompatibleResponse, stream?: { reasoningReceived?: boolean; finishReason?: string | null }): Error {
  const choice = payload?.choices?.[0];
  const reasoningReceived = Boolean(stream?.reasoningReceived || choice?.message?.reasoning_content);
  const finishReason = stream?.finishReason ?? choice?.finish_reason;
  return createEmptyResponseError(name, {
    finishReason,
    reasoningOnly: reasoningReceived
  });
}

async function safeReadJson(response: Response): Promise<OpenAICompatibleResponse | AnthropicCompatibleResponse | undefined> {
  try {
    return await response.json();
  } catch {
    return undefined;
  }
}
