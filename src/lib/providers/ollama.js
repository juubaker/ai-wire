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
  buildBody: ({ prompt, model, schema }) => ({
    model,
    stream: false,
    // A schema, not the bare "json" flag. `format: "json"` compiles to a
    // grammar that allows an object but not a top-level array, so the model
    // could only ever return one entry however many results it was given.
    format: schema || "json",
    // qwen3 and friends are hybrid reasoning models, and Ollama returns their
    // reasoning in message.thinking — separate from message.content, which is
    // what we parse. Left on, a model can spend the whole num_predict budget
    // thinking about 59 search results and emit no content at all, which
    // surfaces as "returned 0 entries" and looks exactly like a model too
    // small for the job. This job wants extraction, not deliberation.
    think: false,
    // Search results run to thousands of tokens and Ollama's default context
    // would silently truncate them — but context costs memory too, and 32k is
    // what pushes a laptop into CPU offload. Measured: a real 15-query search
    // builds a ~12.1k-token prompt, so 20k covers it plus the 2k reply with
    // ~25% slack for a fuller-than-usual result set. KV cost is ~2.8 GiB.
    // If you widen QUERIES or raise the per-result trim, re-measure: the tell
    // is `task.n_tokens` in llama-server's log.
    // 2000 truncated a real reply mid-JSON: 12 entries of feed-quality summary
    // ran to ~7.5k characters, the parse failed, and the run reported "returned
    // 0" while the model had in fact done the job. Output is the cheap half of
    // the budget — the ~11k-token prompt leaves ample room.
    options: { num_predict: 4000, num_ctx: 20000 },
    messages: [{ role: "user", content: prompt }],
  }),
  extractText: (json) => json?.message?.content || "",
  extractError: (json) => json?.error || null,
};
