import { getWebSearchAllowedDomains, getWebSearchBaseUrl, getWebSearchBlockedDomains, getWebSearchDefaultRecencyDays, getWebSearchMaxResults, getWebSearchProvider, isWebSearchEnabled, type WebSearchProvider } from "../config";
import { SecretService } from "./secretService";
import { doesSearchProviderNeedApiKey, getFreeSearchBaseUrls, webSearchProviderLabel } from "./webSearchDefaults";
import {
  parseBaiduHtmlResults,
  parseBingHtmlResults,
  parseDuckDuckGoHtmlResults,
  parseSearxngHtmlResults,
  parseSogouHtmlResults
} from "./webSearchParsing";
import { rankAndFilterSearchResults } from "./webSearchRelevance";
import { annotateWebSearchResult, WebSearchTrustLabel } from "./webSearchTrust";

export interface WebSearchRequest {
  sessionId: string;
  query: string;
  recencyDays?: number;
  allowWeb?: boolean;
  sourceHint?: WebSearchSourceHint;
}

export interface WebSearchResult {
  title: string;
  url: string;
  snippet: string;
  source?: string;
  publishedAt?: string;
  updatedAt?: string;
  rank: number;
  isOfficial?: boolean;
  trustLabel?: WebSearchTrustLabel;
  citation?: string;
}

export interface WebPageContent {
  url: string;
  title?: string;
  content: string;
  source?: string;
  fetchedAt: string;
}

export interface WebSearchResponse {
  provider: WebSearchProvider;
  query: string;
  sourceHint: WebSearchSourceHint;
  results: WebSearchResult[];
  fetchedAt: string;
  recencyDays?: number;
}

export type WebSearchSourceHint = "general" | "docs" | "news" | "github";

export interface WebSearchResultOptions {
  signal?: AbortSignal;
  onStatus?: (status: string) => void;
}

interface SearchByProviderOptions {
  signal?: AbortSignal;
  maxResults: number;
  recencyDays?: number;
  allowedDomains: string[];
  blockedDomains: string[];
  onStatus?: (status: string) => void;
  originalQuery: string;
  sourceHint: WebSearchSourceHint;
}

const FREE_SEARCH_SOURCE_TIMEOUT_MS = 8000;
const FREE_SEARCH_DISCOVERY_TIMEOUT_MS = 5000;

export class WebSearchService {
  public constructor(private readonly secrets: SecretService) {}

  public isEnabled(): boolean {
    return isWebSearchEnabled();
  }

  public async search(request: WebSearchRequest, options: WebSearchResultOptions = {}): Promise<WebSearchResponse> {
    if (!this.isEnabled()) {
      throw new Error("联网搜索功能尚未启用。");
    }

    const query = request.query.trim();
    if (!query) {
      throw new Error("搜索关键词不能为空。");
    }

    const provider = getWebSearchProvider();
    const allowedDomains = getWebSearchAllowedDomains();
    const blockedDomains = getWebSearchBlockedDomains();
    const maxResults = getWebSearchMaxResults();
    const sourceHint = normalizeSourceHint(request.sourceHint);
    const recencyDays = request.recencyDays ?? defaultRecencyForHint(sourceHint, getWebSearchDefaultRecencyDays());
    const routedQuery = routeQueryForHint(query, sourceHint);
    options.onStatus?.(`联网搜索：${routedQuery}`);

    const results = rankAndFilterSearchResults(await this.searchByProvider(provider, routedQuery, {
      signal: options.signal,
      maxResults,
      recencyDays,
      allowedDomains,
      blockedDomains,
      onStatus: options.onStatus,
      originalQuery: query,
      sourceHint
    }), query, sourceHint)
      .slice(0, maxResults)
      .map((item) => annotateWebSearchResult(item, sourceHint));

    return {
      provider,
      query,
      sourceHint,
      results,
      fetchedAt: new Date().toISOString(),
      recencyDays
    };
  }

  public async fetch(url: string, options: WebSearchResultOptions = {}): Promise<WebPageContent> {
    if (!this.isEnabled()) {
      throw new Error("联网搜索功能尚未启用。");
    }

    const normalizedUrl = normalizeUrl(url);
    if (!normalizedUrl) {
      throw new Error("无效的网页地址。");
    }

    const response = await fetch(normalizedUrl, {
      signal: options.signal,
      headers: {
        "User-Agent": "Patchlane/1.0"
      }
    });
    if (!response.ok) {
      throw new Error(`读取网页失败：${response.status} ${response.statusText}`);
    }

    const html = await response.text();
    const title = matchTitle(html);
    const content = extractReadableText(html);
    return {
      url: normalizedUrl,
      title,
      content,
      fetchedAt: new Date().toISOString(),
      source: new URL(normalizedUrl).hostname
    };
  }

  public async getApiKey(): Promise<string | undefined> {
    return this.secrets.getWebSearchApiKey();
  }

  private async searchByProvider(
    provider: WebSearchProvider,
    query: string,
    options: SearchByProviderOptions
  ): Promise<WebSearchResult[]> {
    switch (provider) {
      case "free":
        return this.searchFree(query, options);
      case "searxng":
        return this.searchSearxng(query, options);
      case "tavily":
        return this.searchTavily(query, options);
      case "brave":
        return this.searchBrave(query, options);
      case "bing":
        return this.searchBing(query, options);
      case "serpapi":
        return this.searchSerpApi(query, options);
      default:
        return this.searchCustom(query, options);
    }
  }

  private async searchCustom(query: string, options: SearchByProviderOptions): Promise<WebSearchResult[]> {
    const baseUrl = getWebSearchBaseUrl();
    if (!baseUrl) {
      throw new Error("请先配置联网搜索 Base URL。");
    }
    const apiKey = await this.secrets.getWebSearchApiKey();
    const response = await fetch(buildSearchUrl(baseUrl, query, options.maxResults, options.recencyDays), {
      signal: options.signal,
      headers: buildAuthHeaders(apiKey)
    });
    return normalizeSearchResults(await readSearchResponse(response), options.allowedDomains, options.blockedDomains, options.maxResults);
  }

  private async searchFree(query: string, options: SearchByProviderOptions): Promise<WebSearchResult[]> {
    const errors: string[] = [];
    const gathered: WebSearchResult[] = [];
    const globalQuery = buildFreeSearchQuery(options.originalQuery || query, options.sourceHint, "global");
    const chineseQuery = buildFreeSearchQuery(options.originalQuery || query, options.sourceHint, "cn");
    const configuredBaseUrl = getWebSearchBaseUrl();
    if (configuredBaseUrl) {
      const configuredResults = await this.tryFreeSearchSource(
        `自建 SearXNG（${safeHost(configuredBaseUrl) ?? configuredBaseUrl}）`,
        (sourceOptions) => this.searchSearxngBaseUrl(configuredBaseUrl, globalQuery, sourceOptions),
        errors,
        options
      );
      if (configuredResults) {
        gathered.push(...configuredResults);
        const enough = this.rankFreeResults(gathered, options);
        if (enough.length >= options.maxResults) {
          return enough;
        }
      }
    }

    const htmlSources: Array<{
      label: string;
      run: (sourceOptions: SearchByProviderOptions) => Promise<WebSearchResult[]>;
    }> = [
      { label: "Bing HTML", run: (sourceOptions) => this.searchBingHtml(globalQuery, sourceOptions) },
      { label: "百度 HTML", run: (sourceOptions) => this.searchBaiduHtml(chineseQuery, sourceOptions) },
      { label: "搜狗 HTML", run: (sourceOptions) => this.searchSogouHtml(chineseQuery, sourceOptions) },
      { label: "DuckDuckGo HTML", run: (sourceOptions) => this.searchDuckDuckGoHtml(globalQuery, sourceOptions) }
    ];

    for (const source of htmlSources) {
      const results = await this.tryFreeSearchSource(source.label, source.run, errors, options);
      if (results) {
        gathered.push(...results);
        const enough = this.rankFreeResults(gathered, options);
        if (enough.length >= options.maxResults) {
          return enough;
        }
      }
    }

    const baseUrls = await this.getPublicSearxngCandidates(options, configuredBaseUrl);
    for (const baseUrl of baseUrls) {
      const results = await this.tryFreeSearchSource(
        `公开 SearXNG（${safeHost(baseUrl) ?? baseUrl}）`,
        (sourceOptions) => this.searchSearxngBaseUrl(baseUrl, globalQuery, sourceOptions),
        errors,
        options
      );
      if (results) {
        gathered.push(...results);
        const enough = this.rankFreeResults(gathered, options);
        if (enough.length >= options.maxResults) {
          return enough;
        }
      }
    }

    const ranked = this.rankFreeResults(gathered, options);
    if (ranked.length > 0) {
      return ranked;
    }

    const detail = errors.slice(0, 8).map((item) => `- ${item}`).join("\n");
    throw new Error([
      "免费搜索暂时不可用。已尝试 Bing HTML、百度、搜狗、DuckDuckGo 和公开 SearXNG，但当前网络都无法访问、返回验证码/不可解析页面，或没有找到足够相关的结果。",
      "建议：在“配置联网搜索”里继续使用“免费搜索（无需 Key）”，并填写你自己的 SearXNG Base URL；如果需要更稳定的搜索，再切换到 Tavily、Brave、Bing 或 SerpAPI 并填写对应 Key。",
      detail ? `失败明细：\n${detail}` : undefined
    ].filter(Boolean).join("\n"));
  }

  private async tryFreeSearchSource(
    label: string,
    run: (sourceOptions: SearchByProviderOptions) => Promise<WebSearchResult[]>,
    errors: string[],
    options: SearchByProviderOptions
  ): Promise<WebSearchResult[] | undefined> {
    const timeout = createTimeoutSignal(options.signal, FREE_SEARCH_SOURCE_TIMEOUT_MS);
    try {
      options.onStatus?.(`尝试免费搜索：${label}`);
      const results = await run({ ...options, signal: timeout.signal });
      if (results.length > 0) {
        return results;
      }
      errors.push(`${label}: 没有返回可解析结果`);
      return undefined;
    } catch (error) {
      if (isAbortError(error) && options.signal?.aborted) {
        throw error;
      }
      errors.push(`${label}: ${timeout.timedOut() ? "请求超时" : formatAttemptError(error)}`);
      return undefined;
    } finally {
      timeout.dispose();
    }
  }

  private rankFreeResults(results: WebSearchResult[], options: SearchByProviderOptions): WebSearchResult[] {
    return rankAndFilterSearchResults(dedupeSearchResults(results), options.originalQuery, options.sourceHint).slice(0, options.maxResults);
  }

  private async searchSearxng(query: string, options: SearchByProviderOptions): Promise<WebSearchResult[]> {
    const baseUrl = getWebSearchBaseUrl();
    if (!baseUrl) {
      throw new Error("请先配置 SearXNG Base URL。");
    }
    return this.searchSearxngBaseUrl(baseUrl, query, options);
  }

  private async searchTavily(query: string, options: SearchByProviderOptions): Promise<WebSearchResult[]> {
    const baseUrl = getWebSearchBaseUrl() || "https://api.tavily.com";
    const apiKey = await this.secrets.getWebSearchApiKey();
    ensureSearchApiKey("tavily", apiKey);
    const response = await fetch(`${baseUrl.replace(/\/+$/, "")}/search`, {
      method: "POST",
      signal: options.signal,
      headers: {
        "Content-Type": "application/json",
        ...buildAuthHeaders(apiKey)
      },
      body: JSON.stringify({
        query,
        max_results: options.maxResults,
        search_depth: "basic",
        include_answer: false,
        include_raw_content: false
      })
    });
    return normalizeSearchResults(await readSearchResponse(response), options.allowedDomains, options.blockedDomains, options.maxResults);
  }

  private async searchBrave(query: string, options: SearchByProviderOptions): Promise<WebSearchResult[]> {
    const baseUrl = getWebSearchBaseUrl() || "https://api.search.brave.com/res/v1";
    const apiKey = await this.secrets.getWebSearchApiKey();
    ensureSearchApiKey("brave", apiKey);
    const response = await fetch(`${baseUrl.replace(/\/+$/, "")}/web/search?q=${encodeURIComponent(query)}&count=${options.maxResults}`, {
      signal: options.signal,
      headers: {
        Accept: "application/json",
        "X-Subscription-Token": apiKey ?? ""
      }
    });
    return normalizeSearchResults(await readSearchResponse(response), options.allowedDomains, options.blockedDomains, options.maxResults);
  }

  private async searchBing(query: string, options: SearchByProviderOptions): Promise<WebSearchResult[]> {
    const baseUrl = getWebSearchBaseUrl() || "https://api.bing.microsoft.com/v7.0";
    const apiKey = await this.secrets.getWebSearchApiKey();
    ensureSearchApiKey("bing", apiKey);
    const response = await fetch(`${baseUrl.replace(/\/+$/, "")}/search?q=${encodeURIComponent(query)}&count=${options.maxResults}`, {
      signal: options.signal,
      headers: {
        Accept: "application/json",
        "Ocp-Apim-Subscription-Key": apiKey ?? ""
      }
    });
    return normalizeSearchResults(await readSearchResponse(response), options.allowedDomains, options.blockedDomains, options.maxResults);
  }

  private async searchSerpApi(query: string, options: SearchByProviderOptions): Promise<WebSearchResult[]> {
    const baseUrl = getWebSearchBaseUrl() || "https://serpapi.com";
    const apiKey = await this.secrets.getWebSearchApiKey();
    ensureSearchApiKey("serpapi", apiKey);
    const response = await fetch(`${baseUrl.replace(/\/+$/, "")}/search.json?q=${encodeURIComponent(query)}&num=${options.maxResults}&api_key=${encodeURIComponent(apiKey ?? "")}`, {
      signal: options.signal
    });
    return normalizeSearchResults(await readSearchResponse(response), options.allowedDomains, options.blockedDomains, options.maxResults);
  }

  private async searchSearxngBaseUrl(baseUrl: string, query: string, options: SearchByProviderOptions): Promise<WebSearchResult[]> {
    const searchUrl = buildSearxngSearchUrl(baseUrl, query, options.maxResults);
    const response = await fetch(searchUrl, {
      signal: options.signal,
      headers: {
        Accept: "application/json, text/html;q=0.8",
        "User-Agent": "Patchlane/1.0"
      }
    });

    const contentType = response.headers.get("content-type") ?? "";
    if (contentType.includes("application/json")) {
      return normalizeSearchResults(await readSearchResponse(response), options.allowedDomains, options.blockedDomains, options.maxResults);
    }
    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new Error(text.trim() || `联网搜索请求失败：${response.status} ${response.statusText}`);
    }
    const html = await response.text();
    return normalizeSearchResults(parseSearxngHtmlResults(html), options.allowedDomains, options.blockedDomains, options.maxResults);
  }

  private async searchDuckDuckGoHtml(query: string, options: SearchByProviderOptions): Promise<WebSearchResult[]> {
    const url = new URL("https://html.duckduckgo.com/html/");
    url.searchParams.set("q", query);
    url.searchParams.set("kl", "cn-zh");
    const html = await fetchSearchHtml(url.toString(), "DuckDuckGo HTML", options.signal);
    return normalizeSearchResults(parseDuckDuckGoHtmlResults(html), options.allowedDomains, options.blockedDomains, options.maxResults);
  }

  private async searchBingHtml(query: string, options: SearchByProviderOptions): Promise<WebSearchResult[]> {
    const url = new URL("https://www.bing.com/search");
    url.searchParams.set("q", query);
    url.searchParams.set("count", String(options.maxResults));
    url.searchParams.set("mkt", "zh-CN");
    url.searchParams.set("setlang", "zh-CN");
    const html = await fetchSearchHtml(url.toString(), "Bing HTML", options.signal);
    return normalizeSearchResults(parseBingHtmlResults(html), options.allowedDomains, options.blockedDomains, options.maxResults);
  }

  private async searchBaiduHtml(query: string, options: SearchByProviderOptions): Promise<WebSearchResult[]> {
    const url = new URL("https://www.baidu.com/s");
    url.searchParams.set("wd", query);
    url.searchParams.set("rn", String(options.maxResults));
    const html = await fetchSearchHtml(url.toString(), "百度 HTML", options.signal);
    return normalizeSearchResults(parseBaiduHtmlResults(html), options.allowedDomains, options.blockedDomains, options.maxResults);
  }

  private async searchSogouHtml(query: string, options: SearchByProviderOptions): Promise<WebSearchResult[]> {
    const url = new URL("https://www.sogou.com/web");
    url.searchParams.set("query", query);
    url.searchParams.set("num", String(options.maxResults));
    const html = await fetchSearchHtml(url.toString(), "搜狗 HTML", options.signal);
    return normalizeSearchResults(parseSogouHtmlResults(html), options.allowedDomains, options.blockedDomains, options.maxResults);
  }

  private async getPublicSearxngCandidates(options: SearchByProviderOptions, configuredBaseUrl = ""): Promise<string[]> {
    const discoveryTimeout = createTimeoutSignal(options.signal, FREE_SEARCH_DISCOVERY_TIMEOUT_MS);
    try {
      const discovered = await discoverPublicSearxngInstances({ signal: discoveryTimeout.signal }).catch(() => []);
      const normalizedConfigured = configuredBaseUrl.replace(/\/+$/, "");
      return [...new Set([...discovered, ...getFreeSearchBaseUrls()]
        .filter(Boolean)
        .map((item) => item.replace(/\/+$/, ""))
        .filter((item) => item !== normalizedConfigured))];
    } finally {
      discoveryTimeout.dispose();
    }
  }
}

function ensureSearchApiKey(provider: WebSearchProvider, apiKey?: string): void {
  if (doesSearchProviderNeedApiKey(provider) && !apiKey?.trim()) {
    throw new Error(`${webSearchProviderLabel(provider)} 需要 API Key。请在“配置联网搜索”里填写搜索服务的 Key，或切换到“免费搜索（无需 Key）”。`);
  }
}

function buildSearchUrl(baseUrl: string, query: string, maxResults: number, recencyDays?: number): string {
  const url = new URL(baseUrl.replace(/\/+$/, ""));
  url.searchParams.set("q", query);
  url.searchParams.set("num", String(maxResults));
  if (typeof recencyDays === "number") {
    url.searchParams.set("recency", String(recencyDays));
  }
  return url.toString();
}

function buildSearxngSearchUrl(baseUrl: string, query: string, maxResults: number): string {
  const url = new URL(`${baseUrl.replace(/\/+$/, "")}/search`);
  url.searchParams.set("q", query);
  url.searchParams.set("format", "json");
  url.searchParams.set("language", "auto");
  url.searchParams.set("safesearch", "0");
  url.searchParams.set("pageno", "1");
  url.searchParams.set("count", String(maxResults));
  return url.toString();
}

function buildAuthHeaders(apiKey?: string): Record<string, string> {
  if (!apiKey) {
    return {};
  }
  return {
    Authorization: `Bearer ${apiKey}`
  };
}

async function readSearchResponse(response: Response): Promise<unknown> {
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(text.trim() || `联网搜索请求失败：${response.status} ${response.statusText}`);
  }
  return response.json();
}

async function fetchSearchHtml(url: string, label: string, signal?: AbortSignal): Promise<string> {
  const response = await fetch(url, {
    signal,
    headers: {
      Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.7",
      "Cache-Control": "no-cache",
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36 Patchlane/1.0"
    }
  });
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(text.trim().slice(0, 200) || `${label} 请求失败：${response.status} ${response.statusText}`);
  }
  return response.text();
}

function createTimeoutSignal(parent: AbortSignal | undefined, timeoutMs: number): {
  signal: AbortSignal;
  timedOut: () => boolean;
  dispose: () => void;
} {
  const controller = new AbortController();
  let didTimeout = false;
  const timeout = setTimeout(() => {
    didTimeout = true;
    controller.abort();
  }, timeoutMs);
  const onAbort = () => controller.abort();
  if (parent) {
    if (parent.aborted) {
      controller.abort();
    } else {
      parent.addEventListener("abort", onAbort, { once: true });
    }
  }
  return {
    signal: controller.signal,
    timedOut: () => didTimeout,
    dispose: () => {
      clearTimeout(timeout);
      parent?.removeEventListener("abort", onAbort);
    }
  };
}

function formatAttemptError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (/fetch failed|network|socket|econn|enotfound|etimedout|dns/i.test(message)) {
    return "网络连接失败";
  }
  if (/aborted|abort/i.test(message)) {
    return "请求已中断";
  }
  return message.slice(0, 180);
}

export async function discoverPublicSearxngInstances(options: { signal?: AbortSignal } = {}): Promise<string[]> {
  const response = await fetch("https://searx.space/data/instances.json", {
    signal: options.signal,
    headers: {
      Accept: "application/json",
      "User-Agent": "Patchlane/1.0"
    }
  });
  const payload = await readSearchResponse(response);
  if (!payload || typeof payload !== "object") {
    return [];
  }
  const instances = (payload as Record<string, unknown>).instances;
  if (!instances || typeof instances !== "object") {
    return [];
  }
  return Object.entries(instances as Record<string, unknown>)
    .filter(([, value]) => isUsablePublicSearxngInstance(value))
    .map(([url]) => url.replace(/\/+$/, ""))
    .slice(0, 8);
}

function isUsablePublicSearxngInstance(value: unknown): boolean {
  if (!value || typeof value !== "object") {
    return false;
  }
  const item = value as Record<string, unknown>;
  const network = item.network && typeof item.network === "object" ? item.network as Record<string, unknown> : {};
  const timing = network.timing && typeof network.timing === "object" ? network.timing as Record<string, unknown> : {};
  const html = item.html && typeof item.html === "object" ? item.html as Record<string, unknown> : {};
  const grade = textValue(item.grade);
  const responseTime = Number(timing.search_go ?? timing.search);
  const httpStatus = typeof item.http === "boolean" ? item.http : String(item.http ?? "true") !== "false";
  const isOnline = item.network_type !== "offline" && httpStatus;
  const supportsSearch = html.search !== false;
  const hasDecentGrade = !grade || /^[ABC]/.test(grade);
  const isResponsive = !Number.isFinite(responseTime) || responseTime < 3;
  return isOnline && supportsSearch && hasDecentGrade && isResponsive;
}

function normalizeSearchResults(value: unknown, allowedDomains: string[], blockedDomains: string[], maxResults: number): WebSearchResult[] {
  const items = extractSearchItems(value);
  return items
    .map((item, index) => normalizeSearchItem(item, index + 1))
    .filter((item) => Boolean(item.url) && !isBlocked(item.url, blockedDomains) && isAllowed(item.url, allowedDomains))
    .slice(0, maxResults);
}

function dedupeSearchResults(results: WebSearchResult[]): WebSearchResult[] {
  const seen = new Set<string>();
  const deduped: WebSearchResult[] = [];
  for (const item of results) {
    const key = normalizeResultUrl(item.url) || `${item.title}\n${item.source ?? ""}`.toLowerCase();
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    deduped.push(item);
  }
  return deduped.map((item, index) => ({ ...item, rank: index + 1 }));
}

function normalizeResultUrl(value: string): string {
  try {
    const url = new URL(value);
    url.hash = "";
    for (const key of [...url.searchParams.keys()]) {
      if (/^(utm_|spm|from|source|ref|wd|query|q)$/i.test(key)) {
        url.searchParams.delete(key);
      }
    }
    return url.toString().replace(/\/+$/, "").toLowerCase();
  } catch {
    return value.trim().toLowerCase();
  }
}

function normalizeSourceHint(value: WebSearchSourceHint | undefined): WebSearchSourceHint {
  return value === "docs" || value === "news" || value === "github" ? value : "general";
}

function defaultRecencyForHint(sourceHint: WebSearchSourceHint, configured: number | undefined): number | undefined {
  if (sourceHint === "news") {
    return configured ? Math.min(configured, 14) : 14;
  }
  if (sourceHint === "github") {
    return configured ? Math.min(configured, 180) : 180;
  }
  return configured;
}

function routeQueryForHint(query: string, sourceHint: WebSearchSourceHint): string {
  if (sourceHint === "docs") {
    return `${query} official docs OR documentation`;
  }
  if (sourceHint === "github") {
    return `${query} site:github.com`;
  }
  if (sourceHint === "news") {
    return `${query} release changelog latest`;
  }
  return query;
}

function buildFreeSearchQuery(query: string, sourceHint: WebSearchSourceHint, locale: "global" | "cn"): string {
  const trimmed = query.trim();
  if (!trimmed) {
    return query;
  }
  if (sourceHint === "docs") {
    return locale === "cn"
      ? appendQueryHints(trimmed, ["官方文档", "配置", "使用说明"])
      : appendQueryHints(trimmed, ["official docs", "documentation", "configuration"]);
  }
  if (sourceHint === "github") {
    return locale === "cn"
      ? appendQueryHints(trimmed, ["GitHub", "仓库", "README"])
      : appendQueryHints(trimmed, ["site:github.com", "README"]);
  }
  if (sourceHint === "news") {
    return locale === "cn"
      ? appendQueryHints(trimmed, ["发布", "更新", "公告"])
      : appendQueryHints(trimmed, ["release", "changelog", "latest"]);
  }
  return trimmed;
}

function appendQueryHints(query: string, hints: string[]): string {
  const normalized = query.toLowerCase();
  const extra = hints.filter((hint) => !normalized.includes(hint.toLowerCase()));
  return [query, ...extra].join(" ");
}

function extractSearchItems(value: unknown): unknown[] {
  if (Array.isArray(value)) {
    return value;
  }
  if (!value || typeof value !== "object") {
    return [];
  }
  const object = value as Record<string, unknown>;
  const candidates = [
    object.results,
    object.webPages && typeof object.webPages === "object" ? (object.webPages as Record<string, unknown>).value : undefined,
    object.organic_results,
    object.items,
    object.data,
    object.entries
  ];
  for (const candidate of candidates) {
    if (Array.isArray(candidate)) {
      return candidate;
    }
  }
  return [];
}

function normalizeSearchItem(item: unknown, rank: number): WebSearchResult {
  const object = (item && typeof item === "object") ? item as Record<string, unknown> : {};
  const title = textValue(object.title) || textValue(object.name) || textValue(object.url) || "未命名结果";
  const url = textValue(object.url) || textValue(object.link) || textValue(object.href) || "";
  const snippet = textValue(object.snippet) || textValue(object.content) || textValue(object.description) || textValue(object.body) || "";
  const source = safeHost(url) || textValue(object.source) || textValue(object.displayUrl);
  return {
    title,
    url,
    snippet: snippet.trim() || "无摘要",
    source,
    publishedAt: textValue(object.publishedDate) || textValue(object.datePublished),
    updatedAt: textValue(object.dateModified) || textValue(object.updatedAt),
    rank,
    isOfficial: Boolean(object.isOfficial)
  };
}

function isAllowed(url: string, allowedDomains: string[]): boolean {
  if (allowedDomains.length === 0) {
    return true;
  }
  const host = safeHost(url);
  if (!host) {
    return false;
  }
  return allowedDomains.some((domain) => host === domain || host.endsWith(`.${domain}`));
}

function isBlocked(url: string, blockedDomains: string[]): boolean {
  const host = safeHost(url);
  if (!host) {
    return false;
  }
  return blockedDomains.some((domain) => host === domain || host.endsWith(`.${domain}`));
}

function safeHost(url: string): string | undefined {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return undefined;
  }
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && (error.name === "AbortError" || /aborted|abort/i.test(error.message));
}

function textValue(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function normalizeUrl(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    return "";
  }
  try {
    return new URL(trimmed).toString();
  } catch {
    return "";
  }
}

function matchTitle(html: string): string | undefined {
  const match = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  return match?.[1]?.replace(/\s+/g, " ").trim();
}

function extractReadableText(html: string): string {
  const withoutScripts = html.replace(/<script[\s\S]*?<\/script>/gi, " ").replace(/<style[\s\S]*?<\/style>/gi, " ");
  const text = withoutScripts
    .replace(/<\/(p|div|br|li|h\d|section|article|tr|td)>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, "\"")
    .replace(/&#39;/gi, "'")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]{2,}/g, " ");
  return text.trim().slice(0, 12000);
}
