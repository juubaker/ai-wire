/**
 * GET /api/feed — the shared wire, on Vercel.
 *
 * Two sources, in order:
 *   1. A KV store, if one is configured. That's what the scheduled check writes
 *      to, so refreshes appear without a redeploy.
 *   2. public/feed.json committed in the repo. GitHub Actions runs the check,
 *      commits the file, and Vercel rebuilds on the push — so this works with
 *      no database and no configuration at all.
 *
 * The endpoint exists either way, which is what the client expects: the same
 * /api/feed path serves on Vercel and on Cloudflare.
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";

const FEED_KEY = "wire:feed:v1";
const FEED_FILE = join(process.cwd(), "public/feed.json");

async function fromKv() {
  if (!process.env.KV_REST_API_URL || !process.env.KV_REST_API_TOKEN) return null;
  const res = await fetch(`${process.env.KV_REST_API_URL}/get/${FEED_KEY}`, {
    headers: { authorization: `Bearer ${process.env.KV_REST_API_TOKEN}` },
  });
  if (!res.ok) return null;
  const body = await res.json();
  return body.result ? JSON.parse(body.result) : null;
}

async function fromFile() {
  return JSON.parse(await readFile(FEED_FILE, "utf8"));
}

export default async function handler(req, res) {
  try {
    const feed = (await fromKv()) || (await fromFile());
    // Short edge cache: visitors poll this, and the feed changes hourly at most.
    res.setHeader("cache-control", "public, s-maxage=60, stale-while-revalidate=300");
    res.status(200).json(feed);
  } catch (err) {
    // An empty feed is a valid state — the app falls back to its seed entries —
    // so a read failure degrades rather than breaking the page.
    res.status(200).json({ items: [], checkedAt: null, degraded: String(err.message) });
  }
}
