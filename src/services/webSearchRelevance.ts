export type SearchSourceHint = "general" | "docs" | "news" | "github";

export interface SearchResultLike {
  title: string;
  url: string;
  snippet: string;
  source?: string;
  rank: number;
  isOfficial?: boolean;
}

interface SearchTerms {
  core: string[];
  support: string[];
  normalizedQuery: string;
}

interface ScoredResult<T extends SearchResultLike> {
  item: T;
  score: number;
  relevance: number;
  matchedCore: number;
}

const QUERY_SUPPORT_TERMS = [
  "官方",
  "文档",
  "配置",
  "安装",
  "部署",
  "教程",
  "示例",
  "用法",
  "使用",
  "参数",
  "接口",
  "说明",
  "最新",
  "版本",
  "更新",
  "发布",
  "错误",
  "报错",
  "修复",
  "api",
  "sdk",
  "docs",
  "documentation",
  "official",
  "reference",
  "readme",
  "release",
  "changelog",
  "latest"
];

const ENGLISH_STOP_WORDS = new Set([
  "and",
  "or",
  "the",
  "a",
  "an",
  "to",
  "for",
  "with",
  "of",
  "in",
  "on",
  "by",
  "is",
  "are",
  "official",
  "docs",
  "documentation",
  "reference",
  "readme",
  "release",
  "changelog",
  "latest",
  "news",
  "site",
  "github"
]);

const CHINESE_FILLER_PATTERN = /[的了和与及或在从到把被给是这那一个如何怎么关于相关最新官方文档配置安装部署教程示例用法使用参数接口说明版本更新发布错误报错修复]+/g;

const OFFICIAL_HOST_HINTS = [
  "docs.github.com",
  "github.com",
  "developer.mozilla.org",
  "nodejs.org",
  "npmjs.com",
  "react.dev",
  "nextjs.org",
  "vuejs.org",
  "vite.dev",
  "typescriptlang.org",
  "code.visualstudio.com",
  "modelcontextprotocol.io",
  "platform.openai.com",
  "docs.anthropic.com",
  "api-docs.deepseek.com",
  "help.aliyun.com",
  "cloud.tencent.com",
  "volcengine.com",
  "cloud.baidu.com",
  "bigmodel.cn",
  "xfyun.cn"
];

const LOW_QUALITY_DOC_HOST_HINTS = [
  "zhihu.com",
  "bbs.",
  "3dmgame.com",
  "tieba.baidu.com",
  "weibo.com",
  "douban.com",
  "baijiahao.baidu.com",
  "toutiao.com",
  "sohu.com",
  "163.com",
  "qq.com"
];

export function rankAndFilterSearchResults<T extends SearchResultLike>(
  results: T[],
  query: string,
  sourceHint: SearchSourceHint
): T[] {
  const terms = extractSearchTerms(query);
  const scored = results
    .map((item) => scoreResult(item, terms, sourceHint))
    .filter((item) => shouldKeepResult(item, terms, sourceHint));

  return scored
    .sort((left, right) => right.score - left.score || left.item.rank - right.item.rank)
    .map(({ item }, index) => ({ ...item, rank: index + 1 }));
}

export function extractSearchTerms(query: string): SearchTerms {
  const normalizedQuery = normalizeText(query);
  const english = unique(normalizedQuery.match(/[a-z0-9][a-z0-9._-]{1,}/g) ?? [])
    .filter((term) => !ENGLISH_STOP_WORDS.has(term));
  const support = QUERY_SUPPORT_TERMS.filter((term) => normalizedQuery.includes(term));
  const chineseCore = unique((normalizedQuery.match(/[\u4e00-\u9fff]{2,}/g) ?? [])
    .flatMap((chunk) => chunk.replace(CHINESE_FILLER_PATTERN, " ").split(/\s+/))
    .map((term) => term.trim())
    .filter((term) => term.length >= 2));

  return {
    core: unique([...english, ...chineseCore]),
    support: unique(support),
    normalizedQuery
  };
}

function scoreResult<T extends SearchResultLike>(item: T, terms: SearchTerms, sourceHint: SearchSourceHint): ScoredResult<T> {
  const title = normalizeText(item.title);
  const snippet = normalizeText(item.snippet);
  const urlText = normalizeText(item.url);
  const host = safeHost(item.url) ?? item.source ?? "";
  const combined = `${title} ${snippet} ${urlText}`;

  let relevance = 0;
  let matchedCore = 0;

  for (const term of terms.core) {
    const titleMatch = title.includes(term);
    const urlMatch = urlText.includes(term);
    const snippetMatch = snippet.includes(term);
    if (titleMatch || urlMatch || snippetMatch) {
      matchedCore += 1;
      relevance += titleMatch ? 42 : urlMatch ? 34 : 22;
    }
  }

  for (const term of terms.support) {
    if (title.includes(term)) {
      relevance += 12;
    } else if (urlText.includes(term)) {
      relevance += 10;
    } else if (snippet.includes(term)) {
      relevance += 7;
    }
  }

  if (terms.normalizedQuery.length >= 6 && combined.includes(terms.normalizedQuery)) {
    relevance += 35;
  }
  if (terms.core.length > 0 && matchedCore === terms.core.length) {
    relevance += 28;
  }

  let quality = Math.max(0, 35 - item.rank);
  if (isOfficialHost(host) || item.isOfficial) {
    quality += sourceHint === "docs" || sourceHint === "github" ? 42 : 24;
  }
  if (sourceHint === "docs") {
    if (/docs|documentation|developer|reference|api|readme|manual|guide|手册|文档/.test(combined)) {
      quality += 24;
    }
    if (isLowQualityDocHost(host)) {
      quality -= 60;
    }
  }
  if (sourceHint === "github") {
    if (host === "github.com" || host.endsWith(".github.com")) {
      quality += 46;
    }
    if (/issues|pull|releases|discussion|readme|wiki/.test(combined)) {
      quality += 16;
    }
  }
  if (sourceHint === "news") {
    if (/release|changelog|latest|announcement|发布|更新|公告/.test(combined)) {
      quality += 24;
    }
  }
  if (terms.core.length > 0 && matchedCore === 0) {
    quality -= 160;
  }

  return {
    item,
    score: relevance + quality,
    relevance,
    matchedCore
  };
}

function shouldKeepResult<T extends SearchResultLike>(scored: ScoredResult<T>, terms: SearchTerms, sourceHint: SearchSourceHint): boolean {
  if (terms.core.length === 0) {
    return scored.score > 0;
  }
  if (scored.matchedCore === 0) {
    return false;
  }
  if (sourceHint === "docs" || sourceHint === "github") {
    return scored.relevance >= 34 || Boolean(scored.item.isOfficial);
  }
  return scored.relevance >= 24;
}

function isOfficialHost(host: string): boolean {
  if (!host) {
    return false;
  }
  return OFFICIAL_HOST_HINTS.some((hint) => host === hint || host.endsWith(`.${hint}`));
}

function isLowQualityDocHost(host: string): boolean {
  return LOW_QUALITY_DOC_HOST_HINTS.some((hint) => host === hint || host.includes(hint));
}

function normalizeText(value: string): string {
  return value
    .toLowerCase()
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/[^\p{L}\p{N}._-]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function safeHost(url: string): string | undefined {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return undefined;
  }
}

function unique(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}
