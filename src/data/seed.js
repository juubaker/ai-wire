/**
 * The entries the wire starts with, newest first: vendor changelogs through
 * Oct 15 2026, back to the Aug 13-27 briefing the wire began as.
 *
 * Anything the update check finds is merged in front of these and saved
 * locally. Entries here are hand-written from primary sources; `npm run check`
 * is what keeps the wire current from here.
 */
export const SEED = [
  // ── Anthropic ────────────────────────────────────────────────────────
  {
    id: "anthropic-otel",
    date: "2026-10-14", source: "Anthropic", tier: "Primary",
    type: "API & tooling", section: "product", models: ["claude"],
    title: "OpenTelemetry export for Messages and Managed Agents",
    summary:
      "Beta. The Python, TypeScript, C#, Go, Java, PHP and Ruby SDKs emit spans for Messages API requests and Managed Agents sessions, so traces land in whatever collector you already run instead of a vendor console.",
    url: "https://platform.claude.com/docs/en/release-notes/overview",
  },
  {
    id: "anthropic-dynamic-workflows",
    date: "2026-10-09", source: "Anthropic", tier: "Primary",
    type: "API & tooling", section: "product", models: ["claude"],
    title: "Managed Agents dynamic workflows",
    summary:
      "Beta. An agent writes a program that runs many agents in phases and the server executes it as a workflow run, followed through workflow_run.* events. Orchestration moves server-side rather than living in your loop.",
    url: "https://platform.claude.com/docs/en/release-notes/overview",
  },
  {
    id: "anthropic-haiku-55",
    date: "2026-10-07", source: "Anthropic", tier: "Primary",
    type: "Model release", section: "product", models: ["claude"],
    title: "Claude Haiku 5.5 — 1M context, 128k output",
    summary:
      "Adaptive thinking on a Haiku. Breaking: budget_tokens, sampling parameters and assistant prefill now return 400, so Haiku 4.5 code needs changes. Sonnet 5.5 cache reads halved to $0.10/MTok the same day.",
    url: "https://platform.claude.com/docs/en/release-notes/overview",
  },
  {
    id: "anthropic-sonnet-55",
    date: "2026-09-28", source: "Anthropic", tier: "Primary",
    type: "Model release", section: "product", models: ["claude"],
    title: "Claude Sonnet 5.5 — five breaking changes",
    summary:
      'thinking: {"type": "between_tools"} replaces "disabled", forced tool use returns 400, and thinking blocks are now bound to the account that produced them. Read the migration notes before bumping the model id.',
    url: "https://platform.claude.com/docs/en/release-notes/overview",
  },
  {
    id: "anthropic-opus-55",
    date: "2026-09-22", source: "Anthropic", tier: "Primary",
    type: "Model release", section: "product", models: ["claude"],
    title: "Claude Opus 5.5 at $4 / $20 per MTok",
    summary:
      "Down from Opus 5's $5/$25. Thinking can't be disabled at all, and tool_choice 'any' and 'tool' return 400 — the forced-tool-use pattern is gone on this line.",
    url: "https://platform.claude.com/docs/en/release-notes/overview",
  },
  {
    id: "anthropic-sonnet-45-eol",
    date: "2026-09-30", source: "Anthropic", tier: "Primary",
    type: "Deprecation", section: "product", models: ["claude"],
    title: "Sonnet 4.5 retires November 30, 2026",
    summary:
      "Deprecation announced. Anything still pinning that dated id has roughly six weeks. Admin API methods also left beta and moved under client.organization.",
    url: "https://platform.claude.com/docs/en/release-notes/overview",
  },
  {
    id: "anthropic-compaction",
    date: "2026-09-14", source: "Anthropic", tier: "Primary",
    type: "API & tooling", section: "product", models: ["claude"],
    title: "On-demand conversation compaction",
    summary:
      "Beta, header compact-2026-09-04. Server-side compaction you trigger rather than a policy that runs on its own — the lever you want if you've been hand-rolling context trimming in a long agent loop.",
    url: "https://platform.claude.com/docs/en/release-notes/overview",
  },

  // ── OpenAI ───────────────────────────────────────────────────────────
  {
    id: "openai-decisions-api",
    date: "2026-10-06", source: "OpenAI", tier: "Primary",
    type: "API & tooling", section: "product", models: ["gpt", "jev"],
    title: "Decisions API beta — typed answers from gpt-6-luna",
    summary:
      "Text and images in, a typed answer out. The same shape TypeSafe's Jev launched on three weeks earlier, now from OpenAI on a general-purpose model rather than a dedicated one.",
    url: "https://developers.openai.com/api/docs/changelog",
  },
  {
    id: "openai-gpt61-sol",
    date: "2026-09-29", source: "OpenAI", tier: "Primary",
    type: "Model release", section: "product", models: ["gpt"],
    title: "GPT-6.1 Sol, plus computer use in the Agents API",
    summary:
      "Aimed at complex coding below GPT-6 Astra's cost, with multi-agent delegation in beta. Computer use also landed in the Agents API, running in an OpenAI-hosted browser your app approves access for.",
    url: "https://developers.openai.com/api/docs/changelog",
  },
  {
    id: "openai-agents-api",
    date: "2026-09-10", source: "OpenAI", tier: "Primary",
    type: "API & tooling", section: "product", models: ["gpt", "claude"],
    title: "Agents API in public beta",
    summary:
      "Managed sessions, sandboxes and MCP server support — the server-side agent runtime, directly comparable to Anthropic's Managed Agents. GPT-Live 1 also went GA at $0.05/minute for full-duplex voice.",
    url: "https://developers.openai.com/api/docs/changelog",
  },
  {
    id: "openai-astra",
    date: "2026-09-03", source: "OpenAI", tier: "Primary",
    type: "Model release", section: "product", models: ["gpt"],
    title: "GPT-6 Astra, with async tool calling and mid-turn steering",
    summary:
      "Reasoning effort can change mid-conversation and tool calls can run async, with steering over WebSockets. Migration notes cover unsupported reasoning effort, sampling settings and stricter tool-calling requirements.",
    url: "https://developers.openai.com/api/docs/changelog",
  },
  {
    id: "openai-error-split",
    date: "2026-09-02", source: "OpenAI", tier: "Primary",
    type: "API & tooling", section: "product", models: ["gpt"],
    title: "Rate-limit and overload errors split apart",
    summary:
      "A traffic spike now returns 429 with slow_down; temporary capacity trouble returns 503 with server_is_overloaded. Worth separating in your retry policy — they want different backoff.",
    url: "https://developers.openai.com/api/docs/changelog",
  },

  // ── Google ───────────────────────────────────────────────────────────
  {
    id: "google-gemini-4-argon",
    date: "2026-10-13", source: "Google", tier: "Primary",
    type: "Model release", section: "product", models: ["gemini"],
    title: "Gemini 4 Argon GA",
    summary:
      "First of the Gemini 4 line to reach general availability, aimed at complex coding, agentic work, maths and science.",
    url: "https://ai.google.dev/gemini-api/docs/changelog",
  },
  {
    id: "google-flash-deprecations",
    date: "2026-10-08", source: "Google", tier: "Primary",
    type: "Deprecation", section: "product", models: ["gemini"],
    title: "Gemini 3.7 and 3.5 Flash deprecated, auto-routed",
    summary:
      "Requests silently route to 3.8 Flash and 3.6 Flash rather than failing — convenient, but your evals are now running against a different model than the id says. Deep Research deep-research-pro-preview-12-2025 shuts down October 23.",
    url: "https://ai.google.dev/gemini-api/docs/changelog",
  },
  {
    id: "google-agentic-video",
    date: "2026-09-01", source: "Google", tier: "Primary",
    type: "API & tooling", section: "product", models: ["gemini"],
    title: "Agentic video understanding — up to 88% fewer tokens",
    summary:
      "The model requests transcripts, frames or audio on demand instead of ingesting everything up front. Google's figure, on long-form content; the retrieval-on-demand pattern is the interesting part.",
    url: "https://ai.google.dev/gemini-api/docs/changelog",
    flagged: "Vendor benchmark only",
  },
  {
    id: "typesafe-jev-launch",
    date: "2026-09-15",
    source: "TypeSafe AI",
    tier: "Primary",
    type: "Model release",
    section: "product",
    models: ["jev"],
    title: "Jev: a model that decides instead of writing",
    summary:
      "TypeSafe AI's first 'System One' model returns a typed choice, score or boolean with a calibrated confidence, never text. Constrained output means it can't break your schema — but it can be confident and still pick the wrong valid option.",
    url: "https://docs.typesafe.ai",
    flagged: "Vendor benchmark only",
  },
  {
    id: "anthropic-browser-use",
    date: "2026-08-19",
    source: "Anthropic",
    tier: "Primary",
    type: "API & tooling",
    section: "product",
    title: "Computer use leaves beta; browser use ships",
    summary:
      "computer_toolset_20260801 adds batch actions and default zoom. The new browser_toolset_20260801 drives a browser your app hosts, reading the accessibility tree instead of screenshots alone.",
    url: "https://docs.claude.com/en/release-notes/overview.md",
  },
  {
    id: "anthropic-files-skills-ga",
    date: "2026-08-19",
    source: "Anthropic",
    tier: "Primary",
    type: "API & tooling",
    section: "product",
    title: "Files API and Skills API out of beta",
    summary:
      "Drop the files-api-2025-04-14 and skills-2025-10-02 headers. The Console session viewer picks up a timeline minimap, per-model-request transcript, and per-tool cost stats.",
    url: "https://docs.claude.com/en/release-notes/overview.md",
  },
  {
    id: "anthropic-python-sdk-1",
    date: "2026-08-20",
    source: "Anthropic",
    tier: "Primary",
    type: "API & tooling",
    section: "product",
    title: "Python SDK v1.0 — breaking",
    summary:
      "httpx moves to httpx2, Python 3.10+ required, legacy Text Completions gone, temperature/top_p/top_k removed from Messages, AnthropicBedrock no longer defaults to us-east-1.",
    url: "https://docs.claude.com/en/release-notes/overview.md",
  },
  {
    id: "anthropic-sonnet5-price",
    date: "2026-08-10",
    source: "Anthropic",
    tier: "Primary",
    type: "Pricing",
    section: "product",
    title: "Sonnet 5 stays at $2 / $10 per MTok",
    summary:
      "The increase to $3 / $15 scheduled for September 1 will not happen. Introductory pricing is now the standard price.",
    url: "https://docs.claude.com/en/release-notes/overview.md",
  },
  {
    id: "anthropic-opus41-retired",
    date: "2026-08-05",
    source: "Anthropic",
    tier: "Primary",
    type: "Deprecation",
    section: "product",
    title: "claude-opus-4-1-20250805 retired",
    summary:
      "Requests to the dated Opus 4.1 ID now hard-error rather than degrade. Opus 5 is the migration target.",
    url: "https://docs.claude.com/en/release-notes/overview.md",
  },
  {
    id: "openai-sol-price-cut",
    date: "2026-08-21",
    source: "OpenAI",
    tier: "Primary",
    type: "Pricing",
    section: "product",
    title: "GPT-5.6 Sol cut over 20% for three months",
    summary:
      "API and credit pricing only, and explicitly temporary. Worth testing against, not worth rebuilding routing economics around.",
    url: "https://openai.com/index/gpt-5-6/",
  },
  {
    id: "openai-assistants-removed",
    date: "2026-08-26",
    source: "OpenAI",
    tier: "Primary",
    type: "Deprecation",
    section: "product",
    title: "Assistants API removed",
    summary:
      "One year after notice, the endpoint is gone; Responses plus Conversations is the path. Older GPT-5 and o3 snapshots follow on December 11.",
    url: "https://developers.openai.com/api/docs/deprecations",
  },
  {
    id: "google-transcribe-ga",
    date: "2026-08-26",
    source: "Google",
    tier: "Primary",
    type: "Model release",
    section: "product",
    title: "Gemini 3.5 Transcribe and Transcribe Live GA",
    summary:
      "Diarization, word-level timestamps, and vocabulary biasing up to 1,000 terms. The Live variant streams over WebSockets with configurable VAD.",
    url: "https://ai.google.dev/gemini-api/docs/changelog",
  },
  {
    id: "google-37-flash",
    date: "2026-08-13",
    source: "Google",
    tier: "Primary",
    type: "Model release",
    section: "product",
    title: "Gemini 3.7 Flash GA",
    summary:
      "Positioned at coding and agentic work, at introductory pricing through December 31, 2026.",
    url: "https://ai.google.dev/gemini-api/docs/changelog",
  },
  {
    id: "google-sampling-deprecated",
    date: "2026-07-21",
    source: "Google",
    tier: "Primary",
    type: "Deprecation",
    section: "product",
    title: "temperature, top_p and top_k deprecated on Gemini",
    summary:
      "The second vendor this quarter to retire the sampling knobs. If your eval harness sweeps temperature, that dimension is disappearing.",
    url: "https://ai.google.dev/gemini-api/docs/changelog",
  },
  {
    id: "mcp-stateless",
    date: "2026-07-28",
    source: "MCP",
    tier: "Primary",
    type: "Protocol",
    section: "product",
    title: "MCP 2026-07-28 final: the protocol goes stateless",
    summary:
      "No Mcp-Session-Id, no initialize handshake, tools/list cacheable via ttlMs, cross-call state as server-minted handles. Roots, Sampling and Logging deprecated on a 12-month floor.",
    url: "https://modelcontextprotocol.io/specification/2026-07-28/changelog",
  },
  {
    id: "arxiv-vista",
    date: "2026-07-23",
    source: "arXiv 2606.30005",
    tier: "Primary",
    type: "Research",
    section: "innovation",
    title: "VISTA: agents as their own context managers",
    summary:
      "Training-free, model-agnostic layer giving typed, addressable context blocks with archival and recovery. Drops over an existing agent loop.",
    url: "https://arxiv.org/abs/2606.30005",
  },
  {
    id: "arxiv-tokenpilot",
    date: "2026-06-20",
    source: "arXiv 2606.17016",
    tier: "Primary",
    type: "Research",
    section: "innovation",
    title: "TokenPilot: compaction that keeps the prefix cache",
    summary:
      "Cache-efficient context management. Read it if you suspect your compaction step is quietly destroying cache hit rate.",
    url: "https://arxiv.org/pdf/2606.17016",
  },
  {
    id: "arxiv-smoothagent",
    date: "2026-07-01",
    source: "arXiv 2607.00151",
    tier: "Primary",
    type: "Research",
    section: "innovation",
    title: "SmoothAgent: lookahead context engineering for serving",
    summary:
      "Aimed at latency rather than accuracy, which is a rare framing. The closest of the three to observability work.",
    url: "https://arxiv.org/pdf/2607.00151",
  },
  {
    id: "openai-jalapeno",
    date: "2026-08-25",
    source: "OpenAI",
    tier: "Secondary",
    type: "Industry",
    section: "business",
    title: "Jalapeño inference chip — announced, not available",
    summary:
      "Throughput, latency and power claims are sourced only to OpenAI, and the chip is in deployment planning. Nothing here changes what you can ship.",
    url: "https://releasebot.io/updates/openai",
    flagged: "Vendor benchmark only",
  },
];
