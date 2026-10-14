/** @type {import("./provider.js").Provider} */
export const anthropic = {
  id: "anthropic",
  label: "Anthropic",
  docs: "https://docs.claude.com/en/api/messages",
  models: ["claude-sonnet-4-6", "claude-opus-4-5", "claude-haiku-4-5-20251001"],
  supportsSearch: true,
  envKey: "ANTHROPIC_API_KEY",
  endpoint: () => "https://api.anthropic.com/v1/messages",
  headers: (key, env = {}) => ({
    "content-type": "application/json",
    "x-api-key": key,
    "anthropic-version": "2023-06-01",
    // Identity-linked keys act inside a workspace and the API rejects the
    // request without this. Plain account keys don't send it.
    ...(env.ANTHROPIC_WORKSPACE_ID
      ? { "anthropic-workspace-id": env.ANTHROPIC_WORKSPACE_ID }
      : {}),
  }),
  buildBody: ({ prompt, model, search }) => ({
    model,
    max_tokens: 2000,
    messages: [{ role: "user", content: prompt }],
    ...(search ? { tools: [{ type: "web_search_20250305", name: "web_search" }] } : {}),
  }),
  extractText: (json) =>
    (json.content || [])
      .filter((b) => b.type === "text")
      .map((b) => b.text)
      .join("\n"),
  extractError: (json) => json?.error?.message || null,
};
