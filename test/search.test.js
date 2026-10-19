/**
 * Retrieval is the stage that actually broke in production, and it broke in a
 * way nothing caught: 15 queries fired as one burst, the free-tier API answered
 * 429 to all of them, and the check reported "every search failed" — or, before
 * the env fix, silently fell back to memory mode and reported nothing at all.
 *
 * These tests pin the three properties that keep that from recurring: we never
 * burst, we retry what's worth retrying, and one bad query doesn't sink the run.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { webSearch } from "../src/lib/search.js";

const env = { OLLAMA_API_KEY: "test-key" };
const fast = { baseMs: 1, minIntervalMs: 0 }; // no real backoff or pacing in tests

/** A stub whose behaviour per call is scripted by `plan`. */
function stubFetch(plan) {
  const calls = [];
  let inFlight = 0;
  let peak = 0;
  const impl = async (_url, opts) => {
    const query = JSON.parse(opts.body).query;
    calls.push(query);
    inFlight++;
    peak = Math.max(peak, inFlight);
    await new Promise((r) => setTimeout(r, 2));
    inFlight--;
    const step = typeof plan === "function" ? plan(query, calls.length) : plan;
    if (step.throw) throw new Error(step.throw);
    return {
      ok: step.status === undefined || step.status === 200,
      status: step.status ?? 200,
      headers: { get: (h) => (h.toLowerCase() === "retry-after" ? step.retryAfter : undefined) },
      json: async () => ({ results: step.results ?? [] }),
      text: async () => step.body ?? "",
    };
  };
  return { impl, calls, peak: () => peak };
}

const ok = (url) => ({ results: [{ title: "T", url, content: "body" }] });

test("never exceeds the concurrency limit — the bug that caused the 429", async () => {
  const s = stubFetch(() => ok("https://example.com/a"));
  await webSearch({
    env,
    fetchImpl: s.impl,
    queries: ["q1", "q2", "q3", "q4", "q5", "q6", "q7", "q8"],
    concurrency: 2,
    ...fast,
  });
  assert.ok(s.peak() <= 2, `peak in-flight was ${s.peak()}, expected <= 2`);
  assert.equal(s.calls.length, 8, "every query should still run");
});

test("a 429 is retried and can succeed", async () => {
  let n = 0;
  const s = stubFetch(() => (++n === 1 ? { status: 429 } : ok("https://example.com/a")));
  const out = await webSearch({ env, fetchImpl: s.impl, queries: ["q1"], ...fast });
  assert.equal(s.calls.length, 2, "should have retried once");
  assert.equal(out.length, 1);
});

test("a 401 is NOT retried — a bad key stays bad", async () => {
  const s = stubFetch({ status: 401 });
  await assert.rejects(
    () => webSearch({ env, fetchImpl: s.impl, queries: ["q1"], ...fast }),
    /HTTP 401.*OLLAMA_API_KEY/s
  );
  assert.equal(s.calls.length, 1, "401 should fail on the first attempt");
});

test("gives up after the retry budget and says it was rate limited", async () => {
  const s = stubFetch({ status: 429 });
  await assert.rejects(
    () => webSearch({ env, fetchImpl: s.impl, queries: ["q1"], retries: 2, ...fast }),
    /HTTP 429.*rate limited/s
  );
  assert.equal(s.calls.length, 3, "initial attempt plus 2 retries");
});

test("Retry-After is honoured over our own backoff", async () => {
  let n = 0;
  const s = stubFetch(() =>
    ++n === 1 ? { status: 429, retryAfter: "0.05" } : ok("https://example.com/a")
  );
  const started = Date.now();
  await webSearch({ env, fetchImpl: s.impl, queries: ["q1"], baseMs: 10000, minIntervalMs: 0 });
  const waited = Date.now() - started;
  assert.ok(waited < 3000, `waited ${waited}ms; should follow Retry-After, not the 10s backoff`);
});

test("one dead query does not sink the run", async () => {
  const s = stubFetch((q) => (q === "bad" ? { status: 500 } : ok(`https://example.com/${q}`)));
  const out = await webSearch({
    env,
    fetchImpl: s.impl,
    queries: ["good1", "bad", "good2"],
    retries: 0,
    ...fast,
  });
  assert.deepEqual(
    out.map((r) => r.url).sort(),
    ["https://example.com/good1", "https://example.com/good2"]
  );
});

test("results are deduped by url across queries", async () => {
  const s = stubFetch(() => ok("https://example.com/same"));
  const out = await webSearch({ env, fetchImpl: s.impl, queries: ["q1", "q2", "q3"], ...fast });
  assert.equal(out.length, 1, "the same url from three queries is one result");
});

test("stops retrying once the wall-clock budget is spent", async () => {
  // A server that always 429s with a long Retry-After is the shape that turned
  // a check into a twelve-minute silence: retry budget x queries multiplies.
  const s = stubFetch({ status: 429, retryAfter: "30" });
  const started = Date.now();
  await assert.rejects(() =>
    webSearch({
      env,
      fetchImpl: s.impl,
      queries: ["q1", "q2", "q3", "q4"],
      budgetMs: 150,
      maxRetryAfterMs: 50,
      retries: 10,
      minIntervalMs: 0,
    })
  );
  const elapsed = Date.now() - started;
  assert.ok(elapsed < 2000, `took ${elapsed}ms; the budget should have cut it short`);
});

test("a Retry-After within the cap is honoured and retried", async () => {
  let n = 0;
  const s = stubFetch(() =>
    ++n === 1 ? { status: 429, retryAfter: "0.03" } : ok("https://example.com/a")
  );
  const started = Date.now();
  const out = await webSearch({
    env,
    fetchImpl: s.impl,
    queries: ["q1"],
    maxRetryAfterMs: 5000,
    baseMs: 10000,
    minIntervalMs: 0,
  });
  assert.equal(out.length, 1, "a short wait is worth taking");
  assert.equal(s.calls.length, 2);
  assert.ok(Date.now() - started < 2000, "follow Retry-After, not the 10s backoff");
});

test("reports progress so a slow run isn't mistaken for a hang", async () => {
  const s = stubFetch(() => ok("https://example.com/a"));
  const seen = [];
  await webSearch({
    env,
    fetchImpl: s.impl,
    queries: ["q1", "q2", "q3"],
    onProgress: (n, total) => seen.push([n, total]),
    ...fast,
  });
  assert.deepEqual(seen, [
    [1, 3],
    [2, 3],
    [3, 3],
  ]);
});

test("missing key fails before any request is made", async () => {
  const s = stubFetch(() => ok("https://example.com/a"));
  await assert.rejects(
    () => webSearch({ env: {}, fetchImpl: s.impl, queries: ["q1"], ...fast }),
    /OLLAMA_API_KEY is not set/
  );
  assert.equal(s.calls.length, 0);
});

test("paces requests so the limiter isn't tripped", async () => {
  const stamps = [];
  const impl = async () => {
    stamps.push(Date.now());
    return {
      ok: true,
      status: 200,
      headers: { get: () => undefined },
      json: async () => ({ results: [] }),
    };
  };
  await webSearch({ env, fetchImpl: impl, queries: ["q1", "q2", "q3"], minIntervalMs: 40 });
  const gaps = stamps.slice(1).map((t, i) => t - stamps[i]);
  assert.equal(gaps.length, 2);
  for (const g of gaps) assert.ok(g >= 35, `gap was ${g}ms, expected >= ~40`);
});

test("a cache hit costs no request — the fix for burning budget while debugging", async () => {
  const store = new Map();
  const cache = { get: (q) => store.get(q), set: (q, v) => store.set(q, v) };
  const s1 = stubFetch(() => ok("https://example.com/a"));
  const queries = ["q1", "q2"];

  const first = await webSearch({ env, fetchImpl: s1.impl, queries, cache, ...fast });
  assert.equal(s1.calls.length, 2, "cold cache should hit the network");

  const s2 = stubFetch(() => {
    throw new Error("must not be called");
  });
  const second = await webSearch({ env, fetchImpl: s2.impl, queries, cache, ...fast });
  assert.equal(s2.calls.length, 0, "warm cache should make no requests at all");
  assert.deepEqual(second, first, "cached results should match the originals");
});

test("a 429 backs off harder than a 5xx — a limiter window is seconds, not milliseconds", async () => {
  const delays = [];
  const timed = async (status) => {
    let n = 0;
    const impl = async () => {
      n++;
      if (n === 1) {
        return { ok: false, status, headers: { get: () => undefined }, json: async () => ({}) };
      }
      return {
        ok: true,
        status: 200,
        headers: { get: () => undefined },
        json: async () => ({ results: [] }),
      };
    };
    const t = Date.now();
    await webSearch({ env, fetchImpl: impl, queries: ["q"], baseMs: 20, minIntervalMs: 0 });
    delays.push(Date.now() - t);
  };
  await timed(500);
  await timed(429);
  assert.ok(delays[1] > delays[0], `429 waited ${delays[1]}ms, 5xx ${delays[0]}ms — 429 should wait longer`);
});

test("queries name the current month, so they ask for events not landing pages", async () => {
  const { buildQueries } = await import("../src/lib/search.js");
  const oct = buildQueries(new Date("2026-10-16T12:00:00Z"));
  const jan = buildQueries(new Date("2027-01-03T12:00:00Z"));

  assert.ok(
    oct.some((q) => q.includes("October 2026")),
    "October queries should say October 2026"
  );
  assert.ok(
    jan.some((q) => q.includes("January 2027")),
    "the list must roll over — a Worker shouldn't ask about last month forever"
  );
  assert.ok(
    jan.some((q) => q.includes("arXiv 2027")),
    "arXiv queries carry the year, which is what stopped 2023 papers surfacing"
  );
  // The regression this replaces: bare "changelog" queries returned the
  // changelog page, which has no date and so can never yield an entry.
  assert.equal(
    oct.filter((q) => /changelog/i.test(q)).length,
    0,
    "no query should ask for a changelog page by name"
  );
  // Not an exact tally — that breaks every time a beat gains a query. What
  // matters is that each beat is represented and the list isn't runaway.
  assert.ok(oct.length >= 12 && oct.length <= 24, `query count out of range: ${oct.length}`);
  assert.ok(oct.some((q) => /x\.com/i.test(q)), "the social beat needs queries too");
});

test("a Retry-After longer than we'll wait fails fast instead of spending more budget", async () => {
  // The real shape: Ollama's free tier answers an exhausted hourly budget with
  // `retry-after: 2402`. Retrying that three times costs three more requests
  // against the same budget and learns nothing.
  const s = stubFetch({
    status: 429,
    retryAfter: "2402",
    body: '{"error":"you have reached your web search hourly request limit"}',
  });
  const started = Date.now();
  await assert.rejects(
    () => webSearch({ env, fetchImpl: s.impl, queries: ["q1"], retries: 3, ...fast }),
    (err) => {
      assert.match(err.message, /hourly request limit/, "the server's reason must survive");
      assert.match(err.message, /not retrying/);
      assert.match(err.message, /resets at/);
      return true;
    }
  );
  assert.equal(s.calls.length, 1, "must not retry a budget that won't reopen for 40 minutes");
  assert.ok(Date.now() - started < 1000);
});

test("an exhausted budget halts the remaining queries instead of confirming it 14 more times", async () => {
  const s = stubFetch({
    status: 429,
    retryAfter: "2402",
    body: '{"error":"you have reached your web search hourly request limit"}',
  });
  await assert.rejects(() =>
    webSearch({
      env,
      fetchImpl: s.impl,
      queries: ["q1", "q2", "q3", "q4", "q5", "q6", "q7", "q8"],
      retries: 3,
      ...fast,
    })
  );
  assert.equal(
    s.calls.length,
    1,
    `spent ${s.calls.length} requests; once the hour is gone the rest learn nothing`
  );
});

test("results interleave across query groups instead of concatenating them", async () => {
  // Concatenated, all seven product queries' results came first. The model is
  // capped on entries returned, so it spent the budget on product and never
  // reached the business or research results — an acquisition and four papers
  // sat unread at the bottom of the prompt. Every section needs an early turn.
  const impl = async (_url, opts) => {
    const q = JSON.parse(opts.body).query;
    return {
      ok: true,
      status: 200,
      headers: { get: () => undefined },
      json: async () => ({
        results: [0, 1, 2].map((i) => ({ title: `${q}-${i}`, url: `https://x/${q}/${i}`, content: "c" })),
      }),
    };
  };
  const out = await webSearch({
    env,
    fetchImpl: impl,
    queries: ["prod", "biz", "res"],
    minIntervalMs: 0,
  });
  assert.equal(out.length, 9);
  // The first pass must contain one result from each query, in order.
  assert.deepEqual(
    out.slice(0, 3).map((r) => r.query),
    ["prod", "biz", "res"],
    "every group gets a turn before any group gets a second"
  );
  // And no result is lost to the reordering.
  assert.equal(new Set(out.map((r) => r.url)).size, 9);
});
