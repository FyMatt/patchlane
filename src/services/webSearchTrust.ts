import type { WebSearchSourceHint } from "./webSearchService";

export type WebSearchTrustLabel = "official" | "docs" | "github" | "news" | "community" | "unknown";

export interface WebSearchTrustInput {
  title: string;
  url: string;
  snippet?: string;
  source?: string;
  rank?: number;
  publishedAt?: string;
  updatedAt?: string;
  isOfficial?: boolean;
}

export interface WebSearchTrustMetadata {
  trustLabel: WebSearchTrustLabel;
  citation: string;
  isOfficial: boolean;
}

const OFFICIAL_HOSTS = new Set([
  "code.visualstudio.com",
  "developer.mozilla.org",
  "docs.python.org",
  "go.dev",
  "nodejs.org",
  "react.dev",
  "rust-lang.org",
  "typescriptlang.org",
  "vite.dev",
  "vuejs.org"
]);

const COMMUNITY_HOST_PATTERN = /(^|\.)((stackoverflow|stackexchange|reddit|zhihu|csdn|juejin|cnblogs|medium|dev\.to|segmentfault)\.com|v2ex\.com)$/i;

export function annotateWebSearchResult<T extends WebSearchTrustInput>(
  result: T,
  sourceHint: WebSearchSourceHint = "general"
): T & WebSearchTrustMetadata {
  const trustLabel = classifyWebSearchTrust(result, sourceHint);
  return {
    ...result,
    trustLabel,
    citation: formatWebSearchCitation(result, trustLabel),
    isOfficial: Boolean(result.isOfficial) || trustLabel === "official"
  };
}

export function classifyWebSearchTrust(result: WebSearchTrustInput, sourceHint: WebSearchSourceHint = "general"): WebSearchTrustLabel {
  const url = parseUrl(result.url);
  const host = (result.source || url?.hostname || "").toLowerCase().replace(/^www\./, "");
  const path = url?.pathname.toLowerCase() ?? "";
  const text = `${result.title} ${result.snippet ?? ""} ${host} ${path}`.toLowerCase();

  if (result.isOfficial || OFFICIAL_HOSTS.has(host)) {
    return "official";
  }
  if (host === "github.com" || host.endsWith(".github.com")) {
    return "github";
  }
  if (sourceHint === "github" && host.includes("github")) {
    return "github";
  }
  if (sourceHint === "news" || /\b(news|release|changelog|announcement|announcing|blog)\b/.test(text)) {
    return "news";
  }
  if (/(\bdocs?\b|documentation|reference|api reference|manual|guide|\/docs?\/|\/reference\/)/.test(text) || host.startsWith("docs.")) {
    return "docs";
  }
  if (COMMUNITY_HOST_PATTERN.test(host)) {
    return "community";
  }
  return "unknown";
}

export function formatWebSearchCitation(result: WebSearchTrustInput, trustLabel = classifyWebSearchTrust(result)): string {
  const host = (result.source || parseUrl(result.url)?.hostname || "unknown").replace(/^www\./, "");
  const rank = typeof result.rank === "number" ? `#${result.rank} ` : "";
  const date = result.updatedAt || result.publishedAt;
  const dateLabel = result.updatedAt ? "Updated" : result.publishedAt ? "Published" : "";
  return [
    `${rank}${trustLabel}`,
    host,
    date ? `${dateLabel}: ${date}` : ""
  ].filter(Boolean).join(" - ");
}

export function webSearchTrustLabel(label: WebSearchTrustLabel | undefined): string {
  switch (label) {
    case "official":
      return "官方";
    case "docs":
      return "文档";
    case "github":
      return "GitHub";
    case "news":
      return "新闻";
    case "community":
      return "社区";
    default:
      return "未知";
  }
}

function parseUrl(value: string): URL | undefined {
  try {
    return new URL(value);
  } catch {
    return undefined;
  }
}
