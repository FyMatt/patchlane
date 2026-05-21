import { doesSearchProviderNeedApiKey, webSearchProviderLabel } from "./webSearchDefaults";

export function formatWebSearchError(error: unknown, provider?: string): string {
  const message = error instanceof Error ? error.message : String(error);
  const lower = message.toLowerCase();
  const normalizedProvider = provider ?? "free";
  const providerName = webSearchProviderLabel(normalizedProvider);

  if (/免费搜索暂时不可用/.test(lower)) {
    return message;
  }
  if (normalizedProvider === "free" && /searxng|duckduckgo|联网搜索请求失败|invalid json|unexpected token|json/.test(lower)) {
    return message;
  }
  if (doesSearchProviderNeedApiKey(normalizedProvider) && /api key|401|403|unauthorized|forbidden|subscription|token|鉴权/.test(lower)) {
    return `${providerName} 需要有效的搜索 API Key。可以切换到“免费搜索（无需 Key）”，或重新配置联网搜索。`;
  }
  if (/429|rate limit|too many requests|限流|频率/.test(lower)) {
    return `${providerName} 搜索服务触发限流。免费公开实例不保证稳定，可以稍后重试，填写自建 SearXNG Base URL，或切换其他搜索服务。`;
  }
  if (/network|fetch failed|econn|enotfound|timeout|timed out|dns|socket|网络|超时/.test(lower)) {
    return `${providerName} 搜索请求网络失败。请检查网络、代理或 Base URL，也可以换一个搜索服务。`;
  }
  if (/searxng|duckduckgo|联网搜索请求失败|invalid json|unexpected token|json/.test(lower)) {
    return message;
  }

  return `${providerName} 搜索失败：${message}`;
}
