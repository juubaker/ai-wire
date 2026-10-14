/**
 * The check itself: prompt, parse, normalise. No fetch, no DOM, no Node.
 *
 * Shared by two callers that live in different runtimes — the browser during
 * development, and the scheduled worker in production. Keeping it free of both
 * means the site and the cron job can never drift into asking different
 * questions or accepting different answers.
 */
import { JSON_ONLY } from "./providers/provider.js";
import { formatResults } from "./search.js";

/**
 * The three top-level tabs. Every entry belongs to exactly one, assigned by the
 * model. `type` is the finer, model-invented label that filters within a tab.
 */
export const SECTIONS = [
  {
    id: "business",
    label: "AI Business",
    brief: "funding, acquisitions, earnings, regulation, hiring, market moves, company strategy",
  },
  {
    id: "product",
    label: "Product Releases",
    brief:
      "anything shipped and usable today: model releases, API and SDK changes, tooling, pricing, deprecations, protocol and spec revisions",
  },
  {
    id: "innovation",
    label: "Innovations",
    brief:
      "research and new techniques, whether or not shipped: papers, benchmarks, architectures, novel methods, hardware research",
  },
];

/** Used when the model omits a section or invents one we don't recognise. */
const SECTION_BY_TYPE = {
  "Model release": "product",
  "API & tooling": "product",
  Pricing: "product",
  Deprecation: "product",
  Protocol: "product",
  Research: "innovation",
  Industry: "business",
};

export function sectionFor(entry) {
  const given = String(entry.section || "").toLowerCase();
  if (SECTIONS.some((s) => s.id === given)) return given;
  return SECTION_BY_TYPE[entry.type] || "product";
}

export const TAXONOMY = [
  "Model release",
  "API & tooling",
  "Pricing",
  "Deprecation",
  "Protocol",
  "Research",
  "Industry",
];

export function newestDate(known) {
  return known.map((i) => i.date).sort().slice(-1)[0] || "2026-08-01";
}

/**
 * @param {Array} known     entries already on the wire
 * @param {object} provider the selected provider
 * @param {Array} [results] pre-fetched search results; when present the model
 *                          is told to work only from them
 */
export function buildPrompt(known, { supportsSearch }, results = null) {
  const newest = newestDate(known);
  const titles = known
    .slice(0, 25)
    .map((i) => `${i.date} ${i.source}: ${i.title}`)
    .join("\n");

  let sourcing;
  if (results?.length) {
    // Pre-search: retrieval already happened, so the model is a reader, not a
    // researcher. Naming the results as the only permitted source is what stops
    // a local model reaching for a plausible-looking URL from memory.
    sourcing = `Below are live web search results retrieved just now. Work ONLY from them. Every entry you return must use a url that appears verbatim in these results — never write a url that is not listed here, and never adjust one. Ignore results that are not a primary source (model or API docs, official changelogs and release notes, official research blogs, arXiv, SEC filings, the MCP specification), that are older than ${newest}, or that are already on the wire below. If none of the results qualify, return [].

SEARCH RESULTS
${formatResults(results)}`;
  } else if (supportsSearch) {
    sourcing = `Search the web for developments published AFTER ${newest} from primary sources only: model and API docs, official changelogs and release notes, official research blogs (Anthropic, OpenAI, Google DeepMind, Meta AI, Mistral), arXiv, SEC filings, and the MCP specification. Ignore social posts, listicles, and anything without a traceable primary source.`;
  } else {
    sourcing = `You cannot search. List only developments published AFTER ${newest} that you are confident about from your own knowledge, and give the canonical primary-source URL for each: official docs, changelogs, research blogs, or arXiv. If you are unsure a URL is real, omit the entry. Returning [] is the correct answer when you have nothing verifiable.`;
  }

  return `You maintain a changelog wire for a principal engineer who builds LLM systems: RAG, agent orchestration, evals, latency and observability, and the Anthropic/OpenAI/open-model APIs.

${sourcing}

Already on the wire, do not repeat:
${titles}

${JSON_ONLY} Up to 5 objects, each:
{"date":"YYYY-MM-DD","source":"Anthropic|OpenAI|Google|MCP|arXiv 1234.5678|...","tier":"Primary"|"Secondary","section":"exactly one of: ${SECTIONS.map(
    (x) => `${x.id} (${x.brief})`
  ).join(" | ")}","type":"one of: ${TAXONOMY.join(
    ", "
  )} — or a better short label you choose","title":"under 70 chars, specific, version numbers kept","summary":"1-2 sentences on what it changes for someone building LLM systems, not marketing copy","url":"direct link to the announcement or paper","flagged":"omit unless the claim rests only on a vendor's own benchmark, then say so in under 6 words"}

If nothing qualifies, return [].`;
}

/** Models wrap JSON in prose or fences often enough that this stays defensive. */
export function parseArray(text) {
  const cleaned = (text || "").replace(/```json|```/g, "").trim();
  const start = cleaned.indexOf("[");
  const end = cleaned.lastIndexOf("]");
  if (start < 0 || end < start) {
    // Some runtimes in JSON mode return a bare object wrapping the list.
    try {
      const arr = Object.values(JSON.parse(cleaned)).find(Array.isArray);
      return arr || [];
    } catch {
      return [];
    }
  }
  try {
    return JSON.parse(cleaned.slice(start, end + 1));
  } catch {
    return [];
  }
}

/** Drop repeats, coerce the fields the UI relies on, stamp the provider. */
export function normalize(parsed, known, providerId) {
  const stamp = Date.now();
  const seen = new Set(known.map((i) => i.url + i.title));
  return (Array.isArray(parsed) ? parsed : [])
    .filter((x) => x && x.url && x.title && !seen.has(x.url + x.title))
    .map((x, n) => ({
      ...x,
      id: `live-${stamp}-${n}`,
      type: (x.type || "API & tooling").trim(),
      section: sectionFor(x),
      tier: x.tier === "Secondary" ? "Secondary" : "Primary",
      date: /^\d{4}-\d{2}-\d{2}$/.test(x.date || "")
        ? x.date
        : new Date().toISOString().slice(0, 10),
      via: providerId,
    }));
}
