export type ChatRole = "system" | "user" | "assistant";

export interface ChatMessage {
  role: ChatRole;
  content: string;
}

export interface ChatRequest {
  model: string;
  messages: ChatMessage[];
  temperature?: number;
  maxTokens?: number;
  topP?: number;
}

export interface ChatStreamOptions {
  signal?: AbortSignal;
  onDelta?: (delta: string) => void;
}

export interface ChatResponse {
  content: string;
  model: string;
  providerId: string;
  finishReason?: string | null;
}

export interface LLMProvider {
  id: string;
  name: string;
  chat(request: ChatRequest, options?: ChatStreamOptions): Promise<ChatResponse>;
}
