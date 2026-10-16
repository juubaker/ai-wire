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
  // Smallest first, deliberately. This job is summarising search results into
  // JSON — it does not need a frontier model, and the previous default
  // (qwen3:32b, 18.8 GiB) spilled half its layers to CPU on an 18 GiB laptop
  // and took minutes per run. Rough footprints: 8b ~5 GiB, 14b ~9 GiB,
  // 32b ~19 GiB. Pick one that fits your GPU with the context below to spare.
  models: ["qwen3:8b", "qwen3:14b", "qwen3:32b"],
  supportsSearch: false,
  envKey: "",
  endpoint: (env) => `${env.OLLAMA_BASE_URL || "http://localhost:11434"}/api/chat`,
  // A local daemon needs no auth, but a hosted runtime does — and a CI runner
  // has no GPU, so the scheduled check has to point at one. Without this the
  // cron 401s on every run, silently, forever.
  headers: (_key, env = {}) => ({
    "content-type": "application/json",
    ...(env.OLLAMA_API_KEY ? { authorization: `Bearer ${env.OLLAMA_API_KEY}` } : {}),
  }),
  buildBody: ({ prompt, model }) => ({
    model,
    stream: false,
    format: "json",
    // Search results run to thousands of tokens and Ollama's default context
    // would silently truncate them — but context costs memory too, and 32k on
    // a large model is what pushes a laptop into CPU offload. The worst-case
    // prompt measures ~11k tokens, so 16k leaves headroom for the 2k reply
    // at half the footprint.
    options: { num_predict: 2000, num_ctx: 16000 },
    messages: [{ role: "user", content: prompt }],
  }),
  extractText: (json) => json?.message?.content || "",
  extractError: (json) => json?.error || null,
};
