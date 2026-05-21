export function parseSearxngHtmlResults(html: string): unknown[] {
  const items: Array<Record<string, string>> = [];
  const resultPattern = /<article[^>]*class=["'][^"']*\bresult\b[^"']*["'][^>]*>([\s\S]*?)<\/article>/gi;
  let match: RegExpExecArray | null;
  while ((match = resultPattern.exec(html))) {
    const block = match[1] ?? "";
    const linkMatch = block.match(/<a[^>]+href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/i);
    if (!linkMatch) {
      continue;
    }
    const url = decodeHtml(linkMatch[1] ?? "");
    const title = stripHtml(linkMatch[2] ?? "");
    const snippetMatch = block.match(/<p[^>]*class=["'][^"']*\bcontent\b[^"']*["'][^>]*>([\s\S]*?)<\/p>/i)
      ?? block.match(/<p[^>]*>([\s\S]*?)<\/p>/i);
    const snippet = snippetMatch ? stripHtml(snippetMatch[1] ?? "") : "";
    if (url && title) {
      items.push({ title, url, snippet });
    }
  }
  return items;
}

export function parseDuckDuckGoHtmlResults(html: string): unknown[] {
  const items: Array<Record<string, string>> = [];
  const resultPattern = /<div[^>]*class=["'][^"']*\bresult\b[^"']*["'][^>]*>([\s\S]*?)(?=<div[^>]*class=["'][^"']*\bresult\b|<\/body>|$)/gi;
  let match: RegExpExecArray | null;
  while ((match = resultPattern.exec(html))) {
    const block = match[1] ?? "";
    const linkMatch = block.match(/<a[^>]+class=["'][^"']*\bresult__a\b[^"']*["'][^>]+href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/i)
      ?? block.match(/<a[^>]+href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/i);
    if (!linkMatch) {
      continue;
    }
    const url = normalizeDuckDuckGoUrl(decodeHtml(linkMatch[1] ?? ""));
    const title = stripHtml(linkMatch[2] ?? "");
    const snippetMatch = block.match(/<a[^>]*class=["'][^"']*\bresult__snippet\b[^"']*["'][^>]*>([\s\S]*?)<\/a>/i)
      ?? block.match(/<div[^>]*class=["'][^"']*\bresult__snippet\b[^"']*["'][^>]*>([\s\S]*?)<\/div>/i);
    const snippet = snippetMatch ? stripHtml(snippetMatch[1] ?? "") : "";
    if (url && title) {
      items.push({ title, url, snippet });
    }
  }
  return items;
}

export function parseBingHtmlResults(html: string): unknown[] {
  const items: Array<Record<string, string>> = [];
  const resultPattern = /<li[^>]*class=["'][^"']*\bb_algo\b[^"']*["'][^>]*>([\s\S]*?)<\/li>/gi;
  let match: RegExpExecArray | null;
  while ((match = resultPattern.exec(html))) {
    const block = match[1] ?? "";
    const linkMatch = block.match(/<h2[^>]*>\s*<a[^>]+href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>\s*<\/h2>/i)
      ?? block.match(/<a[^>]+href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/i);
    if (!linkMatch) {
      continue;
    }
    const url = decodeHtml(linkMatch[1] ?? "");
    const title = stripHtml(linkMatch[2] ?? "");
    const snippetMatch = block.match(/<p[^>]*>([\s\S]*?)<\/p>/i);
    const snippet = snippetMatch ? stripHtml(snippetMatch[1] ?? "") : "";
    if (url && title) {
      items.push({ title, url, snippet });
    }
  }
  return items;
}

export function parseBaiduHtmlResults(html: string): unknown[] {
  const items: Array<Record<string, string>> = [];
  const resultPattern = /<div[^>]*class=["'][^"']*(?:\bresult\b|\bc-container\b)[^"']*["'][^>]*>([\s\S]*?)(?=<div[^>]*class=["'][^"']*(?:\bresult\b|\bc-container\b)|<\/body>|$)/gi;
  let match: RegExpExecArray | null;
  while ((match = resultPattern.exec(html))) {
    const block = match[0] ?? match[1] ?? "";
    const linkMatch = block.match(/<h3[^>]*>[\s\S]*?<a[^>]+href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>[\s\S]*?<\/h3>/i)
      ?? block.match(/<a[^>]+href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/i);
    if (!linkMatch) {
      continue;
    }
    const muMatch = block.match(/\s(?:mu|data-mu)=["']([^"']+)["']/i);
    const url = decodeHtml(muMatch?.[1] ?? linkMatch[1] ?? "");
    const title = stripHtml(linkMatch[2] ?? "");
    const snippetMatch = block.match(/<span[^>]*class=["'][^"']*\bc-abstract\b[^"']*["'][^>]*>([\s\S]*?)<\/span>/i)
      ?? block.match(/<div[^>]*class=["'][^"']*\bc-abstract\b[^"']*["'][^>]*>([\s\S]*?)<\/div>/i)
      ?? block.match(/<div[^>]*class=["'][^"']*\bcontent-right\b[^"']*["'][^>]*>([\s\S]*?)<\/div>/i);
    const snippet = snippetMatch ? stripHtml(snippetMatch[1] ?? "") : "";
    if (url && title) {
      items.push({ title, url, snippet });
    }
  }
  return items;
}

export function parseSogouHtmlResults(html: string): unknown[] {
  const items: Array<Record<string, string>> = [];
  const resultPattern = /<div[^>]*class=["'][^"']*(?:\bvrwrap\b|\bresults?\b)[^"']*["'][^>]*>([\s\S]*?)(?=<div[^>]*class=["'][^"']*(?:\bvrwrap\b|\bresults?\b)|<\/body>|$)/gi;
  let match: RegExpExecArray | null;
  while ((match = resultPattern.exec(html))) {
    const block = match[1] ?? "";
    const linkMatch = block.match(/<h3[^>]*>[\s\S]*?<a[^>]+href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>[\s\S]*?<\/h3>/i)
      ?? block.match(/<a[^>]+href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/i);
    if (!linkMatch) {
      continue;
    }
    const url = normalizeMaybeRelativeUrl(decodeHtml(linkMatch[1] ?? ""), "https://www.sogou.com");
    const title = stripHtml(linkMatch[2] ?? "");
    const snippetMatch = block.match(/<p[^>]*class=["'][^"']*(?:\bstr_info\b|\btxt-info\b)[^"']*["'][^>]*>([\s\S]*?)<\/p>/i)
      ?? block.match(/<p[^>]*>([\s\S]*?)<\/p>/i);
    const snippet = snippetMatch ? stripHtml(snippetMatch[1] ?? "") : "";
    if (url && title) {
      items.push({ title, url, snippet });
    }
  }
  return items;
}

function normalizeDuckDuckGoUrl(value: string): string {
  try {
    const url = new URL(value, "https://duckduckgo.com");
    const uddg = url.searchParams.get("uddg");
    return uddg ? decodeURIComponent(uddg) : url.toString();
  } catch {
    return value;
  }
}

function normalizeMaybeRelativeUrl(value: string, baseUrl: string): string {
  try {
    return new URL(value, baseUrl).toString();
  } catch {
    return value;
  }
}

function stripHtml(value: string): string {
  return decodeHtml(value.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim());
}

function decodeHtml(value: string): string {
  return value
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, "\"")
    .replace(/&#39;/gi, "'")
    .replace(/&#x27;/gi, "'")
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCodePoint(Number.parseInt(code, 16)))
    .trim();
}
