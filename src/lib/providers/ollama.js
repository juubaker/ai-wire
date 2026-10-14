/**
 * Anything speaking Ollama's chat API: a local model, or a remote runtime you
 * point OLLAMA_BASE_URL at. The model itself can't reach the web, but with
 * OLLAMA_API_KEY set the check pre-searches and hands results over in the
 * prompt — see src/lib/run-check.js. Without that key it answers from memory
 * and the page says so.
 *
 * @type {import("./provider.js").Provider}
 */
export const ollama = {
  id: "ollama",
  label: "Ollama (local)",
  docs: "https://github.com/ollama/ollama/blob/main/docs/api.md",
  models: ["qwen3:32b", "llama4:16x17b", "mistral-small3.2:24b"],
  supportsSearch: false,
  envKey: "",
  endpoint: (env) => `${env.OLLAMA_BASE_URL || "http://localhost:11434"}/api/chat`,
  headers: () => ({ "content-type": "application/json" }),
  buildBody: ({ prompt, model }) => ({
    model,
    stream: false,
    format: "json",
    // Search results run to thousands of tokens; Ollama's default context is
    // far smaller and would silently truncate them.
    options: { num_predict: 2000, num_ctx: 32000 },
    messages: [{ role: "user", content: prompt }],
  }),
  extractText: (json) => json?.message?.content || "",
  extractError: (json) => json?.error || null,
};
