/**
 * Vercel variant of GET /api/feed. Reads the feed blob from Upstash Redis
 * (or any KV with an HTTP API — swap the two helpers below).
 *
 * Copy the deploy/vercel/api directory to /api at the project root to use this.
 */
import { SEED } from "../../../src/data/seed.js";

const FEED_KEY = "wire:feed:v1";

async function kvGet(key) {
  const res = await fetch(`${process.env.KV_REST_API_URL}/get/${key}`, {
    headers: { authorization: `Bearer ${process.env.KV_REST_API_TOKEN}` },
  });
  const body = await res.json();
  return body.result ? JSON.parse(body.result) : null;
}

export default async function handler(req, res) {
  try {
    const feed = (await kvGet(FEED_KEY)) || { items: SEED, checkedAt: null };
    res.setHeader("cache-control", "public, s-maxage=60, stale-while-revalidate=300");
    res.status(200).json(feed);
  } catch (err) {
    res.status(200).json({ items: SEED, checkedAt: null, degraded: String(err.message) });
  }
}
