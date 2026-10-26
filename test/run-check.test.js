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
 * @param {Array}  opts.feedItems     what the feeds return — the default
 *                                    retrieval path since RSS replaced search
 * @param {Array}  opts.searchResults what the search API returns (opt-in now)
 * @param {Array}  opts.entries       what the model returns, as JSON
 * @param {string} opts.modelText     raw model output, overriding `entries` —
 *                                    for the cases where it isn't valid JSON
 * @param {Array}  opts.prompts       collects the prompts sent to the model
 */
/** Build an RSS body from {title, url, date} so the real parser is exercised. */
function asRss(items) {
  const entries = items
    .map(
      (i) =>
        `<item><title>${i.title}</title><link>${i.url}</link>` +
        `<pubDate>${new Date(`${i.date || "2026-10-20"}T00:00:00Z`).toUTCString()}</pubDate>` +
        `<description>${i.content || "c"}</description></item>`
    )
    .join("");
  return `<rss version="2.0"><channel><title>Test feed</title>${entries}</channel></rss>`;
}

function stubFetch({ feedItems = [], searchResults = [], entries = [], modelText, prompts = [] } = {}) {
  globalThis.fetch = async (url, init) => {
    if (String(url).includes("web_search")) {
      return { ok: true, json: async () => ({ results: searchResults }) };
    }
    if (String(url).includes("feed.test")) {
      return { ok: true, status: 200, text: async () => asRss(feedItems) };
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
const run = (env, extra = {}) =>
  runCheck({
    provider: ollama,
    model: "test",
    known: SEED,
    env,
    // One stub feed rather than the real fourteen, and a short query list with
    // near-zero backoff for the opt-in search path.
    feeds: { feeds: [{ id: "t", label: "Test", section: "product", url: "https://feed.test/rss" }] },
    search: { queries: ["q1"], baseMs: 1, retries: 1 },
    ...extra,
  });

describe("retrieval mode", () => {
  test("feeds are the default — no key, no quota, no search", async () => {
    stubFetch({ feedItems: [{ title: "T", url: "https://a", date: "2026-10-20" }] });
    const r = await run({});
    assert.equal(r.mode, "feeds");
    assert.equal(r.searched, 1);
  });

  test("feed items reach the prompt, with their dates", async () => {
    const prompts = [];
    stubFetch({
      prompts,
      feedItems: [{ title: "Jev 1.14", url: "https://docs.typesafe.ai/x", date: "2026-10-20" }],
    });
    await run({});
    assert.ok(prompts[0].includes("https://docs.typesafe.ai/x"));
    assert.ok(prompts[0].includes("2026-10-20"), "the date must be given, not inferred");
    assert.match(prompts[0], /use the date given/);
  });

  test("items older than the wire never reach the model", async () => {
    // The filter search could never support: feed items are dated at source,
    // so recency is a comparison here rather than a judgement in the prompt.
    const prompts = [];
    stubFetch({
      prompts,
      feedItems: [
        { title: "Ancient", url: "https://a/old", date: "2020-01-01" },
        { title: "Fresh", url: "https://a/new", date: "2099-01-01" },
      ],
    });
    const r = await run({});
    assert.equal(r.searched, 1, "only the item newer than the wire");
    assert.ok(prompts[0].includes("https://a/new"));
    assert.ok(!prompts[0].includes("https://a/old"));
  });

  test("search stays off unless asked for, even with a key present", async () => {
    // It costs a metered quota whose free tier is capped monthly. Only the
    // business beat has no feed, so search is opt-in rather than automatic.
    let searched = false;
    globalThis.fetch = async (url, init) => {
      if (String(url).includes("web_search")) {
        searched = true;
        return { ok: true, json: async () => ({ results: [] }) };
      }
      if (String(url).includes("feed.test")) {
        return { ok: true, status: 200, text: async () => asRss([{ title: "T", url: "https://a", date: "2026-10-20" }]) };
      }
      return { ok: true, json: async () => ({ message: { content: "[]" } }) };
    };
    const r = await run({ OLLAMA_API_KEY: "k" });
    assert.equal(searched, false, "a key alone must not spend quota");
    assert.equal(r.mode, "feeds");
  });

  test("opting in adds search on top of the feeds", async () => {
    stubFetch({
      feedItems: [{ title: "FromFeed", url: "https://a/feed", date: "2026-10-20" }],
      searchResults: [{ title: "FromSearch", url: "https://a/search", content: "c" }],
    });
    const r = await run({ OLLAMA_API_KEY: "k" }, { useSearch: true });
    assert.equal(r.mode, "feeds+search");
    assert.equal(r.searched, 2, "both sources contribute");
  });

  test("a spent search quota does not sink a run the feeds covered", async () => {
    // Search is the fragile half now. A 429 on the metered path must not throw
    // away retrieval that already succeeded for free.
    globalThis.fetch = async (url) => {
      if (String(url).includes("web_search")) throw new Error("fetch failed");
      if (String(url).includes("feed.test")) {
        return { ok: true, status: 200, text: async () => asRss([{ title: "T", url: "https://a", date: "2026-10-20" }]) };
      }
      return { ok: true, json: async () => ({ message: { content: "[]" } }) };
    };
    const r = await run({ OLLAMA_API_KEY: "k" }, { useSearch: true });
    assert.equal(r.searched, 1, "the feed item survives");
    assert.ok(r.searchFailures.length > 0, "and the failure is reported");
  });
});

describe("url guard — the thing that keeps the wire trustworthy", () => {
  const feedItems = [{ title: "Real", url: "https://docs.example/real", date: "2026-10-20" }];

  test("keeps an entry whose url came from the retrieved items", async () => {
    stubFetch({
      feedItems,
      entries: [{ date: "2026-10-20", title: "Real one", url: "https://docs.example/real" }],
    });
    const r = await run({});
    assert.equal(r.fresh.length, 1);
    assert.equal(r.dropped, 0);
  });

  test("drops an entry whose url the model invented", async () => {
    stubFetch({
      feedItems,
      entries: [
        { date: "2026-10-20", title: "Real one", url: "https://docs.example/real" },
        { date: "2026-10-20", title: "Invented", url: "https://docs.example/made-up" },
      ],
    });
    const r = await run({});
    assert.equal(r.fresh.length, 1);
    assert.equal(r.dropped, 1);
    assert.equal(r.fresh[0].title, "Real one");
  });
});

describe("failures are reported, not swallowed", () => {
  test("names the host when the model is unreachable", async () => {
    globalThis.fetch = async (url) => {
      if (String(url).includes("feed.test")) {
        return { ok: true, status: 200, text: async () => asRss([{ title: "T", url: "https://a", date: "2026-10-20" }]) };
      }
      throw new Error("fetch failed");
    };
    await assert.rejects(run({}), /could not reach .*localhost:11434/);
  });

  test("every feed failing is reported as such", async () => {
    globalThis.fetch = async (url) => {
      if (String(url).includes("feed.test")) throw new Error("fetch failed");
      return { ok: true, json: async () => ({ message: { content: "[]" } }) };
    };
    await assert.rejects(run({}), /feeds failed/);
  });

  test("one dead feed is named but does not sink the check", async () => {
    globalThis.fetch = async (url) => {
      if (String(url).includes("dead.test")) throw new Error("fetch failed");
      if (String(url).includes("feed.test")) {
        return { ok: true, status: 200, text: async () => asRss([{ title: "T", url: "https://a", date: "2026-10-20" }]) };
      }
      return { ok: true, json: async () => ({ message: { content: "[]" } }) };
    };
    const r = await run({}, {
      feeds: {
        feeds: [
          { id: "ok", label: "Good", section: "product", url: "https://feed.test/rss" },
          { id: "bad", label: "Dead", section: "product", url: "https://dead.test/rss" },
        ],
      },
    });
    assert.equal(r.searched, 1);
    assert.deepEqual(r.feedFailures.map((f) => f.query), ["Dead"]);
  });

  test("surfaces the provider's own error message", async () => {
    globalThis.fetch = async (url) => {
      if (String(url).includes("feed.test")) {
        return { ok: true, status: 200, text: async () => asRss([{ title: "T", url: "https://a", date: "2026-10-20" }]) };
      }
      return { ok: false, status: 429, json: async () => ({ error: "quota exceeded" }) };
    };
    await assert.rejects(run({}), /quota exceeded/);
  });
});

describe("a zero-entry run surfaces what the model said", () => {
  test("carries the raw text back so prose can be told from an honest []", async () => {
    // parseArray turns unparseable output into [], which makes a model that
    // refused look identical to a model that found nothing. The raw text is
    // the only thing that distinguishes them.
    stubFetch({
      feedItems: [{ title: "T", url: "https://a", date: "2026-10-20" }],
      modelText: "I cannot determine which of these are new.",
    });
    const r = await run({ OLLAMA_API_KEY: "k" });
    assert.equal(r.returned, 0);
    assert.match(r.rawText, /cannot determine/);
  });

  test("an honest empty array is reported as such", async () => {
    stubFetch({
      feedItems: [{ title: "T", url: "https://a", date: "2026-10-20" }],
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
      if (String(url).includes("feed.test")) {
        return {
          ok: true,
          status: 200,
          text: async () => asRss([{ title: "T", url: "https://a", date: "2026-10-20" }]),
        };
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
    const r = await run({});
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
    feedItems: [
      { title: "T", url: "https://x.com/some_pundit/status/1", date: "2026-10-20" },
      { title: "U", url: "https://x.com/AnthropicAI/status/2", date: "2026-10-20" },
    ],
    entries: [
      { url: "https://x.com/some_pundit/status/1", title: "Hot take", date: "2026-10-19" },
      { url: "https://x.com/AnthropicAI/status/2", title: "Real announcement", date: "2026-10-19" },
    ],
  });
  const r = await run({});
  assert.equal(r.returned, 2);
  assert.equal(r.blocked, 1, "the pundit post is a gate rejection");
  assert.equal(r.duplicates, 0, "and must not be counted as already known");
});

test("the model is not called when retrieval found nothing", async () => {
  // Handed zero items the model returned twelve invented entries, including an
  // arXiv id that doesn't exist and a date a week in the future. The url guard
  // caught all twelve — but the cheapest hallucination to handle is the one
  // never requested, and a skipped call costs nothing.
  let modelCalled = false;
  globalThis.fetch = async (url) => {
    if (String(url).includes("feed.test")) {
      return { ok: true, status: 200, text: async () => asRss([]) };
    }
    modelCalled = true;
    return { ok: true, json: async () => ({ message: { content: "[]" } }) };
  };
  const r = await run({});
  assert.equal(modelCalled, false, "no items means nothing to summarise");
  assert.equal(r.skippedModel, true);
  assert.deepEqual(r.fresh, []);
  assert.equal(r.returned, 0);
});

test("a current wire retrieves nothing, which is success not failure", async () => {
  // `since` is the wire's newest entry, so a wire that is up to date filters
  // every item out. That is the date filter working, not a broken feed.
  stubFetch({ feedItems: [{ title: "Old", url: "https://a/old", date: "2020-01-01" }] });
  const r = await run({});
  assert.equal(r.searched, 0);
  assert.equal(r.skippedModel, true);
  assert.deepEqual(r.feedFailures, [], "nothing failed — there was just nothing new");
});
