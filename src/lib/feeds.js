/**
 * Retrieval by RSS/Atom: we poll the vendors, the model reads what's new.
 *
 * This replaced a search API that cost a monthly quota and returned wikis,
 * forums, aggregators and X mirrors alongside the real thing. Feeds are better
 * on every axis that mattered:
 *
 *   - Free and unmetered. A feed is a static file.
 *   - Primary by construction. You choose the list, so there is no sourcing
 *     problem to filter after the fact.
 *   - **Dated.** Search results carried no publication date, so the prompt
 *     could not filter by recency and the model was asked to invent one. Feed
 *     items are dated at the source, which means the filtering happens here,
 *     in code, before the model is involved at all.
 *
 * The output shape deliberately matches what the old webSearch() returned —
 * {title, url, content, query} — so buildPrompt, the url guard, normalize and
 * the dedupe downstream are untouched.
 */

/**
 * The sources. Every one of these was confirmed live by scripts/probe-feeds.mjs
 * before being added; nothing here is a guessed URL.
 *
 * `section` seeds the beat an item belongs to. The model still classifies, but
 * a Cloudflare changelog entry starting from "product" beats starting blind.
 */
export const FEEDS = [
  // ── product ──────────────────────────────────────────────────────────────
  // openai.com/blog/rss.xml serves this same feed; one of them is enough.
  { id: "openai", label: "OpenAI", section: "product", url: "https://openai.com/news/rss.xml" },
  { id: "google-ai", label: "Google AI", section: "product", url: "https://blog.google/technology/ai/rss/" },
  { id: "deepmind", label: "Google DeepMind", section: "product", url: "https://deepmind.google/blog/rss.xml" },
  { id: "mistral", label: "Mistral", section: "product", url: "https://mistral.ai/news/rss" },
  { id: "huggingface", label: "Hugging Face", section: "product", url: "https://huggingface.co/blog/feed.xml" },
  { id: "cloudflare", label: "Cloudflare", section: "product", url: "https://blog.cloudflare.com/rss/" },
  // vercel.com/changelog/rss.xml is the same feed as /atom.
  { id: "vercel", label: "Vercel", section: "product", url: "https://vercel.com/atom" },

  // Anthropic publishes no feed — confirmed, not assumed: /news declares none
  // and both plausible paths 404. SDK releases track API changes closely
  // enough to stand in, and GitHub gives every repo a dated Atom feed free.
  // Labels must be unique: they name the source in the prompt listing, in the
  // "feed failed" diagnostics, and now in a bare-version title (see
  // BARE_VERSION). Two feeds both labelled "OpenAI" made a failure line
  // ambiguous about which one had died.
  { id: "anthropic-sdk", label: "Anthropic SDK", section: "product", url: "https://github.com/anthropics/anthropic-sdk-typescript/releases.atom" },
  { id: "openai-sdk", label: "OpenAI Python SDK", section: "product", url: "https://github.com/openai/openai-python/releases.atom" },
  { id: "mcp", label: "MCP", section: "product", url: "https://github.com/modelcontextprotocol/modelcontextprotocol/releases.atom" },
  { id: "ollama", label: "Ollama", section: "product", url: "https://github.com/ollama/ollama/releases.atom" },

  // ── innovation ───────────────────────────────────────────────────────────
  // Rebuilt daily at midnight ET and empty at weekends, which is a quiet
  // Sunday rather than a broken feed.
  { id: "arxiv-cl", label: "arXiv cs.CL", section: "innovation", url: "https://rss.arxiv.org/rss/cs.CL" },
  { id: "arxiv-ai", label: "arXiv cs.AI", section: "innovation", url: "https://rss.arxiv.org/rss/cs.AI" },
  { id: "arxiv-lg", label: "arXiv cs.LG", section: "innovation", url: "https://rss.arxiv.org/rss/cs.LG" },

  // ── business ─────────────────────────────────────────────────────────────
  // Nothing here, and that is not an oversight: funding rounds and
  // acquisitions are not published as a feed by anyone. SEC EDGAR and the EU
  // AI Act page both 403 automated clients. This beat needs the search API or
  // nothing — see SEARCH.md.
];

const MAX_ITEMS_PER_FEED = 12;
/**
 * Ceiling on everything handed to the model in one run, across all feeds.
 *
 * Needed once the date filter went inclusive: a busy weekday can put well over
 * a hundred items in range, and the prompt has to fit in num_ctx.
 */
const MAX_TOTAL_ITEMS = 60;

/**
 * Release candidates, alphas and betas are not news.
 *
 * One run produced "Ollama v0.40.11", "v0.40.11-rc0", "v0.40.10",
 * "v0.40.9-rc3", "-rc2" and "-rc1" as six separate wire entries. A reader
 * wants the release; the road to it is the vendor's business.
 */
const PRERELEASE = /[-\s](rc\d*|alpha|beta|preview|nightly|canary|dev)\b|\brc\d+$/i;

/**
 * A title that is nothing but a version number.
 *
 * GitHub release feeds name an entry after its tag — "v3.46.0" — because that
 * is what the release is called in the repo. On a wire mixing eleven sources
 * it says nothing, and the wire carried "v3.46.0 Release" and "v3.45.0
 * Release" as entries a reader could not possibly act on.
 *
 * The product name is in the feed's label, not the item, so the model never
 * sees it attached and pads the bare tag instead. Attaching it here is the
 * deterministic fix; the prompt cannot be relied on to infer it.
 *
 * The test is "a tag, not a sentence": no whitespace anywhere, and a version
 * somewhere in it. That catches the scoped forms a monorepo emits —
 * "sdk-v1.7.0", "vertex-sdk-v1.1.2", "google-cloud-sdk-v1.1.3" — which a
 * narrower pattern anchored on a leading "v" let straight through.
 */
const BARE_VERSION = /^\S*\d+\.\d+\S*$/;
const MAX_CHARS_PER_ITEM = 600;
const REQUEST_TIMEOUT_MS = 15000;
const CONCURRENCY = 4;

/** Decode the handful of entities that actually appear in feed titles. */
function decode(s) {
  return String(s)
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;|&apos;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    // Last, so a double-escaped "&amp;lt;" doesn't become a tag.
    .replace(/&amp;/g, "&")
    .trim();
}

/**
 * Feed summaries are HTML; the model wants prose.
 *
 * Decode BEFORE stripping, both times for a reason:
 *   - `<![CDATA[Title & more]]>` contains no ">" until its very end, so a
 *     naive tag strip matches the whole wrapper and eats the title.
 *   - Atom content is usually entity-encoded HTML (`&lt;p&gt;`), so the tags
 *     only exist after decoding; strip first and they survive into the output.
 * Both of those shipped and both were caught by the parser tests below.
 */
function stripTags(s) {
  return decode(s)
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

const tag = (xml, name) => {
  const m = xml.match(new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`, "i"));
  return m ? m[1] : "";
};

/**
 * One item, from either dialect.
 *
 * RSS puts the url in <link>text</link>; Atom puts it in <link href="…"/>,
 * often alongside other rel values. Dates are pubDate, published, updated or
 * dc:date depending on who generated the feed.
 */
function parseItem(xml, feed) {
  const rawTitle = stripTags(tag(xml, "title"));
  // Prefixed before PRERELEASE sees it; that pattern matches on the suffix, so
  // "Ollama v0.40.11-rc0" is still recognised as a release candidate.
  const title = BARE_VERSION.test(rawTitle) ? `${feed.label} ${rawTitle}` : rawTitle;

  let url = stripTags(tag(xml, "link"));
  if (!url) {
    // Atom: prefer rel="alternate", fall back to the first href.
    const alt = xml.match(/<link[^>]*rel=["']alternate["'][^>]*href=["']([^"']+)["']/i);
    url = alt ? decode(alt[1]) : decode(xml.match(/<link[^>]*href=["']([^"']+)["']/i)?.[1] || "");
  }

  const rawDate =
    tag(xml, "pubDate") || tag(xml, "published") || tag(xml, "updated") || tag(xml, "dc:date");
  const parsed = Date.parse(decode(rawDate));
  const date = Number.isFinite(parsed) ? new Date(parsed).toISOString().slice(0, 10) : null;

  const body = tag(xml, "description") || tag(xml, "summary") || tag(xml, "content");

  return {
    title,
    url,
    date,
    content: stripTags(body).slice(0, MAX_CHARS_PER_ITEM),
    // Named `query` because that is what webSearch produced and what the
    // prompt builder groups by; here it names the feed instead.
    query: feed.label,
    section: feed.section,
    via: feed.id,
  };
}

/** Split a feed body into item/entry blocks. */
function parseFeed(xml, feed) {
  const blocks = xml.match(/<(item|entry)[\s>][\s\S]*?<\/\1>/gi) || [];
  return blocks
    .map((b) => parseItem(b, feed))
    .filter((i) => i.title && i.url && !PRERELEASE.test(i.title))
    .slice(0, MAX_ITEMS_PER_FEED);
}

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
 * Fetch every feed and return the items published since `since`.
 *
 * @param {object}   opts
 * @param {string}   [opts.since]        YYYY-MM-DD; items on or before it are dropped
 * @param {Array}    [opts.feeds]
 * @param {Function} [opts.fetchImpl]
 * @param {Function} [opts.onProgress]   (done, total, label)
 * @param {Function} [opts.onFeedFail]   (label, message) — partial failure is
 *                                       tolerated, but never silent
 * @param {number}   [opts.maxItems]     ceiling on the total handed back
 * @param {Function} [opts.onTrim]       (kept, total) — fired only when the
 *                                       ceiling actually bites
 */
export async function fetchFeeds({
  since = null,
  feeds = FEEDS,
  fetchImpl = fetch,
  concurrency = CONCURRENCY,
  timeoutMs = REQUEST_TIMEOUT_MS,
  onProgress = null,
  onFeedFail = null,
  maxItems = MAX_TOTAL_ITEMS,
  onTrim = null,
} = {}) {
  let done = 0;

  const settled = await pool(feeds, concurrency, async (feed) => {
    try {
      const res = await fetchImpl(feed.url, {
        redirect: "follow",
        headers: {
          accept: "application/rss+xml, application/atom+xml, application/xml;q=0.9, */*;q=0.8",
          // Some hosts 403 a client that doesn't identify itself; a few more
          // (SEC among them) require contact details in the agent string.
          "user-agent": "ai-wire/1.0 (+https://github.com/juubaker/ai-wire)",
        },
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return parseFeed(await res.text(), feed);
    } finally {
      onProgress?.(++done, feeds.length, feed.label);
    }
  });

  settled.forEach((r, i) => {
    if (r.status === "rejected") {
      onFeedFail?.(feeds[i].label, r.reason?.message || "unknown");
    }
  });

  if (settled.every((r) => r.status === "rejected")) {
    throw new Error(`every feed failed: ${settled[0].reason?.message || "unknown"}`);
  }

  const all = settled.filter((r) => r.status === "fulfilled").flatMap((r) => r.value);

  // Date filtering in code, not in the prompt. This is the thing search
  // results could never support: the old injected prompt had to ask a model to
  // judge recency from undated snippets, and a careful model answered by
  // returning nothing at all.
  //
  // INCLUSIVE, and that matters more than it looks. This was `> since`, which
  // reads as "strictly newer than what we have" — but `since` is a DAY, not a
  // moment. So the instant one entry dated today landed, every other item
  // published today failed the test for the rest of the day. The wire ran at
  // exactly one new entry a day for four days: the first run after UTC
  // midnight took one item and the gate shut behind it. arXiv lost every one
  // of those days, because it publishes in a single daily batch that almost
  // always arrives after some vendor item has already claimed the date.
  //
  // Same-day items now come through, and dedupe drops the ones already on the
  // wire — where they are counted, rather than vanishing here.
  const fresh = since ? all.filter((i) => i.date && i.date >= since) : all;

  // Newest first, then deduped by url across feeds — the same release often
  // appears in a vendor blog and a changelog.
  const seen = new Set();
  const ranked = fresh
    .sort((a, b) => (a.date === b.date ? 0 : a.date < b.date ? 1 : -1))
    .filter((i) => !seen.has(i.url) && seen.add(i.url));

  // An inclusive filter keeps a whole day's publishing in play instead of
  // collapsing to nothing, so the total now needs a ceiling of its own: 14
  // feeds at 12 items each is 168, which is past what fits in the model's
  // context. The old `>` hid this by starving the pipeline. Trimmed
  // newest-first, and reported — a stage that drops things gets a number.
  if (ranked.length > maxItems) onTrim?.(maxItems, ranked.length);
  return ranked.slice(0, maxItems);
}

/** Rendered into the prompt. Dates included, because now we have them. */
export function formatFeedItems(items) {
  return items
    .map(
      (r, n) =>
        `[${n + 1}] ${r.date || "undated"} · ${r.query}\n    ${r.title}\n    ${r.url}\n    ${r.content}`
    )
    .join("\n\n");
}
