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

/**
 * Queries name EVENTS, not sources — and that distinction is the whole trick.
 *
 * The first version asked for "Anthropic API changelog release notes", which
 * faithfully returned the changelog *page*. A page that exists continuously has
 * no publication date, so a model correctly told "only report things newer than
 * the wire's latest entry" can extract nothing defensible from it. A measured
 * run returned 60 results of which ~37 were evergreen landing pages, docs,
 * FAQs or papers from 2021-2025: they filled two thirds of the prompt and could
 * not, even in principle, produce an entry.
 *
 * So the queries are built against the current month. "announced October 2026"
 * finds the announcement; "changelog" finds the page the announcement is
 * eventually listed on. The year alone does most of the work on arXiv, where
 * the old list kept surfacing Self-RAG (2023) and MemoRAG (2024).
 *
 * Built at call time rather than module load, so a long-lived Worker doesn't
 * keep asking about last month after midnight on the 1st.
 */
const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

export function buildQueries(now = new Date()) {
  const month = MONTHS[now.getMonth()];
  const year = now.getFullYear();
  const when = `${month} ${year}`;

  /** product — what shipped and is usable today. */
  const product = [
    `Anthropic Claude new model API announcement ${when}`,
    `OpenAI new model API announcement ${when}`,
    `Google Gemini model release announcement ${when}`,
    `Model Context Protocol specification revision ${when}`,
    // Jev ships as versioned aliases (jev-latest → jev-1.13.0), so the version
    // string is the story and often predates any post. The gateway query is an
    // early-warning net: Jev reached Vercel, Cloudflare, OpenRouter and Portkey
    // within weeks of launch, each announcing independently of TypeSafe.
    `TypeSafe Jev model release version ${when}`,
    `"jev-latest" new version released`,
    `new model added Vercel AI Gateway Cloudflare Workers AI ${when}`,
  ];

  /** business — funding, acquisitions, regulation, market moves. */
  const business = [
    `AI startup funding round announced ${when}`,
    `AI company acquires acquisition announced ${when}`,
    `EU AI Act enforcement ruling guidance ${when}`,
    `AI compute datacenter deal announced ${when}`,
  ];

  /**
   * social — the labs' own X posts, which are often hours ahead of the blog.
   * Only accounts on OFFICIAL_X_ACCOUNTS survive the gate in check.js, so
   * these queries can be broad without letting commentary through.
   *
   * X blocks most crawlers, so expect these to be thinner than the others.
   * If they return nothing useful for a week, cut them — three dead queries
   * is 3 of your 15 hourly search requests spent on nothing.
   */
  const social = [
    `x.com AnthropicAI OR OpenAI post model announcement ${when}`,
    `x.com GoogleDeepMind OR MistralAI OR deepseek_ai release post ${when}`,
    `"x.com" AI lab official account announcement thread ${when}`,
  ];

  /** innovation — research and new technique, shipped or not. */
  const innovation = [
    `arXiv ${year} LLM agent context management paper`,
    `arXiv ${year} retrieval augmented generation new method`,
    `new LLM agent benchmark released ${when}`,
    `LLM inference efficiency architecture paper ${when}`,
  ];

  return [...product, ...business, ...social, ...innovation];
}

/** Convenience snapshot for callers that just want the current list. */
export const QUERIES = buildQueries();

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
  queries = buildQueries(),
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
  /**
   * Set when the server says the budget is spent for a while. The remaining
   * queries would each burn another request to be told the same thing, so they
   * fail without asking.
   */
  let halted = null;

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
      if (halted) throw halted;
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
            const after = Number(res.headers?.get?.("retry-after"));
            const waitMs = Number.isFinite(after) && after > 0 ? after * 1000 : 0;
            const tooLong = waitMs > maxRetryAfterMs;
            const detail =
              res.status === 401
                ? " (check OLLAMA_API_KEY)"
                : res.status === 429
                  ? tooLong
                    ? " (rate limited)"
                    : " (rate limited — retried and still refused)"
                  : "";
            // The status alone sent us chasing concurrency for an hour while
            // the server was presumably saying why in the body. Never discard
            // it again.
            let said = "";
            try {
              said = (await res.text()).trim().slice(0, 300);
            } catch {
              // A body we can't read is not worth failing differently over.
            }
            // A limiter that wants longer than we're prepared to wait is not a
            // transient failure, it's a closed door — Ollama's free tier answers
            // an exhausted hourly budget with `retry-after: 2402`. Retrying that
            // three times spends three more requests against the same budget and
            // tells you nothing. Say when it reopens and stop.
            const resumeAt = tooLong
              ? `\n    resets at ${new Date(Date.now() + waitMs).toLocaleTimeString()}` +
                ` (${Math.round(waitMs / 60000)} min) — not retrying`
              : "";

            const e = new Error(
              `"${query}" → HTTP ${res.status}${detail}` +
                `${said ? `\n    server said: ${said}` : ""}${resumeAt}`
            );
            e.retryable = (res.status === 429 || res.status >= 500) && !tooLong;
            e.rateLimited = res.status === 429;
            e.resetInMs = tooLong ? waitMs : 0;
            if (waitMs && !tooLong) e.retryAfterMs = waitMs;
            if (tooLong) halted = e;
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
  const byQuery = settled
    .filter((s) => s.status === "fulfilled")
    .map((s) => s.value.filter((r) => r.url && !seen.has(r.url) && seen.add(r.url)));

  // Interleave, one result per query per pass, instead of concatenating the
  // query groups. Concatenated, every product result came first — and since the
  // model is capped on how many entries it may return, it spent the whole
  // budget on product and never reached the business or innovation results.
  // Seven entries, all `product`, with an acquisition and four papers sitting
  // unread further down the prompt. Round-robin gives each section a turn.
  const out = [];
  for (let i = 0; out.length < seen.size; i++) {
    let moved = false;
    for (const group of byQuery) {
      if (group[i]) {
        out.push(group[i]);
        moved = true;
      }
    }
    if (!moved) break;
  }
  return out;
}

/** Rendered into the prompt. Numbered so the model can't invent a source. */
export function formatResults(results) {
  return results
    .map((r, n) => `[${n + 1}] ${r.title}\n    ${r.url}\n    ${r.content.replace(/\s+/g, " ")}`)
    .join("\n\n");
}
