import { load } from "cheerio/slim";

const SEARCH_ENDPOINT = "https://html.duckduckgo.com/html/";
const MAX_RESPONSE_BYTES = 1024 * 1024;

export interface WebSearchResult {
  title: string;
  url: string;
  snippet: string;
}

export interface WebSearchResponse {
  provider: "DuckDuckGo";
  query: string;
  results: WebSearchResult[];
}

/** Parse static search HTML, never execute it or fetch a result URL. */
export function parseSearchResults(
  html: string,
  limit: number,
): WebSearchResult[] {
  const $ = load(html);
  if (
    $('form[action*="anomaly.js"], .anomaly-modal, #challenge-form').length ||
    /Unfortunately, bots use DuckDuckGo too/i.test($.text())
  ) {
    throw new Error(
      "DuckDuckGo presented a CAPTCHA or bot challenge. Try again later; no search results were retrieved.",
    );
  }
  const results: WebSearchResult[] = [];
  const seen = new Set<string>();
  $(".result").each((_index, element) => {
    if (results.length >= limit) return false;
    const row = $(element);
    if (row.hasClass("result--ad")) return;
    const anchor = row.find(".result__a").first();
    const href = anchor.attr("href");
    const title = anchor.text().replace(/\s+/g, " ").trim().slice(0, 300);
    if (!href || !title) return;
    let target: URL;
    try {
      target = new URL(href, SEARCH_ENDPOINT);
      if (target.hostname === "duckduckgo.com" && target.pathname === "/l/") {
        const destination = target.searchParams.get("uddg");
        if (!destination) return;
        target = new URL(destination);
      }
    } catch {
      return;
    }
    if (
      target.protocol !== "https:" ||
      target.username ||
      target.password ||
      target.href.length > 8192
    )
      return;
    if (target.hostname.endsWith("duckduckgo.com") && target.pathname === "/l/")
      return;
    target.hash = "";
    if (seen.has(target.href)) return;
    seen.add(target.href);
    results.push({
      title,
      url: target.href,
      snippet: row
        .find(".result__snippet")
        .first()
        .text()
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 1600),
    });
  });
  if (!results.length && !$(".no-results").length) {
    throw new Error(
      "DuckDuckGo returned no recognizable search results. Its response may be blocked or its HTML format may have changed.",
    );
  }
  return results;
}

export async function webSearch(
  query: string,
  signal: AbortSignal,
  maxResults = 5,
  request: typeof fetch = fetch,
): Promise<WebSearchResponse> {
  query = query.trim();
  if (!query || query.length > 500)
    throw new Error("Search query must contain 1–500 characters.");
  if (!Number.isInteger(maxResults) || maxResults < 1 || maxResults > 10)
    throw new Error("Search result limit must be an integer from 1 to 10.");
  const deadline = AbortSignal.any([signal, AbortSignal.timeout(20000)]);
  deadline.throwIfAborted();
  const url = new URL(SEARCH_ENDPOINT);
  url.searchParams.set("q", query);
  const response = await request(url, {
    signal: deadline,
    headers: {
      Accept: "text/html",
      "User-Agent": "MethodiyAI/0.1 (research assistant)",
    },
    redirect: "error",
  });
  if (response.status !== 200) {
    await response.body?.cancel();
    throw new Error(
      `DuckDuckGo search returned HTTP ${response.status}${[202, 403, 429].includes(response.status) ? " (blocked, challenged, or rate-limited); try again later" : ""}.`,
    );
  }
  if (
    !/^(?:text\/html|application\/xhtml\+xml)\b/i.test(
      response.headers.get("content-type") ?? "",
    )
  ) {
    await response.body?.cancel();
    throw new Error("DuckDuckGo search returned an unexpected content type.");
  }
  if (!response.body)
    throw new Error("DuckDuckGo search returned an empty response.");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const chunks: string[] = [];
  let bytes = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > MAX_RESPONSE_BYTES) {
        await reader.cancel();
        throw new Error("DuckDuckGo search response exceeds 1 MiB.");
      }
      chunks.push(decoder.decode(value, { stream: true }));
    }
    chunks.push(decoder.decode());
  } finally {
    reader.releaseLock();
  }
  deadline.throwIfAborted();
  return {
    provider: "DuckDuckGo",
    query,
    results: parseSearchResults(chunks.join(""), maxResults),
  };
}
