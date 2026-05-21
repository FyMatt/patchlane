import { ChatRequest, ChatResponse, ChatStreamOptions, LLMProvider } from "./types";
import { createEmptyResponseError, createMissingApiKeyError, createRequestError } from "./errors";

interface AnthropicContentBlock {
  type?: string;
  text?: string;
}

interface AnthropicResponse {
  model?: string;
  content?: AnthropicContentBlock[];
  stop_reason?: string | null;
  error?: {
    message?: string;
  };
}

interface AnthropicStreamEvent {
  type?: string;
  message?: {
    model?: string;
  };
  delta?: {
    text?: string;
    stop_reason?: string | null;
  };
  error?: {
    message?: string;
  };
}

export interface AnthropicProviderOptions {
  baseUrlProvider: () => string;
  apiKeyProvider: () => Promise<string | undefined>;
  id?: string;
  name?: string;
}

export class AnthropicProvider implements LLMProvider {
  public readonly id: string;
  public readonly name: string;

  public constructor(private readonly options: AnthropicProviderOptions) {
    this.id = options.id ?? "anthropic";
    this.name = options.name ?? "Anthropic";
  }

  public async chat(request: ChatRequest, options?: ChatStreamOptions): Promise<ChatResponse> {
    const apiKey = await this.options.apiKeyProvider();
    if (!apiKey) {
      throw createMissingApiKeyError(this.name);
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

    if (request.topP !== undefined && !this.isOpus41(request.model)) {
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
      return this.readStreamResponse(response, request, options.onDelta);
    }

    const payload = await response.json() as AnthropicResponse;
    if (!response.ok) {
      throw createRequestError(this.name, payload.error?.message ?? `${this.name} request failed with status ${response.status}.`, response.status);
    }

    const content = payload.content?.filter((block) => block.type === "text").map((block) => block.text ?? "").join("") ?? "";
    if (!content.trim()) {
      throw createEmptyResponseError(this.name);
    }

    return {
      content,
      model: payload.model ?? request.model,
      providerId: this.id,
      finishReason: payload.stop_reason
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

        const payload = JSON.parse(trimmed.slice("data:".length).trim()) as AnthropicStreamEvent;
        if (payload.error?.message) {
          throw new Error(payload.error.message);
        }

        responseModel = payload.message?.model ?? responseModel;
        finishReason = payload.delta?.stop_reason ?? finishReason;
        const delta = payload.delta?.text ?? "";
        if (delta) {
          content += delta;
          onDelta(delta);
        }
      }
    }

    if (!content.trim()) {
      throw createEmptyResponseError(this.name);
    }

    return {
      content,
      model: responseModel,
      providerId: this.id,
      finishReason
    };
  }

  private isOpus41(model: string): boolean {
    return model.startsWith("claude-opus-4-1");
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

async function safeReadJson(response: Response): Promise<AnthropicResponse | undefined> {
  try {
    return await response.json() as AnthropicResponse;
  } catch {
    return undefined;
  }
}
