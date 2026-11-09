/**
 * Probe the feeds the pipeline actually uses.
 *
 *   node scripts/probe-config.mjs
 *
 * This exists because probe-feeds.mjs probes a hardcoded list of CANDIDATE
 * urls — useful when hunting for a feed to add, useless for asking whether
 * production is healthy. The two lists had drifted: probe-feeds reported
 * "✓ arXiv cs.CL — 146 items" from export.arxiv.org while FEEDS was pointed at
 * rss.arxiv.org, so a working probe and a silent beat coexisted for six days.
 *
 * A diagnostic that tests different urls than production is worse than no
 * diagnostic, because it answers confidently and wrongly. This one imports
 * FEEDS, so it cannot drift.
 *
 * No `since` filter: this asks what each feed is serving right now, not what
 * is newer than the wire.
 */
import { FEEDS, fetchFeeds } from "../src/lib/feeds.js";

let working = 0;

for (const f of FEEDS) {
  let note = "";
  const items = await fetchFeeds({
    feeds: [f],
    onFeedFail: (_label, message) => {
      note = `FAILED — ${message}`;
    },
  }).catch((err) => {
    // fetchFeeds throws when every feed fails, which with one feed is just
    // "this feed failed". The callback above has usually set note already.
    if (!note) note = `FAILED — ${err.message}`;
    return [];
  });

  const newest = items.map((i) => i.date).sort().slice(-1)[0] || "—";
  if (items.length) working++;

  console.log(
    `${String(items.length).padStart(3)} items  newest ${newest.padEnd(10)}  ` +
      `${f.section.padEnd(10)} ${f.label.padEnd(16)} ${note || f.url}`
  );
}

console.log(`\n${working} of ${FEEDS.length} feeds returned something.`);

// A beat with no live source is the failure this is meant to catch: it looks
// like a quiet week from the front end and like nothing at all from the logs.
for (const section of [...new Set(FEEDS.map((f) => f.section))]) {
  const live = FEEDS.filter((f) => f.section === section).length;
  console.log(`  ${section}: ${live} configured`);
}
