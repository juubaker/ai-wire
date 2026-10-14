/**
 * Vercel variant of the scheduled check. Vercel's own cron on Hobby fires at
 * most once a day, so for a tighter cadence trigger this route from GitHub
 * Actions (see .github/workflows/wire-check.yml) or any external scheduler.
 *
 * Both callers must present CRON_SECRET — this route spends money.
 */
import { byId } from "../../src/lib/providers/index.js";
import { runCheck } from "../../src/lib/run-check.js";
import { SEED } from "../../src/data/seed.js";

const FEED_KEY = "wire:feed:v1";
const MAX_ENTRIES = 150;

const kvHeaders = () => ({
  authorization: `Bearer ${process.env.KV_REST_API_TOKEN}`,
  "content-type": "application/json",
});

async function kvGet(key) {
  const r = await fetch(`${process.env.KV_REST_API_URL}/get/${key}`, { headers: kvHeaders() });
  const b = await r.json();
  return b.result ? JSON.parse(b.result) : null;
}

async function kvSet(key, value) {
  await fetch(`${process.env.KV_REST_API_URL}/set/${key}`, {
    method: "POST",
    headers: kvHeaders(),
    body: JSON.stringify(value),
  });
}

export default async function handler(req, res) {
  if (req.headers.authorization !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: "Not authorised." });
  }

  if (!process.env.KV_REST_API_URL) {
    return res.status(501).json({
      error:
        "No KV store configured, so a check here would have nowhere to persist. " +
        "Either add a KV integration, or let GitHub Actions run the check and commit public/feed.json.",
    });
  }

  // No hardcoded fallback: byId() returns the first registered provider.
  const provider = byId(process.env.WIRE_PROVIDER);
  const model = process.env.WIRE_MODEL || provider.models[0];

  try {
    const feed = (await kvGet(FEED_KEY)) || { items: SEED, checkedAt: null };
    const { fresh } = await runCheck({
      provider,
      model,
      known: feed.items,
      env: process.env,
    });

    const next = {
      items: [...fresh, ...feed.items].slice(0, MAX_ENTRIES),
      checkedAt: Date.now(),
      provider: provider.id,
      model,
    };
    await kvSet(FEED_KEY, next);
    res.status(200).json({ added: fresh.length, total: next.items.length });
  } catch (err) {
    res.status(502).json({ error: String(err.message || err) });
  }
}
