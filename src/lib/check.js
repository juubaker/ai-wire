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

/**
 * Model families the wire filters by. `label` is what the chip says; `match`
 * are the strings that identify the family in an entry's own words.
 *
 * Families, not versions: "Claude", not "Claude Opus 5" — a filter with one
 * entry behind it is noise, and someone narrowing to Claude wants every Claude
 * item, not a particular release.
 *
 * Order is roughly by how often the wire's sources mention them.
 */
export const MODEL_FAMILIES = [
  // `match`  — terms that name the family or one of its models, matched on
  //            word boundaries so "sol" can't hit "solution".
  // `vendor` — values of an entry's `source` field that imply the family. An
  //            Anthropic SDK change is a Claude concern even when no model is
  //            named, and `source` is structured, so matching it is safe.
  {
    id: "claude",
    label: "Claude",
    match: ["claude", "opus", "sonnet", "haiku", "fable", "mythos"],
    vendor: ["anthropic"],
  },
  {
    id: "gpt",
    label: "GPT",
    match: ["gpt", "chatgpt", "codex", "sol", "luna", "terra"],
    vendor: ["openai"],
  },
  {
    id: "gemini",
    label: "Gemini",
    match: ["gemini", "nano banana", "veo", "imagen", "lyria"],
    vendor: ["google", "google deepmind"],
  },
  { id: "llama", label: "Llama", match: ["llama"], vendor: [] },
  { id: "muse", label: "Muse", match: ["muse"], vendor: [] },
  { id: "gemma", label: "Gemma", match: ["gemma"], vendor: [] },
  {
    id: "mistral",
    label: "Mistral",
    match: ["mistral", "ministral", "codestral", "voxtral", "magistral"],
    vendor: ["mistral"],
  },
  { id: "qwen", label: "Qwen", match: ["qwen"], vendor: [] },
  { id: "deepseek", label: "DeepSeek", match: ["deepseek"], vendor: ["deepseek"] },
  { id: "kimi", label: "Kimi", match: ["kimi"], vendor: [] },
  { id: "glm", label: "GLM", match: ["glm"], vendor: [] },
  { id: "grok", label: "Grok", match: ["grok"], vendor: ["xai"] },
  { id: "jev", label: "Jev", match: ["jev", "system one"], vendor: ["typesafe ai", "typesafe"] },
  { id: "nova", label: "Nova", match: ["nova"], vendor: [] },
  { id: "phi", label: "Phi", match: ["phi"], vendor: [] },
  { id: "command", label: "Command", match: ["command-r", "command r"], vendor: ["cohere"] },
];

const FAMILY_BY_ID = new Map(MODEL_FAMILIES.map((f) => [f.id, f]));

/** Word-boundary matcher per family, built once. */
const FAMILY_PATTERNS = new Map(
  MODEL_FAMILIES.map((f) => [
    f.id,
    new RegExp(
      `(^|[^a-z0-9])(${f.match.map((m) => m.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})([^a-z0-9]|$)`,
      "i"
    ),
  ])
);

/**
 * Which model families an entry concerns.
 *
 * Takes what the model reported, then falls back to scanning the entry's own
 * text. The fallback is what makes the filter work on entries written before
 * this field existed — and on a local model that ignored the field.
 *
 * An entry can legitimately touch several families (a comparison, a protocol
 * revision landing in three SDKs), and plenty touch none (a funding round, a
 * spec change), which is why this returns an array and never guesses one in.
 */
export function modelsFor(entry) {
  const found = new Set();

  for (const given of Array.isArray(entry.models) ? entry.models : []) {
    const key = String(given).toLowerCase().trim();
    if (FAMILY_BY_ID.has(key)) {
      found.add(key);
    } else {
      // The model may answer with a label ("Claude") or a version
      // ("Claude Opus 5") rather than our id; match it like any other text.
      for (const [id, pattern] of FAMILY_PATTERNS) if (pattern.test(key)) found.add(id);
    }
  }

  const text = [entry.title, entry.summary].filter(Boolean).join(" ");
  for (const [id, pattern] of FAMILY_PATTERNS) if (pattern.test(text)) found.add(id);

  // The vendor's name counts wherever it appears, not just in `source`. A
  // funding story carried by a third party has the company in its title and
  // the outlet in its source, and someone filtering a family wants that story.
  const haystack = `${text} ${entry.source || ""}`.toLowerCase();
  for (const family of MODEL_FAMILIES) {
    if (family.vendor.some((v) => haystack.includes(v))) found.add(family.id);
  }

  return [...found];
}

export const familyLabel = (id) => FAMILY_BY_ID.get(id)?.label || id;

export function newestDate(known) {
  return known.map((i) => i.date).sort().slice(-1)[0] || "2026-08-01";
}

/**
 * @param {Array} known     entries already on the wire
 * @param {object} provider the selected provider
 * @param {Array} [results] pre-fetched search results; when present the model
 *                          is told to work only from them
 */
/**
 * A JSON schema for the response, for runtimes that accept one.
 *
 * Ollama's `format: "json"` compiles to a grammar that permits a JSON *object*
 * but not a top-level array — so however firmly the prompt says "return an
 * array", the grammar wins and the model emits one entry. That capped every
 * run at a single entry regardless of model size or how many results we fed
 * it, which is why qwen3:8b and qwen3:14b returned identically.
 *
 * Wrapping the list in an object sidesteps it, and the enums fix a second
 * symptom: the model was putting the section value ("product") in `tier`,
 * where normalize() quietly defaulted it to Primary.
 */
export const RESPONSE_SCHEMA = {
  type: "object",
  properties: {
    entries: {
      type: "array",
      items: {
        type: "object",
        properties: {
          date: { type: "string" },
          source: { type: "string" },
          tier: { type: "string", enum: ["Primary", "Secondary"] },
          section: { type: "string", enum: SECTIONS.map((x) => x.id) },
          type: { type: "string" },
          models: { type: "array", items: { type: "string" } },
          title: { type: "string" },
          summary: { type: "string" },
          url: { type: "string" },
          flagged: { type: "string" },
        },
        required: ["date", "source", "tier", "section", "title", "summary", "url"],
      },
    },
  },
  required: ["entries"],
};

export function buildPrompt(known, { supportsSearch }, results = null) {
  const newest = newestDate(known);
  const today = new Date().toISOString().slice(0, 10);
  const titles = known
    .slice(0, 25)
    .map((i) => `${i.date} ${i.source}: ${i.title}`)
    .join("\n");

  let sourcing;
  if (results?.length) {
    // Pre-search: retrieval already happened, so the model is a reader, not a
    // researcher. Naming the results as the only permitted source is what stops
    // a local model reaching for a plausible-looking URL from memory.
    // No date filter here, deliberately. The search API returns only title,
    // url and content — no publication date — so asking the model to drop
    // results "older than ${newest}" asks it to filter on a field it cannot
    // see. A careful model responds to an unanswerable constraint by returning
    // nothing, which is exactly what it did: 59 results in, 1 entry out.
    // Repeats are handled downstream instead, where it's a certainty rather
    // than a guess: normalize() drops any entry whose url is already on the
    // wire. The model's job is to spot what's notable; ours is to dedupe.
    sourcing = `Below are live web search results retrieved just now. Work ONLY from them. Every entry you return must use a url that appears verbatim in these results — never write a url that is not listed here, and never adjust one.

Report each result that is a genuine development a working engineer would want to know about, from a primary source: model or API docs, official changelogs and release notes, official research blogs, arXiv, SEC filings, company press releases, the MCP specification. Prefer the announcement itself over coverage of it.

Skip a result when it is: a documentation landing page, index or FAQ rather than a specific announcement; a paper or release from before this year; an aggregator, listicle or newsletter roundup; or already on the wire listed below. If genuinely none of the results qualify, return [].

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

${JSON_ONLY} Up to 12 objects, each:
{"date":"YYYY-MM-DD","source":"Anthropic|OpenAI|Google|MCP|arXiv 1234.5678|...","tier":"Primary"|"Secondary","section":"exactly one of: ${SECTIONS.map(
    (x) => `${x.id} (${x.brief})`
  ).join(" | ")}","type":"one of: ${TAXONOMY.join(
    ", "
  )} — or a better short label you choose","models":["model FAMILIES this concerns, from: ${MODEL_FAMILIES.map(
    (f) => f.label
  ).join(", ")} — the family, never the version, so \\"Claude\\" not \\"Claude Opus 5\\"; several if it concerns several; [] for anything model-agnostic like a protocol change, a funding round, or a paper about no particular model"],"title":"under 70 chars, specific, version numbers kept","summary":"1-2 sentences on what it changes for someone building LLM systems, not marketing copy","url":"direct link to the announcement or paper","flagged":"omit unless the claim rests only on a vendor's own benchmark, then say so in under 6 words"}

Cover the whole list, not just the first few results. The results are
interleaved across topics on purpose: product releases, business moves
(funding, acquisitions, regulation, compute deals) and research all appear
throughout. Work to the end before you stop.

Field notes, which are instructions and must never appear in a value:
- date: the publication date if the result itself states one, otherwise ${today}. Never guess a date and never copy this sentence into the field.
- tier: "Primary" for the announcement, docs, changelog or paper itself; "Secondary" for reporting about it. It is never a section name.
- section: exactly one of the ids listed above.

If nothing qualifies, return an empty list.`;
}

/** Models wrap JSON in prose or fences often enough that this stays defensive. */
export function parseArray(text) {
  const cleaned = (text || "").replace(/```json|```/g, "").trim();

  // Parse the WHOLE payload before looking for brackets. The previous version
  // scanned for the first "[" and the last "]", which on a bare entry object
  // sliced out the first nested array it found — "models":["Claude"] — and
  // returned that as the entry list. One array of one string, which normalize()
  // then dropped for having no url, reported as "already known 1 dropped".
  // Every zero-entry run we diagnosed was this.
  const whole = (() => {
    try {
      return JSON.parse(cleaned);
    } catch {
      return undefined;
    }
  })();

  // Only ever hand back entry objects. A top-level array of strings is not an
  // entry list, and letting it through just defers the confusion to normalize().
  if (Array.isArray(whole)) return whole.filter((x) => x && typeof x === "object");

  if (whole && typeof whole === "object") {
    // JSON mode often wraps the list: {"entries": [...]}. Require the members
    // to be objects, so a stray string array like "models" can't pose as one.
    const wrapped = Object.values(whole).find(
      (v) => Array.isArray(v) && v.length > 0 && v.every((x) => x && typeof x === "object")
    );
    if (wrapped) return wrapped;
    // A single entry, unwrapped — what Ollama's `format: "json"` produces,
    // since that grammar permits an object but not a top-level array.
    if (whole.url || whole.title) return [whole];
    return [];
  }

  // Fall back to slicing only for output with prose wrapped around real JSON.
  const start = cleaned.indexOf("[");
  const end = cleaned.lastIndexOf("]");
  if (start < 0 || end < start) return [];
  try {
    const sliced = JSON.parse(cleaned.slice(start, end + 1));
    return Array.isArray(sliced) ? sliced.filter((x) => x && typeof x === "object") : [];
  } catch {
    return [];
  }
}

/** Drop repeats, coerce the fields the UI relies on, stamp the provider. */
/**
 * The URL is an entry's identity. Nothing else is stable.
 *
 * Dedupe used to key on `url + title`, but the title is model-written prose
 * that varies between runs — so the same announcement came back with a
 * reworded headline and sailed through as new. Trailing slashes, #fragments
 * and utm_* parameters vary for the same reason.
 */
export function canonicalUrl(url) {
  try {
    const u = new URL(String(url));
    u.hash = "";
    for (const key of [...u.searchParams.keys()]) {
      if (/^(utm_|ref$|source$|fbclid$|gclid$)/i.test(key)) u.searchParams.delete(key);
    }
    const path = u.pathname.replace(/\/+$/, "") || "/";
    return `${u.protocol}//${u.host.toLowerCase()}${path}${u.search}`.toLowerCase();
  } catch {
    return String(url || "").trim().toLowerCase();
  }
}

export function normalize(parsed, known, providerId) {
  const stamp = Date.now();
  const seen = new Set(known.map((i) => canonicalUrl(i.url)));
  const out = [];

  for (const x of Array.isArray(parsed) ? parsed : []) {
    if (!x || !x.url || !x.title) continue;
    const key = canonicalUrl(x.url);
    // Add as we go. The previous version built `seen` once from `known` and
    // never updated it, so a model that listed the same release twice in one
    // response got it onto the wire twice — which it did.
    if (seen.has(key)) continue;
    seen.add(key);

    out.push({
      ...x,
      id: `live-${stamp}-${out.length}`,
      type: (x.type || "API & tooling").trim(),
      section: sectionFor(x),
      models: modelsFor(x),
      tier: x.tier === "Secondary" ? "Secondary" : "Primary",
      date: /^\d{4}-\d{2}-\d{2}$/.test(x.date || "")
        ? x.date
        : new Date().toISOString().slice(0, 10),
      via: providerId,
    });
  }
  return out;
}
