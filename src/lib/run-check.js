/**
 * One check, end to end, in whatever runtime is calling.
 *
 * Three callers share this: the Vite dev proxy, the Node script Actions runs,
 * and the Cloudflare Worker. They differ only in where `env` comes from. Having
 * one implementation is what keeps the site and the cron from drifting into
 * asking different questions.
 *
 * Retrieval strategy is decided here, not by the caller:
 *   provider searches natively  → let it
 *   OLLAMA_API_KEY is present   → we search, and inject the results
 *   neither                     → the model answers from memory, and is told
 *                                 that [] is the right answer when unsure
 */
import { RESPONSE_SCHEMA, buildPrompt, isUnapprovedXPost, normalize, parseArray } from "./check.js";
import { webSearch } from "./search.js";

/**
 * @param {object} opts
 * @param {object} opts.provider
 * @param {string} opts.model
 * @param {Array}  opts.known    entries already on the wire
 * @param {Record<string,string>} opts.env
 * @param {object} [opts.search]  passed through to webSearch (concurrency,
 *                                retries, baseMs, queries, fetchImpl)
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

export async function runCheck({ provider, model, known, env, search = {} }) {
  let results = null;
  let searchFailures = [];
  let mode = provider.supportsSearch ? "native" : "memory";

  if (!provider.supportsSearch && env.OLLAMA_API_KEY) {
    try {
      searchFailures = [];
      results = await webSearch({
        env,
        onQueryFail: (query, message) => searchFailures.push({ query, message }),
        ...search,
      });
      mode = "injected";
    } catch (err) {
      throw new Error(`pre-search failed: ${err.message}`);
    }
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
  const kept = allowed ? fresh.filter((f) => allowed.has(f.url)) : fresh;

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
    returned: raw.length,
    unusable: raw.length - usable.length,
    blocked: offPlatform.length,
    duplicates: usable.length - offPlatform.length - fresh.length,
    dropped: fresh.length - kept.length,
  };
}
