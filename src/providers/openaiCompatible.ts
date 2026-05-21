import { ChatRequest, ChatResponse, ChatStreamOptions, LLMProvider } from "./types";
import { createEmptyResponseError, createMissingApiKeyError, createRequestError } from "./errors";

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

export interface OpenAICompatibleProviderOptions {
  id: string;
  name: string;
  baseUrlProvider: () => string;
  apiKeyProvider?: () => Promise<string | undefined>;
  requireApiKey?: boolean;
  useResponsesApi?: boolean;
}

export class OpenAICompatibleProvider implements LLMProvider {
  public readonly id: string;
  public readonly name: string;

  public constructor(private readonly options: OpenAICompatibleProviderOptions) {
    this.id = options.id;
    this.name = options.name;
  }

  public async chat(request: ChatRequest, options?: ChatStreamOptions): Promise<ChatResponse> {
    const apiKey = await this.options.apiKeyProvider?.();
    if (this.options.requireApiKey !== false && !apiKey) {
      throw createMissingApiKeyError(this.name);
    }

    const headers: Record<string, string> = {
      "Content-Type": "application/json"
    };
    if (apiKey) {
      headers.Authorization = `Bearer ${apiKey}`;
    }

    const useResponsesApi = this.shouldUseResponsesApi(request.model);
    const body = useResponsesApi ? this.buildResponsesBody(request, options) : this.buildChatCompletionsBody(request, options);

    const endpoint = useResponsesApi ? "responses" : "chat/completions";
    const response = await fetch(`${this.options.baseUrlProvider().replace(/\/+$/, "")}/${endpoint}`, {
      method: "POST",
      headers,
      signal: options?.signal,
      body: JSON.stringify(body)
    });

    if (options?.onDelta) {
      return this.readStreamResponse(response, request, options.onDelta);
    }

    const payload = await response.json() as OpenAICompatibleResponse;

    if (!response.ok) {
      throw createRequestError(this.name, payload.error?.message ?? `${this.name} request failed with status ${response.status}.`, response.status);
    }

    const content = this.extractContent(payload);
    if (!content) {
      throw this.createEmptyResponseError(payload);
    }

    return {
      content,
      model: payload.model ?? request.model,
      providerId: this.id,
      finishReason: payload.choices?.[0]?.finish_reason
    };
  }

  private async readStreamResponse(response: Response, request: ChatRequest, onDelta: (delta: string) => void): Promise<ChatResponse> {
    if (!response.ok) {
      const payload = await safeReadJson(response);
      throw createRequestError(this.name, payload?.error?.message ?? `${this.name} request failed with status ${response.status}.`, response.status);
    }

    if (!response.body) {
      throw new Error(`${this.name} did not return a stream body.`);
    }

    const decoder = new TextDecoder();
    const reader = response.body.getReader();
    let buffer = "";
    let content = "";
    let reasoningReceived = false;
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
        if (!trimmed) {
          continue;
        }

        if (!trimmed.startsWith("data:") && !trimmed.startsWith("{")) {
          continue;
        }

        const data = trimmed.startsWith("data:") ? trimmed.slice("data:".length).trim() : trimmed;
        if (data === "[DONE]") {
          if (!content) {
            throw this.createEmptyResponseError(undefined, { reasoningReceived, finishReason });
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
        finishReason = payload.choices?.[0]?.finish_reason ?? finishReason;
        if (payload.choices?.[0]?.delta?.reasoning_content) {
          reasoningReceived = true;
        }
        const delta = this.extractStreamDelta(payload);
        if (delta) {
          content += delta;
          onDelta(delta);
        }
      }
    }

    if (!content) {
      throw this.createEmptyResponseError(undefined, { reasoningReceived, finishReason });
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

  private shouldUseResponsesApi(model: string): boolean {
    const allowResponses = this.options.useResponsesApi ?? this.id === "openai";
    return allowResponses && /^(gpt-5|o\d|o[1-9]-)/i.test(model);
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

  private extractStreamDelta(payload: OpenAICompatibleStreamChunk): string {
    if (payload.type === "response.output_text.delta") {
      return payload.delta ?? "";
    }

    return payload.choices?.[0]?.delta?.content ?? "";
  }

  private createEmptyResponseError(payload?: OpenAICompatibleResponse, stream?: { reasoningReceived?: boolean; finishReason?: string | null }): Error {
    const choice = payload?.choices?.[0];
    const reasoningReceived = Boolean(stream?.reasoningReceived || choice?.message?.reasoning_content);
    const finishReason = stream?.finishReason ?? choice?.finish_reason;
    return createEmptyResponseError(this.name, {
      finishReason,
      reasoningOnly: reasoningReceived
    });
  }
}

async function safeReadJson(response: Response): Promise<OpenAICompatibleResponse | undefined> {
  try {
    return await response.json() as OpenAICompatibleResponse;
  } catch {
    return undefined;
  }
}
