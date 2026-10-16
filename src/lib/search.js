/**
 * Pre-search: we do the retrieval, the model does the reading.
 *
 * A local model can't reach the web, and grounded search on the hosted
 * providers is either paid or rate-limited. So instead of asking the model to
 * search, we run the queries ourselves against Ollama's web search API and hand
 * the results over in the prompt. The model's job shrinks to summarising and
 * classifying what it's given, which is the part it's actually good at.
 *
 * Free with an Ollama account: https://ollama.com/settings/keys
 */

const ENDPOINT = "https://ollama.com/api/web_search";

/**
 * What to look for. Deliberately source-shaped rather than topic-shaped — the
 * wire's editorial rule is primary sources, so the queries name them.
 *
 * Grouped by the section each is meant to feed, because the first version of
 * this list was all changelogs: every result came back `product`, and the
 * Business and Innovations tabs stayed frozen however often the check ran.
 * Retrieval has to cover the taxonomy, or the taxonomy is decorative.
 *
 * If you add a section to SECTIONS, add queries for it here too.
 */

/** product — what shipped and is usable today. */
const PRODUCT_QUERIES = [
  "Anthropic API changelog release notes",
  "OpenAI API changelog deprecations",
  "Google Gemini API changelog",
  "Model Context Protocol specification changelog",
  // Jev ships as versioned aliases (jev-latest → jev-1.13.0), so a bump in the
  // docs is the changelog. The gateway query is an early-warning net: Jev
  // reached Vercel, Cloudflare, OpenRouter and Portkey within weeks of launch,
  // and each announces independently of TypeSafe.
  "TypeSafe AI Jev docs changelog",
  "Jev model release jev-latest version",
  "Vercel AI Gateway Cloudflare Workers AI new model",
];

/** business — funding, acquisitions, regulation, market moves. */
const BUSINESS_QUERIES = [
  "AI startup funding round acquisition this week",
  "AI company acquisition announcement",
  "EU AI Act enforcement AI regulation developers",
  "AI lab earnings compute deal datacenter investment",
];

/** innovation — research and new technique, shipped or not. */
const INNOVATION_QUERIES = [
  "arXiv LLM agent context management paper",
  "arXiv retrieval augmented generation new method",
  "new LLM benchmark evaluation results agents",
  "AI research breakthrough paper architecture efficiency",
];

export const QUERIES = [...PRODUCT_QUERIES, ...BUSINESS_QUERIES, ...INNOVATION_QUERIES];

/** Snippets run long; this keeps the assembled prompt inside a sane context. */
const MAX_CHARS_PER_RESULT = 600;
const MAX_RESULTS_PER_QUERY = 4;

/**
 * This list used to fire as one burst via Promise.all, which is 15 simultaneous
 * requests at a free-tier API — reliably a 429, and since every query failed the
 * same way the whole check died. Two at a time with backoff is slower by a few
 * seconds and survives.
 */
/**
 * Serial, with a deliberate gap. Measured against the real API: two at a time
 * with 500ms backoff still tripped the limiter, and a single request a minute
 * later succeeded — so the window is short and strict rather than a quota.
 * Pacing beats concurrency here; 15 queries at 1.2s is ~18s, which is nothing
 * next to the model's own minute.
 */
const CONCURRENCY = 1;
const MIN_INTERVAL_MS = 1200;
const MAX_RETRIES = 3;
/** No request hangs forever: Node's fetch has no default timeout. */
const REQUEST_TIMEOUT_MS = 15000;
/**
 * A wall-clock ceiling on the whole retrieval phase. Retry budgets multiply:
 * 3 retries honouring a 30s Retry-After across 15 queries is twelve minutes of
 * silence, which is indistinguishable from a hang. Past this deadline we stop
 * retrying and work with whatever already came back.
 */
const SEARCH_BUDGET_MS = 90000;
/** Cap on a server-sent Retry-After, so one long hint can't dominate the run. */
const MAX_RETRY_AFTER_MS = 8000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Retries only what's worth retrying: 429 and 5xx. A 401 is a bad key and will
 * be just as bad in two seconds.
 */
async function withRetry(fn, { retries = MAX_RETRIES, baseMs = 500, deadline = Infinity } = {}) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (!err.retryable || attempt >= retries || Date.now() >= deadline) throw err;
      // Honour Retry-After when the server sends one; otherwise exponential
      // backoff with jitter, so retries don't resynchronise into a new burst.
      // A rate-limit window is measured in seconds, so 429 starts further out
      // than a transient 5xx — retrying a limiter too soon just spends budget.
      const base = err.rateLimited ? baseMs * 8 : baseMs;
      const backoff = Math.min(15000, base * 2 ** attempt) + Math.random() * (base / 2);
      await sleep(err.retryAfterMs ?? backoff);
    }
  }
}

/**
 * Promise.allSettled's shape, but at most `limit` in flight. Workers pull from
 * a shared cursor, so a slow query doesn't hold up the queue behind it.
 */
async function pool(items, limit, worker) {
  const out = new Array(items.length);
  let cursor = 0;
  const run = async () => {
    while (cursor < items.length) {
      const i = cursor++;
      try {
        out[i] = { status: "fulfilled", value: await worker(items[i]) };
      } catch (reason) {
        out[i] = { status: "rejected", reason };
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, run));
  return out;
}

/**
 * @param {object} opts
 * @param {Record<string,string>} opts.env  must carry OLLAMA_API_KEY
 * @param {string[]} [opts.queries]
 * @param {Function} [opts.fetchImpl]  injectable for tests
 * @returns {Promise<Array<{title: string, url: string, content: string, query: string}>>}
 */
export async function webSearch({
  env,
  queries = QUERIES,
  fetchImpl = fetch,
  concurrency = CONCURRENCY,
  retries = MAX_RETRIES,
  baseMs = 500,
  budgetMs = SEARCH_BUDGET_MS,
  timeoutMs = REQUEST_TIMEOUT_MS,
  maxRetryAfterMs = MAX_RETRY_AFTER_MS,
  minIntervalMs = MIN_INTERVAL_MS,
  onProgress = null,
  cache = null,
}) {
  const key = env.OLLAMA_API_KEY;
  if (!key) {
    throw new Error(
      "OLLAMA_API_KEY is not set. Create a free key at https://ollama.com/settings/keys — " +
        "it's what lets the check reach the web without a paid model."
    );
  }

  const deadline = Date.now() + budgetMs;
  let done = 0;
  let lastRequestAt = 0;
  let served = 0;

  /** Keeps a minimum gap between requests, whatever the concurrency. */
  const paced = async (fn) => {
    const wait = lastRequestAt + minIntervalMs - Date.now();
    if (wait > 0) await sleep(wait);
    lastRequestAt = Date.now();
    return fn();
  };

  const settled = await pool(queries, concurrency, async (query) => {
    try {
      // A cache hit costs no budget. Re-running a check while debugging the
      // model should not re-spend retrieval — that is what exhausted the
      // limiter in the first place.
      const hit = cache?.get?.(query);
      if (hit) {
        served++;
        return hit;
      }
      return await withRetry(
        async () => {
          let res;
          try {
            res = await paced(() =>
              fetchImpl(ENDPOINT, {
                method: "POST",
                headers: {
                  "content-type": "application/json",
                  authorization: `Bearer ${key}`,
                },
                body: JSON.stringify({ query, max_results: MAX_RESULTS_PER_QUERY }),
                signal: AbortSignal.timeout(timeoutMs),
              })
            );
          } catch (err) {
            // Node's bare "fetch failed" says nothing about which host was
            // unreachable, which is the only thing you need to know here.
            const e = new Error(`could not reach ${ENDPOINT} — ${err.message}`);
            e.retryable = true;
            throw e;
          }
          if (!res.ok) {
            const detail =
              res.status === 401
                ? " (check OLLAMA_API_KEY)"
                : res.status === 429
                  ? " (rate limited — retried and still refused)"
                  : "";
            const e = new Error(`"${query}" → HTTP ${res.status}${detail}`);
            e.retryable = res.status === 429 || res.status >= 500;
            e.rateLimited = res.status === 429;
            // Ollama sends Retry-After in seconds; respect it over our own backoff.
            const after = Number(res.headers?.get?.("retry-after"));
            if (Number.isFinite(after) && after > 0)
              e.retryAfterMs = Math.min(after * 1000, maxRetryAfterMs);
            throw e;
          }
          const body = await res.json();
          const mapped = (body.results || []).map((r) => ({
            title: r.title || "",
            url: r.url || "",
            content: (r.content || "").slice(0, MAX_CHARS_PER_RESULT),
            query,
          }));
          cache?.set?.(query, mapped);
          return mapped;
        },
        { retries, baseMs, deadline }
      );
    } finally {
      // Retrieval is the slowest stage and used to print nothing at all, which
      // made a long run and a hang look identical.
      onProgress?.(++done, queries.length, query, served);
    }
  });

  // One dead query shouldn't sink the whole check — take what came back.
  const failures = settled.filter((s) => s.status === "rejected");
  if (failures.length === settled.length) {
    throw new Error(`every search failed: ${failures[0].reason?.message || "unknown"}`);
  }

  const seen = new Set();
  return settled
    .filter((s) => s.status === "fulfilled")
    .flatMap((s) => s.value)
    .filter((r) => r.url && !seen.has(r.url) && seen.add(r.url));
}

/** Rendered into the prompt. Numbered so the model can't invent a source. */
export function formatResults(results) {
  return results
    .map((r, n) => `[${n + 1}] ${r.title}\n    ${r.url}\n    ${r.content.replace(/\s+/g, " ")}`)
    .join("\n\n");
}
