/**
 * The scheduled check, as a plain Node script.
 *
 * GitHub Pages has no server, so the feed can't be an endpoint — it's a file in
 * the repo. This runs in Actions, calls the provider directly, merges the
 * result into public/feed.json, and exits. The workflow commits the file and
 * Pages redeploys.
 *
 *   node scripts/check.mjs [--provider ollama] [--model qwen3:32b] [--no-search]
 *
 * --no-search skips retrieval entirely, so the model answers from memory. A
 * diagnostic, not a mode to run on a schedule.
 *
 * Exits 0 when there's nothing new, 1 only on a real failure, so a quiet day
 * doesn't show up as a red build.
 */
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { byId } from "../src/lib/providers/index.js";
import { runCheck } from "../src/lib/run-check.js";
import { SEED } from "../src/data/seed.js";

const FEED_PATH = resolve(process.cwd(), "public/feed.json");
const MAX_ENTRIES = 150;

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
    if (Array.isArray(parsed.items) && parsed.items.length) return parsed;
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
  const { fresh, mode, searched, returned, duplicates, dropped } = await runCheck({
    provider,
    model,
    known: feed.items,
    env: flag("no-search") ? { ...process.env, OLLAMA_API_KEY: "" } : process.env,
  });

  // Print every stage, so a zero-result run says which stage produced the zero.
  if (mode === "injected") console.log(`  searched      ${searched} results`);
  else console.log(`  searched      none (mode: ${mode})`);
  console.log(`  model returned ${returned} entr${returned === 1 ? "y" : "ies"}`);
  if (duplicates) console.log(`  already known  ${duplicates} dropped`);
  if (dropped) console.log(`  unlisted url   ${dropped} dropped`);
  console.log(`  kept          ${fresh.length}`);

  if (fresh.length === 0) {
    const why =
      searched === 0 && mode === "injected"
        ? "search returned nothing — check OLLAMA_API_KEY and the queries in src/lib/search.js"
        : mode === "memory"
          ? "no OLLAMA_API_KEY, so the model answered from memory and was told to prefer []"
          : returned === 0
            ? "the model returned an empty list — it may be too small for the prompt, or genuinely found nothing new since " +
              feed.items.map((i) => i.date).sort().slice(-1)[0]
            : dropped === returned
              ? "every entry cited a url that wasn't in the search results — the model is paraphrasing links"
              : "everything found was already on the wire";
    console.log(`nothing added: ${why}`);
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
