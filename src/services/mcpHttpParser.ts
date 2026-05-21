export interface JsonRpcResponse {
  id?: number;
  result?: unknown;
  error?: {
    code?: number;
    message?: string;
    data?: unknown;
  };
}

export async function readSseJsonRpcResponse(response: Response, expectedId: number, signal?: AbortSignal): Promise<JsonRpcResponse | undefined> {
  if (!response.body) {
    throw new Error("HTTP MCP SSE 响应没有可读取的 body。");
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    while (true) {
      if (signal?.aborted) {
        throw new DOMException("The operation was aborted.", "AbortError");
      }

      const { value, done } = await reader.read();
      if (done) {
        break;
      }
      buffer += decoder.decode(value, { stream: true });

      const extracted = extractSseEvents(buffer);
      buffer = extracted.rest;
      for (const event of extracted.events) {
        const payload = parseSseJsonRpcEvent(event, expectedId);
        if (payload) {
          await reader.cancel().catch(() => undefined);
          return payload;
        }
      }
    }

    return parseSseJsonRpcEvent(buffer, expectedId);
  } finally {
    await reader.cancel().catch(() => undefined);
  }
}

export function extractSseEvents(buffer: string): { events: string[]; rest: string } {
  const normalized = buffer.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const parts = normalized.split("\n\n");
  return {
    events: parts.slice(0, -1).filter((part) => part.trim().length > 0),
    rest: parts.at(-1) ?? ""
  };
}

export function parseSseJsonRpcEvent(event: string, expectedId?: number): JsonRpcResponse | undefined {
  const data = event
    .split(/\n/)
    .map((line) => line.trimEnd())
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice("data:".length).trimStart())
    .filter((line) => line && line !== "[DONE]")
    .join("\n")
    .trim();
  if (!data) {
    return undefined;
  }
  return parseJsonRpcResponseCandidate(data, expectedId);
}

export function parseHttpMcpPayload(text: string, expectedId?: number): JsonRpcResponse {
  const trimmed = text.trim();
  if (!trimmed) {
    return {};
  }

  if (trimmed.startsWith("data:") || trimmed.includes("\ndata:")) {
    const events = extractSseEvents(`${trimmed}\n\n`).events;
    for (const event of events) {
      const response = parseSseJsonRpcEvent(event, expectedId);
      if (response) {
        return response;
      }
    }
    return {};
  }

  return parseJsonRpcResponseCandidate(trimmed, expectedId) ?? {};
}

function parseJsonRpcResponseCandidate(data: string, expectedId?: number): JsonRpcResponse | undefined {
  const value = JSON.parse(data) as unknown;
  if (Array.isArray(value)) {
    return value.map(normalizeJsonRpcResponse).find((item) => matchesJsonRpcId(item, expectedId));
  }
  const response = normalizeJsonRpcResponse(value);
  return matchesJsonRpcId(response, expectedId) ? response : undefined;
}

function normalizeJsonRpcResponse(value: unknown): JsonRpcResponse {
  return value && typeof value === "object" ? value as JsonRpcResponse : {};
}

function matchesJsonRpcId(response: JsonRpcResponse, expectedId?: number): boolean {
  return expectedId === undefined || response.id === expectedId;
}
