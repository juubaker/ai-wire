/**
 * The whole site in one Worker: static assets, the shared feed, and the
 * scheduled job that rebuilds it.
 *
 * Routes
 *   GET  /api/feed             the current wire as JSON. Public, cached, no key.
 *   POST /api/wire/:provider   run a check now. Requires ADMIN_TOKEN — without
 *                              this gate a public site is an open relay to your
 *                              paid API key.
 *   *                          static assets from ./dist
 *
 * scheduled()                  runs a check on the cron in wrangler.toml and
 *                              writes the merged result back to KV.
 */
import { PROVIDERS, byId } from "../src/lib/providers/index.js";
import { runCheck as runProviderCheck } from "../src/lib/run-check.js";
import { SEED } from "../src/data/seed.js";

const FEED_KEY = "feed:v1";
const MAX_ENTRIES = 150;

const json = (body, init = {}) =>
  new Response(JSON.stringify(body), {
    ...init,
    headers: { "content-type": "application/json", ...(init.headers || {}) },
  });

async function readFeed(env) {
  const raw = await env.WIRE.get(FEED_KEY);
  if (raw) return JSON.parse(raw);
  return { items: SEED, checkedAt: null };
}

/** One check, merged into the stored feed. Used by cron and by the admin route. */
async function runCheck(env, providerId, model) {
  const provider = byId(providerId || env.WIRE_PROVIDER);
  const chosen = model || env.WIRE_MODEL || provider.models[0];
  const feed = await readFeed(env);

  const { fresh, mode, searched } = await runProviderCheck({
    provider,
    model: chosen,
    known: feed.items,
    env,
  });

  const next = {
    items: [...fresh, ...feed.items].slice(0, MAX_ENTRIES),
    checkedAt: Date.now(),
    provider: provider.id,
    model: chosen,
  };
  await env.WIRE.put(FEED_KEY, JSON.stringify(next));
  return { added: fresh.length, total: next.items.length, provider: provider.id, model: chosen, mode, searched };
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/api/feed") {
      const feed = await readFeed(env);
      return json(feed, {
        // Visitors poll this; a short edge cache keeps KV reads well inside the
        // free daily allowance no matter how many tabs are open.
        headers: { "cache-control": "public, max-age=60, s-maxage=60" },
      });
    }

    if (url.pathname.startsWith("/api/wire/")) {
      if (request.method !== "POST") return json({ error: "POST only" }, { status: 405 });
      if (!env.ADMIN_TOKEN || request.headers.get("authorization") !== `Bearer ${env.ADMIN_TOKEN}`) {
        return json({ error: "Not authorised." }, { status: 401 });
      }
      const id = url.pathname.split("/")[3];
      if (!PROVIDERS.some((p) => p.id === id)) return json({ error: `Unknown provider "${id}"` }, { status: 404 });
      try {
        const { model } = await request.json().catch(() => ({}));
        return json(await runCheck(env, id, model));
      } catch (err) {
        return json({ error: String(err.message || err) }, { status: 502 });
      }
    }

    return env.ASSETS.fetch(request);
  },

  /**
   * Cron has no retry: a failure waits for the next firing rather than
   * repeating. That's acceptable here — a missed check just means the wire is
   * one interval staler — so this logs and returns instead of throwing.
   */
  async scheduled(_event, env, ctx) {
    ctx.waitUntil(
      runCheck(env)
        .then((r) => console.log("wire check", JSON.stringify(r)))
        .catch((err) => console.error("wire check failed:", err.message))
    );
  },
};
