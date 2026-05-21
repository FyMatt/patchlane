export const FREE_SEARCH_BASE_URLS = [
  "https://search.inetol.net",
  "https://searx.tiekoetter.com",
  "https://opnxng.com",
  "https://baresearch.org",
  "https://searx.perennialte.ch"
];

export function getFreeSearchBaseUrls(configuredBaseUrl = ""): string[] {
  const urls = [configuredBaseUrl.trim(), ...FREE_SEARCH_BASE_URLS]
    .filter(Boolean)
    .map((url) => url.replace(/\/+$/, ""));
  return [...new Set(urls)];
}

export function doesSearchProviderNeedApiKey(provider: string): boolean {
  return provider === "custom" || provider === "tavily" || provider === "brave" || provider === "bing" || provider === "serpapi";
}

export function webSearchProviderLabel(provider: string): string {
  const labels: Record<string, string> = {
    free: "免费搜索",
    custom: "自定义搜索",
    searxng: "SearXNG",
    tavily: "Tavily",
    brave: "Brave Search",
    bing: "Bing",
    serpapi: "SerpAPI"
  };
  return labels[provider] ?? provider;
}
