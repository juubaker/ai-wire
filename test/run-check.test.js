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
 * @param {Array}  opts.entries       what the model returns
 * @param {Array}  opts.prompts       collects the prompts sent to the model
 */
function stubFetch({ searchResults = [], entries = [], prompts = [] } = {}) {
  globalThis.fetch = async (url, init) => {
    if (String(url).includes("web_search")) {
      return { ok: true, json: async () => ({ results: searchResults }) };
    }
    prompts.push(JSON.parse(init.body).messages[0].content);
    return { ok: true, json: async () => ({ message: { content: JSON.stringify(entries) } }) };
  };
}

beforeEach(() => {
  globalThis.fetch = realFetch;
});
afterEach(() => {
  globalThis.fetch = realFetch;
});

const run = (env) => runCheck({ provider: ollama, model: "test", known: SEED, env });

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
