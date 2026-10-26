/**
 * Roll the wire back to a date, so a check can be re-run against known material.
 *
 *   node scripts/trim-feed.mjs 2026-10-19   # keep entries on or before that day
 *   node scripts/trim-feed.mjs 2026-10-19 --dry
 *
 * Retrieval asks for items newer than the wire's newest entry, which is the
 * right behaviour and makes testing awkward: once a run lands, the material it
 * drew on is permanently out of reach. Trimming restores it.
 *
 * Writes public/feed.json in place. Reversible with `git checkout` if the feed
 * is committed, so check that before trimming something you can't get back.
 */
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const FEED = resolve(process.cwd(), "public/feed.json");
const cutoff = process.argv[2];
const dry = process.argv.includes("--dry");

if (!/^\d{4}-\d{2}-\d{2}$/.test(cutoff || "")) {
  console.error("usage: node scripts/trim-feed.mjs YYYY-MM-DD [--dry]");
  process.exit(1);
}

const feed = JSON.parse(await readFile(FEED, "utf8"));
const before = feed.items.length;
const keep = feed.items.filter((i) => i.date <= cutoff);
const dropped = feed.items.filter((i) => i.date > cutoff);

console.log(`${before} entries → ${keep.length} (dropping ${dropped.length} after ${cutoff})`);
if (dropped.length) {
  const byDate = new Map();
  for (const d of dropped) byDate.set(d.date, (byDate.get(d.date) || 0) + 1);
  for (const [date, n] of [...byDate].sort()) console.log(`  ${date}  ${n}`);
}
console.log(`newest kept: ${keep.map((i) => i.date).sort().slice(-1)[0] || "(none)"}`);

if (dry) {
  console.log("\n--dry: nothing written");
  process.exit(0);
}
if (!keep.length) {
  console.error("\nrefusing to empty the feed — pick a later date");
  process.exit(1);
}

await writeFile(FEED, `${JSON.stringify({ ...feed, items: keep }, null, 2)}\n`);
console.log("\nwritten. `npm run check` will now look for anything newer.");
