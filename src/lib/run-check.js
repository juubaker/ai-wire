/**
 * One check, end to end, in whatever runtime is calling.
 *
 * Three callers share this: the Vite dev proxy, the Node script Actions runs,
 * and the Cloudflare Worker. They differ only in where `env` comes from. Having
 * one implementation is what keeps the site and the cron from drifting into
 * asking different questions.
 *
 * Retrieval strategy is decided here, not by the caller:
 *   RSS/Atom feeds              → the default, and the only free one
 *   provider searches natively  → let it
 *   OLLAMA_API_KEY + opt-in     → we search, and inject the results
 *   none of those               → the model answers from memory, and is told
 *                                 that [] is the right answer when unsure
 *
 * Feeds replaced the search API as the default after its free tier turned out
 * to be capped monthly: an hourly schedule needs ~10,800 searches a month,
 * which is two orders of magnitude past what the quota allows. Feeds are free,
 * unmetered, primary by construction, and — the part that matters most —
 * dated, so recency is filtered in code instead of being asked of the model.
 */
import { RESPONSE_SCHEMA, buildPrompt, isUnapprovedXPost, newestDate, normalize, parseArray } from "./check.js";
import { fetchFeeds } from "./feeds.js";
import { webSearch } from "./search.js";

/**
 * @param {object} opts
 * @param {object} opts.provider
 * @param {string} opts.model
 * @param {Array}  opts.known    entries already on the wire
 * @param {Record<string,string>} opts.env
 * @param {object} [opts.search]  passed through to webSearch
 * @param {object} [opts.feeds]   passed through to fetchFeeds
 * @param {boolean} [opts.useSearch]  add the search API on top of the feeds.
 *                                Off by default: it costs a metered quota and
 *                                only the business beat has no feed to use.
 * @returns {Promise<{fresh: Array, mode: string, searched: number}>}
 */
/** Shallow-clone a response for logging, truncating anything long. */
function summarize(value, depth = 0) {
  if (typeof value === "string")
    return value.length > 200 ? `${value.slice(0, 200)}… (${value.length} chars)` : value;
  if (Array.isArray(value)) return depth > 2 ? `[${value.length} items]` : value.map((v) => summarize(v, depth + 1));
  if (value && typeof value === "object") {
    if (depth > 2) return "{…}";
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, summarize(v, depth + 1)]));
  }
  return value;
}

export async function runCheck({
  provider,
  model,
  known,
  env,
  search = {},
  feeds = {},
  useSearch = false,
  /**
   * A hard ceiling on what one run may add.
   *
   * The prompt asks for at most 12 and a run returned 50 — an instruction the
   * model is free to ignore, which by now is a pattern rather than a surprise.
   * Fifty entries in one go also isn't a wire; it's a dump. Enforced here,
   * where it can't be talked out of.
   *
   * Lowered from 12 after a run returned exactly 12 — the cap, filled. A model
   * handed a ceiling treats it as a target, so the ceiling is also the lever:
   * at six it has to choose, and half of what twelve admitted was a CDN range
   * request, a TLD promotion and a regional certification.
   */
  maxEntries = 6,
}) {
  let results = null;
  let searchFailures = [];
  const feedFailures = [];
  let mode = provider.supportsSearch ? "native" : "memory";

  if (!provider.supportsSearch) {
    // Only ask for what the wire doesn't already have. Feed items are dated at
    // the source, so this is a comparison rather than a judgement — the thing
    // search results could never support.
    const since = newestDate(known);

    try {
      results = await fetchFeeds({
        since,
        onFeedFail: (label, message) => feedFailures.push({ query: label, message }),
        ...feeds,
      });
      mode = "feeds";
    } catch (err) {
      throw new Error(`feeds failed: ${err.message}`);
    }

    // Business has no feed anywhere — funding rounds and acquisitions aren't
    // published as one. Search is the only way to cover it, so it stays
    // available, opt-in, and metered.
    if (useSearch && env.OLLAMA_API_KEY) {
      try {
        const found = await webSearch({
          env,
          onQueryFail: (query, message) => searchFailures.push({ query, message }),
          ...search,
        });
        const seen = new Set(results.map((r) => r.url));
        results = [...results, ...found.filter((f) => !seen.has(f.url))];
        mode = "feeds+search";
      } catch (err) {
        // A spent search quota must not sink a run the feeds already covered.
        searchFailures.push({ query: "(all)", message: err.message });
      }
    }
  }

  // Nothing retrieved means nothing to summarise. Asking anyway invites the
  // model to fill the silence: handed zero items it returned twelve invented
  // entries, including an arXiv id that doesn't exist and a date a week in the
  // future. The url guard caught all twelve — but the cheapest hallucination
  // to handle is the one never requested.
  if (results && results.length === 0) {
    return {
      fresh: [],
      mode,
      searched: 0,
      returned: 0,
      unusable: 0,
      blocked: 0,
      duplicates: 0,
      dropped: 0,
      overflow: 0,
      rawText: "",
      rawBody: null,
      searchFailures,
      feedFailures,
      skippedModel: true,
    };
  }

  const key = provider.envKey ? env[provider.envKey] : "";
  if (provider.envKey && !key) throw new Error(`${provider.envKey} is not set.`);

  const url = provider.endpoint(env).replace("{model}", encodeURIComponent(model));
  let res;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: provider.headers(key, env),
      body: JSON.stringify(
        provider.buildBody({
          prompt: buildPrompt(known, provider, results),
          model,
          search: provider.supportsSearch,
          schema: RESPONSE_SCHEMA,
        })
      ),
    });
  } catch (err) {
    const hint = url.includes("localhost")
      ? " Is `ollama serve` running?"
      : "";
    throw new Error(`could not reach ${provider.label} at ${url} — ${err.message}.${hint}`);
  }

  const body = await res.json();
  if (!res.ok) throw new Error(provider.extractError?.(body) || `HTTP ${res.status}`);

  // The funnel is reported stage by stage, because "found nothing" has four
  // very different causes and they need different fixes: the model returned
  // nothing, it returned things already on the wire, it invented urls, or the
  // search came back empty. One number can't tell them apart.
  const text = provider.extractText(body);
  const raw = parseArray(text);
  // normalize() drops two very different things: entries already on the wire,
  // and entries too malformed to use. Reporting them as one number is what had
  // us chasing duplicate detection while the real problem was a parse that
  // produced ["Claude"] — counted as "already known 1 dropped".
  const usable = raw.filter((e) => e && e.url && e.title);
  // Counted separately, because an X post rejected by the account allowlist
  // has a perfectly good url and title and would otherwise be reported as a
  // duplicate — the same conflation that made "already known 1 dropped" mean
  // "malformed" for a day. A stage that drops things needs its own number.
  const offPlatform = usable.filter((e) => isUnapprovedXPost(e.url));
  const fresh = normalize(raw, known, provider.id);

  // A local model given search results will still occasionally paraphrase a URL
  // rather than copy it. Anything not traceable to a result is dropped.
  const allowed = results && new Set(results.map((r) => r.url));
  const withinGuard = allowed ? fresh.filter((f) => allowed.has(f.url)) : fresh;
  // Newest first, so a cap trims the tail rather than an arbitrary slice.
  const ranked = [...withinGuard].sort((a, b) => (a.date === b.date ? 0 : a.date < b.date ? 1 : -1));
  const kept = ranked.slice(0, maxEntries);
  const overflow = ranked.length - kept.length;

  return {
    // Returned so a zero-entry run can show what the model actually said.
    // "returned 0" conflates two very different failures: the model answering
    // [] honestly, and the model answering prose that parseArray quietly
    // turned into []. Only the raw text tells them apart.
    rawText: text,
    // A shallow, truncated view of the provider's own response. When content
    // comes back empty the answer is in the fields around it — Ollama's
    // done_reason ("length" means num_predict ran out) and message.thinking
    // (reasoning that consumed the budget) — and extractText discards both.
    rawBody: summarize(body),
    fresh: kept,
    mode,
    searched: results?.length ?? 0,
    searchFailures,
    feedFailures,
    returned: raw.length,
    unusable: raw.length - usable.length,
    overflow,
    blocked: offPlatform.length,
    duplicates: usable.length - offPlatform.length - fresh.length,
    dropped: fresh.length - kept.length,
  };
}
