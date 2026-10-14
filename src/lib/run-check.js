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
import { buildPrompt, normalize, parseArray } from "./check.js";
import { webSearch } from "./search.js";

/**
 * @param {object} opts
 * @param {object} opts.provider
 * @param {string} opts.model
 * @param {Array}  opts.known    entries already on the wire
 * @param {Record<string,string>} opts.env
 * @returns {Promise<{fresh: Array, mode: string, searched: number}>}
 */
export async function runCheck({ provider, model, known, env }) {
  let results = null;
  let mode = provider.supportsSearch ? "native" : "memory";

  if (!provider.supportsSearch && env.OLLAMA_API_KEY) {
    try {
      results = await webSearch({ env });
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

  const fresh = normalize(parseArray(provider.extractText(body)), known, provider.id);

  // A local model given search results will still occasionally paraphrase a URL
  // rather than copy it. Anything not traceable to a result is dropped.
  const allowed = results && new Set(results.map((r) => r.url));
  const kept = allowed ? fresh.filter((f) => allowed.has(f.url)) : fresh;

  return {
    fresh: kept,
    mode,
    searched: results?.length ?? 0,
    dropped: fresh.length - kept.length,
  };
}
