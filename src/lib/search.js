/**
 * Pre-search: we do the retrieval, the model does the reading.
 *
 * A local model can't reach the web, and grounded search on the hosted
 * providers is either paid or rate-limited. So instead of asking the model to
 * search, we run the queries ourselves against Ollama's web search API and hand
 * the results over in the prompt. The model's job shrinks to summarising and
 * classifying what it's given, which is the part it's actually good at.
 *
 * Free with an Ollama account: https://ollama.com/settings/keys
 */

const ENDPOINT = "https://ollama.com/api/web_search";

/**
 * What to look for. Deliberately source-shaped rather than topic-shaped — the
 * wire's editorial rule is primary sources, so the queries name them.
 *
 * Grouped by the section each is meant to feed, because the first version of
 * this list was all changelogs: every result came back `product`, and the
 * Business and Innovations tabs stayed frozen however often the check ran.
 * Retrieval has to cover the taxonomy, or the taxonomy is decorative.
 *
 * If you add a section to SECTIONS, add queries for it here too.
 */

/** product — what shipped and is usable today. */
const PRODUCT_QUERIES = [
  "Anthropic API changelog release notes",
  "OpenAI API changelog deprecations",
  "Google Gemini API changelog",
  "Model Context Protocol specification changelog",
  // Jev ships as versioned aliases (jev-latest → jev-1.13.0), so a bump in the
  // docs is the changelog. The gateway query is an early-warning net: Jev
  // reached Vercel, Cloudflare, OpenRouter and Portkey within weeks of launch,
  // and each announces independently of TypeSafe.
  "TypeSafe AI Jev docs changelog",
  "Jev model release jev-latest version",
  "Vercel AI Gateway Cloudflare Workers AI new model",
];

/** business — funding, acquisitions, regulation, market moves. */
const BUSINESS_QUERIES = [
  "AI startup funding round acquisition this week",
  "AI company acquisition announcement",
  "EU AI Act enforcement AI regulation developers",
  "AI lab earnings compute deal datacenter investment",
];

/** innovation — research and new technique, shipped or not. */
const INNOVATION_QUERIES = [
  "arXiv LLM agent context management paper",
  "arXiv retrieval augmented generation new method",
  "new LLM benchmark evaluation results agents",
  "AI research breakthrough paper architecture efficiency",
];

export const QUERIES = [...PRODUCT_QUERIES, ...BUSINESS_QUERIES, ...INNOVATION_QUERIES];

/** Snippets run long; this keeps the assembled prompt inside a sane context. */
const MAX_CHARS_PER_RESULT = 600;
const MAX_RESULTS_PER_QUERY = 4;

/**
 * @param {object} opts
 * @param {Record<string,string>} opts.env  must carry OLLAMA_API_KEY
 * @param {string[]} [opts.queries]
 * @returns {Promise<Array<{title: string, url: string, content: string, query: string}>>}
 */
export async function webSearch({ env, queries = QUERIES }) {
  const key = env.OLLAMA_API_KEY;
  if (!key) {
    throw new Error(
      "OLLAMA_API_KEY is not set. Create a free key at https://ollama.com/settings/keys — " +
        "it's what lets the check reach the web without a paid model."
    );
  }

  const settled = await Promise.allSettled(
    queries.map(async (query) => {
      let res;
      try {
        res = await fetch(ENDPOINT, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${key}`,
          },
          body: JSON.stringify({ query, max_results: MAX_RESULTS_PER_QUERY }),
        });
      } catch (err) {
        // Node's bare "fetch failed" says nothing about which host was
        // unreachable, which is the only thing you need to know here.
        throw new Error(`could not reach ${ENDPOINT} — ${err.message}`);
      }
      if (!res.ok) {
        const detail = res.status === 401 ? " (check OLLAMA_API_KEY)" : "";
        throw new Error(`"${query}" → HTTP ${res.status}${detail}`);
      }
      const body = await res.json();
      return (body.results || []).map((r) => ({
        title: r.title || "",
        url: r.url || "",
        content: (r.content || "").slice(0, MAX_CHARS_PER_RESULT),
        query,
      }));
    })
  );

  // One dead query shouldn't sink the whole check — take what came back.
  const failures = settled.filter((s) => s.status === "rejected");
  if (failures.length === settled.length) {
    throw new Error(`every search failed: ${failures[0].reason?.message || "unknown"}`);
  }

  const seen = new Set();
  return settled
    .filter((s) => s.status === "fulfilled")
    .flatMap((s) => s.value)
    .filter((r) => r.url && !seen.has(r.url) && seen.add(r.url));
}

/** Rendered into the prompt. Numbered so the model can't invent a source. */
export function formatResults(results) {
  return results
    .map((r, n) => `[${n + 1}] ${r.title}\n    ${r.url}\n    ${r.content.replace(/\s+/g, " ")}`)
    .join("\n\n");
}
