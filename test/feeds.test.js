/**
 * Retrieval by RSS/Atom.
 *
 * The parser tests are not decoration: two real bugs shipped in the first
 * version and both were caught here rather than in production. Feed XML in the
 * wild is messier than the spec suggests — CDATA wrappers, entity-encoded
 * HTML, two dialects with different link and date conventions — and every
 * assertion below corresponds to a shape one of the configured feeds actually
 * produces.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { FEEDS, fetchFeeds, formatFeedItems } from "../src/lib/feeds.js";

const RSS = `<rss version="2.0"><channel><title>OpenAI News</title>
<item><title><![CDATA[GPT-6.1 Sol &amp; Ultrafast]]></title>
<link>https://openai.com/index/sol/</link>
<pubDate>Fri, 24 Oct 2026 10:00:00 GMT</pubDate>
<description><![CDATA[<p>Ultrafast mode is <b>8x</b> faster.</p>]]></description></item>
<item><title>Old thing</title><link>https://openai.com/index/old/</link>
<pubDate>Mon, 01 Sep 2026 10:00:00 GMT</pubDate><description>Ancient</description></item>
</channel></rss>`;

const ATOM = `<feed xmlns="http://www.w3.org/2005/Atom"><title>Release notes</title>
<entry><title>v0.42.0</title>
<link rel="alternate" type="text/html" href="https://github.com/anthropics/anthropic-sdk-typescript/releases/tag/v0.42.0"/>
<updated>2026-10-24T12:00:00Z</updated>
<content type="html">&lt;p&gt;Adds &lt;b&gt;batch&lt;/b&gt; support&lt;/p&gt;</content></entry></feed>`;

const EMPTY = `<rss version="2.0"><channel><title>cs.CL updates on arXiv.org</title>
<pubDate>Sun, 25 Oct 2026 00:00:00 GMT</pubDate></channel></rss>`;

const feed = (over = {}) => ({
  id: "t",
  label: "Test",
  section: "product",
  url: "https://example.com/rss",
  ...over,
});

const serve = (body) => async () => ({ ok: true, status: 200, text: async () => body });

describe("parsing both dialects", () => {
  test("a CDATA title survives", async () => {
    // Shipped bug: stripTags ran before decode, and `<![CDATA[…]]>` has no ">"
    // until its end — so the whole wrapper matched as one tag, the title came
    // out empty, and the item was silently dropped for having no title.
    const out = await fetchFeeds({ feeds: [feed()], fetchImpl: serve(RSS) });
    assert.equal(out.length, 2, "neither item should be dropped");
    assert.equal(out[0].title, "GPT-6.1 Sol & Ultrafast");
  });

  test("entity-encoded HTML is unwrapped, not passed through", async () => {
    // Shipped bug: Atom content is usually &lt;p&gt;…, so the tags only exist
    // after decoding. Stripping first left "<p>Adds batch support</p>" in the
    // summary the model reads.
    const out = await fetchFeeds({ feeds: [feed()], fetchImpl: serve(ATOM) });
    assert.equal(out[0].content, "Adds batch support");
    assert.doesNotMatch(out[0].content, /<[a-z]/i);
  });

  test("HTML inside CDATA is stripped too", async () => {
    const out = await fetchFeeds({ feeds: [feed()], fetchImpl: serve(RSS) });
    assert.equal(out[0].content, "Ultrafast mode is 8x faster.");
  });

  test("Atom takes its url from rel=alternate, RSS from <link> text", async () => {
    const atom = await fetchFeeds({ feeds: [feed()], fetchImpl: serve(ATOM) });
    assert.match(atom[0].url, /^https:\/\/github\.com\/.*\/v0\.42\.0$/);
    const rss = await fetchFeeds({ feeds: [feed()], fetchImpl: serve(RSS) });
    assert.equal(rss[0].url, "https://openai.com/index/sol/");
  });

  test("dates normalise to YYYY-MM-DD from either convention", async () => {
    const rss = await fetchFeeds({ feeds: [feed()], fetchImpl: serve(RSS) });
    assert.equal(rss[0].date, "2026-10-24", "RFC-822 pubDate");
    const atom = await fetchFeeds({ feeds: [feed()], fetchImpl: serve(ATOM) });
    assert.equal(atom[0].date, "2026-10-24", "ISO updated");
  });
});

describe("date filtering, which search results could never support", () => {
  test("items on or before `since` are dropped before the model sees them", async () => {
    const out = await fetchFeeds({ feeds: [feed()], fetchImpl: serve(RSS), since: "2026-10-01" });
    assert.equal(out.length, 1);
    assert.equal(out[0].date, "2026-10-24");
  });

  test("the boundary is INCLUSIVE — same-day items survive", async () => {
    // The bug this pins: `since` is a day, not a moment. With `>` the filter
    // read as "newer than the wire", but it meant "published on a later DAY
    // than anything we have" — so the first entry to land on a given date made
    // the rest of that date invisible. The wire ran at exactly one new entry a
    // day for four days, and arXiv, which publishes one batch a day, lost
    // every one of them. Dedupe removes what is already known; this filter
    // must not pre-empt it.
    const out = await fetchFeeds({ feeds: [feed()], fetchImpl: serve(RSS), since: "2026-10-24" });
    assert.equal(out.length, 1, "an item dated exactly `since` must come through");
    assert.equal(out[0].date, "2026-10-24");
  });

  test("items from strictly earlier days are still dropped", async () => {
    const out = await fetchFeeds({ feeds: [feed()], fetchImpl: serve(RSS), since: "2026-10-24" });
    assert.ok(
      out.every((i) => i.date >= "2026-10-24"),
      "the September item must not come back"
    );
  });

  test("without `since`, everything comes through", async () => {
    const out = await fetchFeeds({ feeds: [feed()], fetchImpl: serve(RSS) });
    assert.equal(out.length, 2);
  });

  test("newest first", async () => {
    const out = await fetchFeeds({ feeds: [feed()], fetchImpl: serve(RSS) });
    assert.deepEqual(
      out.map((i) => i.date),
      ["2026-10-24", "2026-09-01"]
    );
  });
});

describe("failure is tolerated but never silent", () => {
  test("one dead feed doesn't sink the run, and is named", async () => {
    const failures = [];
    const impl = async (url) =>
      url.includes("dead")
        ? { ok: false, status: 503, text: async () => "" }
        : { ok: true, status: 200, text: async () => RSS };
    const out = await fetchFeeds({
      feeds: [feed({ label: "Good" }), feed({ label: "Dead", url: "https://dead.example/rss" })],
      fetchImpl: impl,
      onFeedFail: (label, msg) => failures.push(`${label}: ${msg}`),
    });
    assert.equal(out.length, 2, "the working feed still returns");
    assert.deepEqual(failures, ["Dead: HTTP 503"]);
  });

  test("all feeds failing throws", async () => {
    await assert.rejects(
      () =>
        fetchFeeds({
          feeds: [feed()],
          fetchImpl: async () => ({ ok: false, status: 500, text: async () => "" }),
        }),
      /every feed failed/
    );
  });

  test("an empty feed is not a failure — arXiv is empty at weekends", async () => {
    const failures = [];
    const out = await fetchFeeds({
      feeds: [feed({ label: "arXiv cs.CL" })],
      fetchImpl: serve(EMPTY),
      onFeedFail: (l, m) => failures.push(`${l}: ${m}`),
    });
    assert.deepEqual(out, []);
    assert.deepEqual(failures, [], "a quiet Sunday is not a broken feed");
  });
});

describe("a bare version number is not a title", () => {
  const release = (t) =>
    `<feed><entry><title>${t}</title>` +
    `<link rel="alternate" href="https://github.com/openai/openai-python/releases/tag/${t}"/>` +
    `<updated>2026-11-09T12:00:00Z</updated><content type="html">notes</content></entry></feed>`;

  const sdk = feed({ label: "OpenAI Python SDK" });

  test("the feed's label is attached to a bare tag", async () => {
    // The wire carried "v3.46.0 Release" and "v3.45.0 Release" as entries. The
    // product name lives in the feed label, never in the item, so the model
    // pads the tag instead of naming the product.
    const out = await fetchFeeds({ feeds: [sdk], fetchImpl: serve(release("v3.46.0")) });
    assert.equal(out[0].title, "OpenAI Python SDK v3.46.0");
  });

  test("a tag with no leading v is still a bare version", async () => {
    const out = await fetchFeeds({ feeds: [sdk], fetchImpl: serve(release("3.46.0")) });
    assert.equal(out[0].title, "OpenAI Python SDK 3.46.0");
  });

  test("scoped monorepo tags count too", async () => {
    // The Anthropic SDK repo emits these, and a pattern anchored on a leading
    // "v" let all three through unprefixed.
    for (const tag of ["sdk-v1.7.0", "vertex-sdk-v1.1.2", "google-cloud-sdk-v1.1.3"]) {
      const out = await fetchFeeds({ feeds: [sdk], fetchImpl: serve(release(tag)) });
      assert.equal(out[0].title, `OpenAI Python SDK ${tag}`, tag);
    }
  });

  test("a headline that merely contains a version is left alone", async () => {
    // Has whitespace, so it is a sentence, not a tag.
    const out = await fetchFeeds({
      feeds: [sdk],
      fetchImpl: serve(release("Claude Opus 4.5 is available in the SDK")),
    });
    assert.equal(out[0].title, "Claude Opus 4.5 is available in the SDK");
  });

  test("a title that already says something is left alone", async () => {
    const out = await fetchFeeds({
      feeds: [sdk],
      fetchImpl: serve(release("Structured outputs for the Responses API")),
    });
    assert.equal(out[0].title, "Structured outputs for the Responses API");
  });

  test("prefixing does not smuggle a release candidate past PRERELEASE", async () => {
    const out = await fetchFeeds({ feeds: [sdk], fetchImpl: serve(release("v3.46.0-rc1")) });
    assert.deepEqual(out, [], "an rc is still dropped once the label is attached");
  });
});

describe("the total ceiling, and that it reports itself", () => {
  const many = (n) =>
    `<rss><channel>${Array.from(
      { length: n },
      (_, i) =>
        `<item><title>Paper ${i}</title><link>https://arxiv.org/abs/${i}</link>` +
        `<pubDate>Fri, 24 Oct 2026 10:00:00 GMT</pubDate><description>x</description></item>`
    ).join("")}</channel></rss>`;

  test("trims to maxItems, newest first", async () => {
    const out = await fetchFeeds({ feeds: [feed()], fetchImpl: serve(many(30)), maxItems: 10 });
    assert.equal(out.length, 10);
  });

  test("the trim is reported, never silent", async () => {
    let seen = null;
    await fetchFeeds({
      feeds: [feed()],
      fetchImpl: serve(many(30)),
      maxItems: 10,
      onTrim: (kept, total) => {
        seen = { kept, total };
      },
    });
    // MAX_ITEMS_PER_FEED caps one feed at 12 before this ever runs.
    assert.deepEqual(seen, { kept: 10, total: 12 });
  });

  test("no callback when the ceiling doesn't bite", async () => {
    let fired = false;
    await fetchFeeds({
      feeds: [feed()],
      fetchImpl: serve(RSS),
      maxItems: 50,
      onTrim: () => {
        fired = true;
      },
    });
    assert.equal(fired, false);
  });
});

describe("the same story from two feeds is one item", () => {
  test("deduped by url across feeds", async () => {
    const out = await fetchFeeds({
      feeds: [feed({ label: "Blog" }), feed({ label: "Changelog" })],
      fetchImpl: serve(RSS),
    });
    assert.equal(out.length, 2, "two feeds serving the same items yield one set");
  });
});

describe("the configured source list", () => {
  test("every feed has the fields the pipeline needs", () => {
    for (const f of FEEDS) {
      assert.ok(f.id && f.label && f.url, `incomplete feed: ${JSON.stringify(f)}`);
      assert.match(f.url, /^https:\/\//, `${f.label} must be https`);
      assert.ok(["product", "business", "innovation"].includes(f.section), `${f.label} section`);
    }
  });

  test("no duplicate urls or ids", () => {
    assert.equal(new Set(FEEDS.map((f) => f.url)).size, FEEDS.length, "duplicate feed url");
    assert.equal(new Set(FEEDS.map((f) => f.id)).size, FEEDS.length, "duplicate feed id");
  });

  test("no duplicate labels — they name the source in diagnostics and in titles", () => {
    // Two feeds were both labelled "OpenAI", which made `feed failed OpenAI`
    // ambiguous about which had died, and would have put the wrong product
    // name on a bare-version title.
    assert.equal(new Set(FEEDS.map((f) => f.label)).size, FEEDS.length, "duplicate feed label");
  });

  test("innovation is covered, so the beat can't silently empty", () => {
    assert.ok(FEEDS.some((f) => f.section === "innovation"), "no innovation feeds");
  });
});

describe("what the model is handed", () => {
  test("each item carries its date and source", async () => {
    const out = await fetchFeeds({ feeds: [feed({ label: "OpenAI" })], fetchImpl: serve(RSS) });
    const text = formatFeedItems(out);
    assert.match(text, /\[1\] 2026-10-24 · OpenAI/);
    assert.match(text, /https:\/\/openai\.com\/index\/sol\//);
  });
});
