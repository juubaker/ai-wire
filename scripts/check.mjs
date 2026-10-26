/**
 * The scheduled check, as a plain Node script.
 *
 * GitHub Pages has no server, so the feed can't be an endpoint — it's a file in
 * the repo. This runs in Actions, calls the provider directly, merges the
 * result into public/feed.json, and exits. The workflow commits the file and
 * Pages redeploys.
 *
 *   node scripts/check.mjs [--provider ollama] [--model qwen3:8b]
 *                          [--search] [--no-search] [--fresh]
 *
 * Retrieval is RSS/Atom feeds by default: free, unmetered, dated at source.
 * --search additionally queries the search API, which is metered and capped
 * monthly — worth it only for the business beat, which has no feed anywhere.
 *
 * --no-search skips retrieval entirely, so the model answers from memory. A
 * diagnostic, not a mode to run on a schedule.
 * --fresh ignores the search cache. Costs real rate-limit budget, so it is not
 * the default — iterating on the model should not re-spend retrieval.
 *
 * Exits 0 when there's nothing new, 1 only on a real failure, so a quiet day
 * doesn't show up as a red build.
 */
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { canonicalUrl } from "../src/lib/check.js";
import { byId } from "../src/lib/providers/index.js";
import { runCheck } from "../src/lib/run-check.js";
import { SEED } from "../src/data/seed.js";

const FEED_PATH = resolve(process.cwd(), "public/feed.json");
const CACHE_PATH = resolve(process.cwd(), ".cache/search.json");
const MAX_ENTRIES = 150;
/**
 * How long a search result stays usable. Long enough that iterating on the
 * model or the prompt costs no retrieval budget, short enough that a scheduled
 * run an hour later still sees new material.
 */
const CACHE_TTL_MS = 30 * 60 * 1000;

/**
 * A file-backed cache for search results, passed into webSearch.
 *
 * It lives here rather than in search.js because that module also runs in the
 * Worker and behind the Vite proxy, where there is no filesystem. The seam is
 * a plain {get, set}, so each caller brings storage that suits it.
 *
 * This exists because debugging the model used to re-spend the whole query
 * budget on every run, which is what exhausted the rate limiter.
 */
async function openCache({ ttlMs = CACHE_TTL_MS, fresh = false } = {}) {
  let store = {};
  if (!fresh) {
    try {
      store = JSON.parse(await readFile(CACHE_PATH, "utf8"));
    } catch {
      // No cache yet, or it's corrupt — either way, start clean.
    }
  }
  let writes = 0;
  return {
    hits: 0,
    get(query) {
      const row = store[query];
      if (!row || Date.now() - row.at > ttlMs) return null;
      this.hits++;
      return row.results;
    },
    set(query, results) {
      store[query] = { at: Date.now(), results };
      writes++;
    },
    async flush() {
      if (!writes) return;
      await mkdir(dirname(CACHE_PATH), { recursive: true });
      await writeFile(CACHE_PATH, `${JSON.stringify(store)}\n`);
    },
  };
}

/**
 * Vite loads .env.local for the dev proxy; a plain Node script does not. Without
 * this the browser's Check now button pre-searched while `npm run check` quietly
 * answered from memory — the same code reaching two different conclusions, and
 * only one of them visible. Real env wins, so CI secrets are never shadowed.
 */
async function loadEnvLocal() {
  let text;
  try {
    text = await readFile(resolve(process.cwd(), ".env.local"), "utf8");
  } catch {
    return; // Fine in CI, where the values come from secrets.
  }
  for (const line of text.split("\n")) {
    const m = line.match(/^\s*(?:export\s+)?([A-Z_][A-Z0-9_]*)\s*=\s*(.*)$/i);
    if (!m) continue;
    const value = m[2].trim().replace(/^(['"])(.*)\1$/s, "$2");
    if (process.env[m[1]] === undefined) process.env[m[1]] = value;
  }
}

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
};

const flag = (name) => process.argv.includes(`--${name}`);

async function loadFeed() {
  try {
    const parsed = JSON.parse(await readFile(FEED_PATH, "utf8"));
    if (Array.isArray(parsed.items) && parsed.items.length) {
      // Heal duplicates already on the wire. Dedupe used to key on url+title,
      // and since the title is model-written it varied between runs — so the
      // same announcement landed more than once. Keep the earliest copy, which
      // carries the date it was first seen.
      const seen = new Set();
      const items = parsed.items.filter((i) => {
        const key = canonicalUrl(i.url);
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
      const removed = parsed.items.length - items.length;
      if (removed) console.log(`  deduped      ${removed} duplicate entr${removed === 1 ? "y" : "ies"} already on the wire`);
      return { ...parsed, items };
    }
  } catch {
    // First run: no feed file yet.
  }
  return { items: SEED, checkedAt: null };
}

async function main() {
  await loadEnvLocal();

  // No hardcoded fallback: byId() falls back to the first registered provider,
  // so the registry stays the single source of truth for what the default is.
  const provider = byId(arg("provider", process.env.WIRE_PROVIDER));
  const model = arg("model", process.env.WIRE_MODEL || provider.models[0]);
  const key = provider.envKey ? process.env[provider.envKey] : "";

  if (provider.envKey && !key) {
    throw new Error(
      `${provider.envKey} is not set. Add it as a repository secret and pass it through in the workflow env.`
    );
  }

  // Memory mode tells the model that [] is the correct answer, so it reliably
  // finds nothing and exits 0 — a green build that has never worked. It's a
  // useful diagnostic but never a schedule, so it has to be asked for.
  if (!provider.supportsSearch && !process.env.OLLAMA_API_KEY && !flag("no-search")) {
    throw new Error(
      `${provider.label} can't search, and OLLAMA_API_KEY is not set — the check would answer from memory and find nothing.\n` +
        `  Put OLLAMA_API_KEY in .env.local (key: https://ollama.com/settings/keys), or in CI as a repository secret.\n` +
        `  To run without retrieval anyway, pass --no-search.`
    );
  }

  console.log(`checking via ${provider.id} / ${model}`);

  const feed = await loadFeed();

  // Retrieval can take a minute and the model another; without a heartbeat the
  // two are indistinguishable from a hang, which is how a 12-minute retry storm
  // went unnoticed. Rewrites one line rather than scrolling.
  const tty = process.stdout.isTTY;
  const progress = (noun) => (n, total) => {
    if (tty) process.stdout.write(`\r  reading       ${n}/${total} ${noun}`);
    else if (n === total) console.log(`  reading       ${n}/${total} ${noun}`);
  };
  const onProgress = progress("queries");
  const onFeedProgress = progress("feeds");

  const cache = await openCache({ fresh: flag("fresh") });

  const { fresh, mode, searched, returned, duplicates, dropped, unusable, blocked, rawText, rawBody, searchFailures, feedFailures, overflow, skippedModel } = await runCheck({
    search: { onProgress, cache },
    feeds: { onProgress: onFeedProgress },
    useSearch: flag("search"),
    provider,
    model,
    known: feed.items,
    env: flag("no-search") ? { ...process.env, OLLAMA_API_KEY: "" } : process.env,
  });

  await cache.flush();
  if (tty) process.stdout.write("\r\x1b[K"); // clear the progress line

  // Print every stage, so a zero-result run says which stage produced the zero.
  if (mode !== "memory") {
    const cached = cache.hits ? ` (${cache.hits} from cache)` : "";
    console.log(`  retrieved     ${searched} items via ${mode}${cached}`);
    // A feed that dies every run makes its vendor look quiet rather than
    // unreachable. Name them.
    for (const f of feedFailures || []) {
      console.log(`  feed failed    ${f.query} — ${f.message.split("\n")[0]}`);
    }
    // A query that dies every run makes its whole beat look empty rather than
    // broken. Name them.
    for (const f of searchFailures || []) {
      console.log(`  query failed   "${f.query.slice(0, 52)}" — ${f.message.split("\n")[0]}`);
    }
  }
  else console.log(`  searched      none (mode: ${mode})`);
  console.log(`  model returned ${returned} entr${returned === 1 ? "y" : "ies"}`);
  if (unusable) console.log(`  no url/title   ${unusable} dropped`);
  if (blocked) console.log(`  unofficial X   ${blocked} dropped`);
  if (duplicates) console.log(`  already known  ${duplicates} dropped`);
  if (overflow) console.log(`  over the cap   ${overflow} held back for the next run`);
  if (dropped) console.log(`  unlisted url   ${dropped} dropped`);
  console.log(`  kept          ${fresh.length}`);

  if (fresh.length === 0) {
    const why =
      searched === 0 && mode !== "memory"
        ? (feedFailures || []).length
          ? `every source that answered had nothing new, and ${feedFailures.length} could not be reached — see the lines above`
          : `nothing published since ${feed.items.map((i) => i.date).sort().slice(-1)[0]}; the wire is current (the model was not called)`
        : mode === "memory"
          ? "no OLLAMA_API_KEY, so the model answered from memory and was told to prefer []"
          : returned === 0
            ? "the model returned an empty list — it may be too small for the prompt, or genuinely found nothing new since " +
              feed.items.map((i) => i.date).sort().slice(-1)[0]
            : dropped === returned
              ? "every entry cited a url that wasn't in the search results — the model is paraphrasing links"
              : "everything found was already on the wire";
    console.log(`nothing added: ${why}`);

    // Whenever nothing reaches the wire, print what the model actually said.
    // Gated on `returned === 0` this stayed hidden for the case that mattered
    // most: a model that returns one entry out of 59 results is telling you
    // something about what it latched onto, and the counts can't convey it.
    // Skipped only when the model was never called — there is no output to show.
    if (!skippedModel) {
      const said = (rawText || "").trim();
      console.log(
        said
          ? `model said (${said.length} chars):\n${said.slice(0, 600)}${said.length > 600 ? "\n  …truncated" : ""}`
          : "model said: nothing at all — empty response body"
      );
      // With no content, the surrounding fields are the whole story.
      if (!rawText) console.log(`provider response:\n${JSON.stringify(rawBody, null, 2)}`);
    }
  }

  const next = {
    items: [...fresh, ...feed.items].slice(0, MAX_ENTRIES),
    checkedAt: Date.now(),
    provider: provider.id,
    model,
  };

  await mkdir(dirname(FEED_PATH), { recursive: true });
  await writeFile(FEED_PATH, `${JSON.stringify(next, null, 2)}\n`);

  // Picked up by the workflow to decide whether to commit.
  console.log(`added=${fresh.length} total=${next.items.length} provider=${provider.id} model=${model}`);
  for (const f of fresh) console.log(`  + [${f.section}] ${f.date} ${f.title}`);
}

main().catch((err) => {
  console.error(`check failed: ${err.message}`);
  process.exit(1);
});
