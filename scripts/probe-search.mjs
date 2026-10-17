/**
 * One search request, with everything shown.
 *
 * Written because the check reported `HTTP 429` on all 15 queries while a
 * hand-rolled curl to the same endpoint returned 200 — which means the status
 * code alone wasn't enough to tell what differed. This sends exactly what
 * src/lib/search.js sends, reads the key exactly as scripts/check.mjs does,
 * and prints the status, the headers and the body.
 *
 *   node scripts/probe-search.mjs
 *
 * It costs ONE request against the rate limit, on purpose.
 */
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const ENDPOINT = "https://ollama.com/api/web_search";

async function loadEnvLocal() {
  let text;
  try {
    text = await readFile(resolve(process.cwd(), ".env.local"), "utf8");
  } catch {
    return;
  }
  for (const line of text.split("\n")) {
    const m = line.match(/^\s*(?:export\s+)?([A-Z_][A-Z0-9_]*)\s*=\s*(.*)$/i);
    if (!m) continue;
    const value = m[2].trim().replace(/^(['"])(.*)\1$/s, "$2");
    if (process.env[m[1]] === undefined) process.env[m[1]] = value;
  }
}

await loadEnvLocal();
const key = process.env.OLLAMA_API_KEY || "";

// Never print the key. Its shape is enough to tell a parse problem from a
// rate-limit problem: a mangled key usually shows up as a surprising length or
// stray quotes/whitespace that `source` would have stripped but a parser might
// not.
console.log("key present      ", Boolean(key));
console.log("key length       ", key.length);
console.log("key shape        ", key ? `${key.slice(0, 4)}…${key.slice(-4)}` : "(none)");
console.log("has whitespace   ", /\s/.test(key));
console.log("has quotes       ", /['"]/.test(key));
console.log("base url         ", process.env.OLLAMA_BASE_URL || "(unset)");
console.log();

if (!key) {
  console.error("OLLAMA_API_KEY is not set — nothing to probe.");
  process.exit(1);
}

const started = Date.now();
const res = await fetch(ENDPOINT, {
  method: "POST",
  headers: {
    "content-type": "application/json",
    authorization: `Bearer ${key}`,
  },
  body: JSON.stringify({ query: "Anthropic API changelog release notes", max_results: 4 }),
  signal: AbortSignal.timeout(15000),
});

console.log(`HTTP ${res.status} in ${Date.now() - started}ms`);
console.log();
console.log("response headers:");
for (const [k, v] of res.headers) {
  // Anything that might carry a limit, a window or a reset time.
  if (/rate|limit|retry|quota|remaining|reset/i.test(k)) console.log(`  ** ${k}: ${v}`);
  else console.log(`     ${k}: ${v}`);
}
console.log();

const text = await res.text();
console.log("response body:");
console.log(text.slice(0, 1200));
