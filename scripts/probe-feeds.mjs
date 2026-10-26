/**
 * Find out which vendors actually publish a feed, before any code depends on it.
 *
 * Written first, deliberately. The "On X" section was built on the assumption
 * that X content was retrievable, cost a day and an afternoon's search budget,
 * and died to three queries' worth of evidence that could have been gathered
 * beforehand. This is that evidence, gathered beforehand.
 *
 *   node scripts/probe-feeds.mjs
 *   node scripts/probe-feeds.mjs https://example.com/blog   # probe one extra
 *
 * For each candidate it reports whether the URL is a real feed, how many items
 * it has, and the newest item's date — so a feed that exists but hasn't moved
 * since June is visibly different from one that's current. For an HTML page it
 * reports any feed the page declares in its <head>, which is how to find the
 * real URL without guessing.
 *
 * Costs nothing: plain HTTP to public files, no API key, no rate limit.
 */

const CANDIDATES = [
  // product — the vendors whose releases the wire tracks
  ["Anthropic", "https://www.anthropic.com/news"],
  ["Anthropic", "https://www.anthropic.com/news/rss.xml"],
  ["Anthropic", "https://www.anthropic.com/rss.xml"],
  ["OpenAI", "https://openai.com/news/"],
  ["OpenAI", "https://openai.com/news/rss.xml"],
  ["OpenAI", "https://openai.com/blog/rss.xml"],
  ["Google AI", "https://blog.google/technology/ai/rss/"],
  ["Google DeepMind", "https://deepmind.google/blog/"],
  ["Google DeepMind", "https://deepmind.google/blog/rss.xml"],
  ["Mistral", "https://mistral.ai/news"],
  ["Mistral", "https://mistral.ai/news/feed.xml"],
  ["Hugging Face", "https://huggingface.co/blog/feed.xml"],
  ["Cloudflare", "https://blog.cloudflare.com/rss/"],
  ["Vercel", "https://vercel.com/atom"],
  ["Vercel changelog", "https://vercel.com/changelog/rss.xml"],
  ["MCP", "https://modelcontextprotocol.io/rss.xml"],
  ["MCP", "https://modelcontextprotocol.io/"],

  // innovation — arXiv publishes per-category feeds, dated and primary
  ["arXiv cs.CL", "http://export.arxiv.org/rss/cs.CL"],
  ["arXiv cs.AI", "http://export.arxiv.org/rss/cs.AI"],
  ["arXiv cs.LG", "http://export.arxiv.org/rss/cs.LG"],

  // business — the weak spot. Funding and acquisitions have no vendor feed;
  // these are the closest primary-ish sources worth testing.
  ["SEC EDGAR 8-K", "https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&type=8-K&output=atom"],
  ["EU AI Act", "https://digital-strategy.ec.europa.eu/en/rss.xml"],
];

const TIMEOUT_MS = 12000;

/** Count items and find the newest date, without an XML parser. */
function inspect(xml) {
  const items = [...xml.matchAll(/<(item|entry)[\s>]/gi)].length;
  const dates = [
    ...xml.matchAll(/<(pubDate|published|updated|dc:date)>([^<]+)</gi),
  ]
    .map((m) => Date.parse(m[2].trim()))
    .filter((t) => Number.isFinite(t));
  const newest = dates.length ? new Date(Math.max(...dates)) : null;
  const title = xml.match(/<title[^>]*>([^<]+)</i)?.[1]?.trim() ?? "";
  return { items, newest, title };
}

/** Feeds an HTML page declares in its head. */
function declaredFeeds(html, base) {
  const out = [];
  for (const m of html.matchAll(/<link[^>]+>/gi)) {
    const tag = m[0];
    if (!/rel=["']?alternate/i.test(tag)) continue;
    if (!/(rss|atom)\+xml/i.test(tag)) continue;
    const href = tag.match(/href=["']([^"']+)["']/i)?.[1];
    if (href) {
      try {
        out.push(new URL(href, base).href);
      } catch {
        /* skip a href we can't resolve */
      }
    }
  }
  return [...new Set(out)];
}

const age = (d) => {
  if (!d) return "no dates";
  const days = Math.floor((Date.now() - d.getTime()) / 86400000);
  return days === 0 ? "today" : days === 1 ? "1 day ago" : `${days} days ago`;
};

async function probe(label, url) {
  let res;
  try {
    res = await fetch(url, {
      redirect: "follow",
      headers: {
        // Some sites serve a feed only when it's asked for, and 403 a client
        // with no user agent.
        accept: "application/rss+xml, application/atom+xml, application/xml, text/html;q=0.8",
        "user-agent": "ai-wire-feed-probe/1.0 (+https://github.com/juubaker/ai-wire)",
      },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err) {
    return { label, url, verdict: "unreachable", detail: err.message.slice(0, 48) };
  }

  if (!res.ok) return { label, url, verdict: `HTTP ${res.status}`, detail: "" };

  const body = await res.text();
  const looksLikeFeed = /<(rss|feed)[\s>]/i.test(body.slice(0, 2000));

  if (looksLikeFeed) {
    const { items, newest, title } = inspect(body);
    return {
      label,
      url,
      verdict: items > 0 ? "FEED" : "feed, but empty",
      detail: `${items} items · newest ${age(newest)} · ${title.slice(0, 32)}`,
    };
  }

  const found = declaredFeeds(body, res.url);
  if (found.length) {
    return { label, url, verdict: "html → declares", detail: found.join("  ") };
  }
  return { label, url, verdict: "html, no feed", detail: "" };
}

const extra = process.argv.slice(2).map((u) => ["(given)", u]);
const list = [...CANDIDATES, ...extra];

console.log(`probing ${list.length} candidates…\n`);

// Serial and unthrottled is fine: these are static files on different hosts.
const results = [];
for (const [label, url] of list) {
  const r = await probe(label, url);
  results.push(r);
  const mark = r.verdict === "FEED" ? "✓" : r.verdict.startsWith("html →") ? "→" : " ";
  console.log(
    `${mark} ${r.label.padEnd(16)} ${r.verdict.padEnd(15)} ${r.url.slice(0, 52)}`
  );
  if (r.detail) console.log(`${" ".repeat(35)}${r.detail}`);
}

const working = results.filter((r) => r.verdict === "FEED");
const pointers = results.filter((r) => r.verdict.startsWith("html →"));

console.log("\n" + "-".repeat(70));
console.log(`${working.length} working feeds · ${pointers.length} pages declaring one`);
if (pointers.length) {
  console.log("\nRe-run with the declared URLs to confirm they're real feeds:");
  console.log("  node scripts/probe-feeds.mjs " + pointers.flatMap((p) => p.detail.split(/\s+/)).join(" "));
}
if (working.length) {
  console.log("\nConfirmed feeds:");
  for (const w of working) console.log(`  ${w.url}`);
}
