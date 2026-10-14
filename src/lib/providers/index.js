import { google } from "./google.js";
import { ollama } from "./ollama.js";

// import { anthropic } from "./anthropic.js";
// import { openai } from "./openai.js";

/**
 * Order here is the order in the picker. First entry is the default.
 *
 * Ollama first: with OLLAMA_API_KEY set, the check pre-searches and injects the
 * results, so a free local model gets real, current sources. Google stays
 * registered in case you add billing later and want native grounding.
 *
 * The remaining hosted providers are still on disk and still conform to the
 * contract; re-enable one by uncommenting its import and adding it here.
 */
export const PROVIDERS = [ollama, google];

export const byId = (id) => PROVIDERS.find((p) => p.id === id) || PROVIDERS[0];

export const DEFAULT_PROVIDER = PROVIDERS[0].id;
