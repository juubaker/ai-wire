/** @type {import("./provider.js").Provider} */
export const google = {
  id: "google",
  label: "Google Gemini",
  docs: "https://ai.google.dev/gemini-api/docs",
  // Flash models are the free-tier eligible line. generateContent remains
  // supported alongside the newer Interactions API.
  models: ["gemini-3.8-flash", "gemini-3.7-flash", "gemini-3.5-flash"],
  supportsSearch: true,
  envKey: "GOOGLE_API_KEY",
  // The model is part of the path, so the proxy substitutes {model} before calling.
  endpoint: () => "https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent",
  headers: (key, env = {}) => ({
    "content-type": "application/json",
    "x-goog-api-key": key,
    ...(env.GOOGLE_PROJECT_ID ? { "x-goog-user-project": env.GOOGLE_PROJECT_ID } : {}),
  }),
  buildBody: ({ prompt, search }) => ({
    contents: [{ role: "user", parts: [{ text: prompt }] }],
    generationConfig: { maxOutputTokens: 2000 },
    ...(search ? { tools: [{ google_search: {} }] } : {}),
  }),
  extractText: (json) =>
    (json.candidates?.[0]?.content?.parts || [])
      .map((p) => p.text || "")
      .join("\n"),
  extractError: (json) => json?.error?.message || null,
};
