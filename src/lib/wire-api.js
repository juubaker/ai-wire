/**
 * Two ways to get new entries, chosen by VITE_WIRE_MODE:
 *
 *   feed   — read the shared feed a scheduled job already built. Visitors cost
 *            nothing, no key is involved, and everyone sees the same wire.
 *            The default in production.
 *   direct — call a model right now through the local proxy. The default in
 *            development, and the mode to use for a private single-user deploy.
 *
 * Both return the same shape, so App.jsx doesn't branch.
 */
import { byId } from "./providers/index.js";

export { TAXONOMY } from "./check.js";

export const MODE =
  import.meta.env.VITE_WIRE_MODE || (import.meta.env.DEV ? "direct" : "feed");

export const isFeedMode = MODE === "feed";

/**
 * Where the prebuilt feed lives. A Worker serves it from /api/feed; GitHub
 * Pages has no server, so there it's a static file emitted next to the app.
 * Relative, so it resolves correctly under a project-pages sub-path.
 */
const FEED_URL = import.meta.env.VITE_FEED_URL || "/api/feed";

async function fromFeed(known) {
  const res = await fetch(FEED_URL, { headers: { accept: "application/json" } });
  if (!res.ok) {
    // Naming the URL matters here: a 404 means the feed isn't where this build
    // was told to look, and the path is the whole diagnosis.
    const where = new URL(FEED_URL, window.location.href).pathname;
    throw new Error(
      res.status === 404
        ? `no feed at ${where} — this build is in feed mode (VITE_WIRE_MODE=${MODE}, VITE_FEED_URL=${FEED_URL})`
        : `feed at ${where} returned HTTP ${res.status}`
    );
  }
  const feed = await res.json();
  const seen = new Set(known.map((i) => i.url + i.title));
  const fresh = (feed.items || []).filter((x) => x.url && !seen.has(x.url + x.title));
  return { fresh, checkedAt: feed.checkedAt || Date.now() };
}

async function fromProvider(known, choice) {
  const provider = byId(choice?.provider);
  const model = choice?.model || provider.models[0];

  // Only the entries the server needs to dedupe against — the prompt itself is
  // assembled server-side, because pre-search needs a key.
  const res = await fetch(`/api/wire/${provider.id}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model,
      known: known.slice(0, 25).map(({ date, source, title, url }) => ({ date, source, title, url })),
    }),
  });

  // A 404 here is the dev proxy not being there at all — a built bundle opened
  // without `vite dev`, say — so it won't be JSON, and parsing it would mask
  // the real cause.
  if (res.status === 404) {
    throw new Error(
      `no endpoint at /api/wire/${provider.id} — direct mode needs the dev server (npm run dev). A built site should run in feed mode.`
    );
  }
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`);
  return { fresh: json.fresh || [], checkedAt: Date.now(), mode: json.mode, searched: json.searched };
}

/**
 * @param {Array} known entries already on the wire
 * @param {{provider: string, model: string}} choice
 * @returns {Promise<{fresh: Array, checkedAt: number}>}
 */
export function fetchUpdates(known, choice) {
  return isFeedMode ? fromFeed(known) : fromProvider(known, choice);
}
