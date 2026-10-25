import test from "node:test";
import assert from "node:assert/strict";
import {
  parseSearchResults,
  webSearch,
} from "../src/integrations/web-search.js";

const row = (href: string, title: string, snippet = "") =>
  `<div class="result"><h2><a class="result__a" href="${href}">${title}</a></h2><a class="result__snippet">${snippet}</a></div>`;

test("search returns readable original URLs and snippets, excluding ads, unsafe links and duplicate destinations", () => {
  const html = [
    '<div class="result result--ad"><a class="result__a" href="https://ads.example/">Advertisement</a></div>',
    row(
      "//duckduckgo.com/l/?uddg=https%3A%2F%2Farxiv.org%2Fabs%2Fmath%2F0410159&amp;rut=tracking",
      "On Hoeffding&#x27;s inequalities",
      "A &amp; B\n  prove the result.",
    ),
    row("https://arxiv.org/abs/math/0410159#abstract", "Duplicate"),
    row("javascript:alert(1)", "Unsafe"),
    row("https://user:secret@example.org/", "Credentials"),
    row(
      "https://projecteuclid.org/paper",
      "Original &amp; proof",
      "Independent result",
    ),
    row("https://example.org/third", "Third"),
  ].join("");
  assert.deepEqual(parseSearchResults(html, 2), [
    {
      title: "On Hoeffding's inequalities",
      url: "https://arxiv.org/abs/math/0410159",
      snippet: "A & B prove the result.",
    },
    {
      title: "Original & proof",
      url: "https://projecteuclid.org/paper",
      snippet: "Independent result",
    },
  ]);
});

test("a genuine empty search differs from a challenge or changed provider markup", () => {
  assert.deepEqual(
    parseSearchResults(
      '<div class="no-results">No results found for this query.</div>',
      5,
    ),
    [],
  );
  assert.throws(
    () =>
      parseSearchResults(
        '<form action="//duckduckgo.com/anomaly.js"><p>Unfortunately, bots use DuckDuckGo too.</p></form>',
        5,
      ),
    /CAPTCHA or bot challenge/,
  );
  assert.throws(
    () =>
      parseSearchResults("<html><body>Service unavailable</body></html>", 5),
    /no recognizable search results/,
  );
});

test("blocked responses, wrong media types and oversized bodies fail instead of producing fabricated empty results", async () => {
  for (const status of [202, 403, 429, 503]) {
    await assert.rejects(
      webSearch(
        "a scientific query",
        AbortSignal.timeout(1000),
        5,
        async () => new Response("Blocked", { status }),
      ),
      new RegExp(`HTTP ${status}`),
    );
  }
  await assert.rejects(
    webSearch(
      "a scientific query",
      AbortSignal.timeout(1000),
      5,
      async () =>
        new Response("{}", { headers: { "content-type": "application/json" } }),
    ),
    /unexpected content type/,
  );
  await assert.rejects(
    webSearch(
      "a scientific query",
      AbortSignal.timeout(1000),
      5,
      async () =>
        new Response("x".repeat(1024 * 1024 + 1), {
          headers: { "content-type": "text/html" },
        }),
    ),
    /exceeds 1 MiB/,
  );
});

test("query boundaries and cancellation are enforced before a provider request", async () => {
  const unexpectedRequest = async (): Promise<Response> => {
    throw new Error("Unexpected provider request");
  };
  for (const query of ["", "   ", "x".repeat(501)])
    await assert.rejects(
      webSearch(query, AbortSignal.timeout(1000), 5, unexpectedRequest),
      /1–500/,
    );
  for (const limit of [0, 11, 1.5])
    await assert.rejects(
      webSearch("paper", AbortSignal.timeout(1000), limit, unexpectedRequest),
      /integer from 1 to 10/,
    );
  await assert.rejects(
    webSearch(
      "paper",
      AbortSignal.abort(new Error("Search cancelled by user")),
      5,
      unexpectedRequest,
    ),
    /Search cancelled by user/,
  );
});
