/**
 * Vercel variant of the scheduled check. Vercel's own cron on Hobby fires at
 * most once a day, so for a tighter cadence trigger this route from GitHub
 * Actions (see .github/workflows/wire-check.yml) or any external scheduler.
 *
 * Both callers must present CRON_SECRET — this route spends money.
 */
import { byId } from "../../../../src/lib/providers/index.js";
import { buildPrompt, normalize, parseArray } from "../../../../src/lib/check.js";
import { SEED } from "../../../../src/data/seed.js";

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

  const provider = byId(process.env.WIRE_PROVIDER || "anthropic");
  const model = process.env.WIRE_MODEL || provider.models[0];
  const key = provider.envKey ? process.env[provider.envKey] : "";

  try {
    const feed = (await kvGet(FEED_KEY)) || { items: SEED, checkedAt: null };
    const url = provider.endpoint(process.env).replace("{model}", encodeURIComponent(model));
    const upstream = await fetch(url, {
      method: "POST",
      headers: provider.headers(key, process.env),
      body: JSON.stringify(
        provider.buildBody({
          prompt: buildPrompt(feed.items, provider),
          model,
          search: provider.supportsSearch,
        })
      ),
    });
    const body = await upstream.json();
    if (!upstream.ok) throw new Error(provider.extractError?.(body) || `HTTP ${upstream.status}`);

    const fresh = normalize(parseArray(provider.extractText(body)), feed.items, provider.id);
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
