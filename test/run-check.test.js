/**
 * End-to-end tests for a check, with the search API and the model both stubbed.
 *
 * `fetch` is replaced per-test, so nothing here touches the network and the
 * suite runs offline in CI. What's being tested is the wiring: that the right
 * retrieval mode is chosen, that search results reach the prompt, and that the
 * url guard actually drops what it claims to.
 */
import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

import { runCheck } from "../src/lib/run-check.js";
import { byId } from "../src/lib/providers/index.js";
import { SEED } from "../src/data/seed.js";

const ollama = byId("ollama");
const realFetch = globalThis.fetch;

/**
 * @param {object} opts
 * @param {Array}  opts.searchResults what the search API returns
 * @param {Array}  opts.entries       what the model returns, as JSON
 * @param {string} opts.modelText     raw model output, overriding `entries` —
 *                                    for the cases where it isn't valid JSON
 * @param {Array}  opts.prompts       collects the prompts sent to the model
 */
function stubFetch({ searchResults = [], entries = [], modelText, prompts = [] } = {}) {
  globalThis.fetch = async (url, init) => {
    if (String(url).includes("web_search")) {
      return { ok: true, json: async () => ({ results: searchResults }) };
    }
    prompts.push(JSON.parse(init.body).messages[0].content);
    const content = modelText !== undefined ? modelText : JSON.stringify(entries);
    return { ok: true, json: async () => ({ message: { content } }) };
  };
}

beforeEach(() => {
  globalThis.fetch = realFetch;
});
afterEach(() => {
  globalThis.fetch = realFetch;
});

// A short query list and near-zero backoff: these tests exercise runCheck's
// funnel, not the retry policy, which test/search.test.js covers. Without this
// the two network-failure cases below sit through 15 queries' worth of real
// exponential backoff and the suite takes half a minute.
const run = (env) =>
  runCheck({
    provider: ollama,
    model: "test",
    known: SEED,
    env,
    search: { queries: ["q1"], baseMs: 1, retries: 1 },
  });

describe("retrieval mode", () => {
  test("pre-searches when a search key is present", async () => {
    stubFetch({ searchResults: [{ title: "T", url: "https://a", content: "c" }] });
    const r = await run({ OLLAMA_API_KEY: "k" });
    assert.equal(r.mode, "injected");
    assert.equal(r.searched, 1);
  });

  test("falls back to memory with no search key", async () => {
    stubFetch({});
    const r = await run({});
    assert.equal(r.mode, "memory");
    assert.equal(r.searched, 0);
  });

  test("search results reach the prompt", async () => {
    const prompts = [];
    stubFetch({
      prompts,
      searchResults: [{ title: "Jev 1.14", url: "https://docs.typesafe.ai/x", content: "notes" }],
    });
    await run({ OLLAMA_API_KEY: "k" });
    assert.ok(prompts[0].includes("https://docs.typesafe.ai/x"));
  });

  test("one dead query doesn't sink the check", async () => {
    let call = 0;
    globalThis.fetch = async (url, init) => {
      if (String(url).includes("web_search")) {
        call += 1;
        if (call === 1) return { ok: false, status: 500, json: async () => ({}) };
        return { ok: true, json: async () => ({ results: [{ title: "T", url: "https://a", content: "c" }] }) };
      }
      return { ok: true, json: async () => ({ message: { content: "[]" } }) };
    };
    const r = await run({ OLLAMA_API_KEY: "k" });
    assert.equal(r.mode, "injected");
    assert.ok(r.searched > 0, "surviving queries should still contribute");
  });
});

describe("url guard — the thing that keeps the wire trustworthy", () => {
  const searchResults = [{ title: "Real", url: "https://docs.example/real", content: "c" }];

  test("keeps an entry whose url came from the search results", async () => {
    stubFetch({
      searchResults,
      entries: [{ date: "2026-10-01", title: "Real one", url: "https://docs.example/real" }],
    });
    const r = await run({ OLLAMA_API_KEY: "k" });
    assert.equal(r.fresh.length, 1);
    assert.equal(r.dropped, 0);
  });

  test("drops an entry whose url the model invented", async () => {
    stubFetch({
      searchResults,
      entries: [
        { date: "2026-10-01", title: "Real one", url: "https://docs.example/real" },
        { date: "2026-10-01", title: "Invented", url: "https://docs.example/made-up" },
      ],
    });
    const r = await run({ OLLAMA_API_KEY: "k" });
    assert.equal(r.fresh.length, 1);
    assert.equal(r.dropped, 1);
    assert.equal(r.fresh[0].title, "Real one");
  });

  test("does not apply in memory mode, where there are no results to check against", async () => {
    stubFetch({ entries: [{ date: "2026-10-01", title: "From memory", url: "https://anywhere" }] });
    const r = await run({});
    assert.equal(r.fresh.length, 1);
    assert.equal(r.dropped, 0);
  });
});

describe("failures are reported, not swallowed", () => {
  test("names the host when the model is unreachable", async () => {
    globalThis.fetch = async () => {
      throw new Error("fetch failed");
    };
    await assert.rejects(run({}), /could not reach .*localhost:11434/);
  });

  test("labels a pre-search failure as such", async () => {
    globalThis.fetch = async (url) => {
      if (String(url).includes("web_search")) throw new Error("fetch failed");
      return { ok: true, json: async () => ({ message: { content: "[]" } }) };
    };
    await assert.rejects(run({ OLLAMA_API_KEY: "k" }), /pre-search failed/);
  });

  test("surfaces the provider's own error message", async () => {
    globalThis.fetch = async () => ({
      ok: false,
      status: 429,
      json: async () => ({ error: "quota exceeded" }),
    });
    await assert.rejects(run({}), /quota exceeded/);
  });
});

describe("a zero-entry run surfaces what the model said", () => {
  test("carries the raw text back so prose can be told from an honest []", async () => {
    // parseArray turns unparseable output into [], which makes a model that
    // refused look identical to a model that found nothing. The raw text is
    // the only thing that distinguishes them.
    stubFetch({
      searchResults: [{ title: "T", url: "https://a", content: "c" }],
      modelText: "I cannot determine which of these are new.",
    });
    const r = await run({ OLLAMA_API_KEY: "k" });
    assert.equal(r.returned, 0);
    assert.match(r.rawText, /cannot determine/);
  });

  test("an honest empty array is reported as such", async () => {
    stubFetch({
      searchResults: [{ title: "T", url: "https://a", content: "c" }],
      modelText: "[]",
    });
    const r = await run({ OLLAMA_API_KEY: "k" });
    assert.equal(r.returned, 0);
    assert.equal(r.rawText.trim(), "[]");
  });
});

describe("the provider response survives an empty-content run", () => {
  test("keeps done_reason and thinking, which is where an empty content is explained", async () => {
    // The real shape of the failure: a reasoning model spends num_predict on
    // message.thinking and emits no message.content. extractText sees "" and
    // the funnel says "returned 0", which is indistinguishable from a model
    // that read everything and honestly found nothing.
    globalThis.fetch = async (url) => {
      if (String(url).includes("web_search")) {
        return { ok: true, json: async () => ({ results: [{ title: "T", url: "https://a", content: "c" }] }) };
      }
      return {
        ok: true,
        json: async () => ({
          message: { content: "", thinking: "x".repeat(5000) },
          done_reason: "length",
          eval_count: 2000,
        }),
      };
    };
    const r = await run({ OLLAMA_API_KEY: "k" });
    assert.equal(r.returned, 0);
    assert.equal(r.rawText, "");
    assert.equal(r.rawBody.done_reason, "length", "truncation must be visible");
    assert.equal(r.rawBody.eval_count, 2000);
    assert.match(r.rawBody.message.thinking, /5000 chars/, "long fields are truncated, not dropped");
  });
});

test("ollama asks the model not to think", async () => {
  const { byId } = await import("../src/lib/providers/index.js");
  const body = byId("ollama").buildBody({ prompt: "p", model: "m" });
  assert.equal(body.think, false, "reasoning competes with num_predict for the same budget");
});

test("an X post from an unapproved account is reported as blocked, not as a duplicate", async () => {
  // Anything with a valid url and title that doesn't reach the feed used to be
  // counted as "already known". A gate rejection looks nothing like a
  // duplicate, and reporting them as one is how a day gets lost.
  stubFetch({
    searchResults: [{ title: "T", url: "https://x.com/some_pundit/status/1", content: "c" }],
    entries: [
      { url: "https://x.com/some_pundit/status/1", title: "Hot take", date: "2026-10-19" },
      { url: "https://x.com/AnthropicAI/status/2", title: "Real announcement", date: "2026-10-19" },
    ],
  });
  const r = await run({ OLLAMA_API_KEY: "k" });
  assert.equal(r.returned, 2);
  assert.equal(r.blocked, 1, "the pundit post is a gate rejection");
  assert.equal(r.duplicates, 0, "and must not be counted as already known");
});
