/** @type {import("./provider.js").Provider} */
export const openai = {
  id: "openai",
  label: "OpenAI",
  docs: "https://developers.openai.com/api/docs/responses",
  models: ["gpt-5.6-sol", "gpt-5.2", "gpt-5-mini"],
  supportsSearch: true,
  envKey: "OPENAI_API_KEY",
  endpoint: () => "https://api.openai.com/v1/responses",
  headers: (key, env = {}) => ({
    "content-type": "application/json",
    authorization: `Bearer ${key}`,
    ...(env.OPENAI_ORG_ID ? { "openai-organization": env.OPENAI_ORG_ID } : {}),
    ...(env.OPENAI_PROJECT_ID ? { "openai-project": env.OPENAI_PROJECT_ID } : {}),
  }),
  buildBody: ({ prompt, model, search }) => ({
    model,
    input: prompt,
    max_output_tokens: 2000,
    ...(search ? { tools: [{ type: "web_search" }] } : {}),
  }),
  extractText: (json) => {
    if (typeof json.output_text === "string") return json.output_text;
    return (json.output || [])
      .filter((item) => item.type === "message")
      .flatMap((item) => item.content || [])
      .filter((c) => c.type === "output_text")
      .map((c) => c.text)
      .join("\n");
  },
  extractError: (json) => json?.error?.message || null,
};
