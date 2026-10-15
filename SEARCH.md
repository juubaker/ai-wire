# Pre-search: we retrieve, the model reads

A local model can't reach the web, and grounded search on the hosted providers
is either paid or rate-limited. Rather than pay for a model that searches, the
check runs the searches itself and hands the results to the model in the prompt.

```
QUERIES → ollama.com/api/web_search → results → prompt → local model → JSON entries
                                                              ↓
                                          urls not in the results are dropped
```

The model's job shrinks to summarising and classifying, which is what a small
model is actually good at. Retrieval — the part where correctness matters — is
code you control.

## Setup

1. Create a free Ollama account and a key at
   **https://ollama.com/settings/keys**. The web search API is free with an
   account.
2. Add it to `.env.local`:
   ```
   OLLAMA_API_KEY=...
   ```
3. Have a local model running:
   ```bash
   ollama serve
   ollama pull qwen3:32b
   ```
4. Run a check:
   ```bash
   npm run check
   ```
   Output tells you which path it took:
   ```
   checking via ollama / qwen3:32b
   pre-searched: 17 results
   added=3 total=18 provider=ollama model=qwen3:32b
   ```

In the app, the status line reads "3 new entries via Ollama, from 17 search
results", and a **Pre-search on** badge replaces the old "No live search"
warning.

## How the mode is chosen

`src/lib/run-check.js` decides, so no caller has to:

| Condition | Mode | What the prompt says |
| --- | --- | --- |
| Provider searches natively (Gemini, Claude, GPT) | `native` | "Search the web for…" |
| `OLLAMA_API_KEY` is set | `injected` | "Work ONLY from these results" |
| Neither | `memory` | "You cannot search… returning [] is correct" |

## The URL guard

A small model given search results will still occasionally paraphrase a URL
instead of copying it. So in injected mode, any entry whose `url` isn't verbatim
in the search results is **dropped** before it reaches the feed, and the count
is logged. That check is four lines and it's the difference between a wire you
can trust and one that looks plausible.

This is why pre-search is better than no-search rather than merely cheaper: the
set of acceptable URLs is known in advance, so hallucinated sources are
mechanically detectable.

## Tuning what gets found

`QUERIES` in `src/lib/search.js` is the retrieval strategy, and it's
deliberately source-shaped rather than topic-shaped — the wire's editorial rule
is primary sources, so the queries name them:

```js
"Anthropic API changelog release notes",
"OpenAI API changelog deprecations",
...
```

Fifteen queries, **grouped by the section each is meant to feed**. The first
version of this list was all changelogs, and the result was that every entry
came back `product` while the Business and Innovations tabs stayed frozen no
matter how often the check ran. Retrieval has to cover the taxonomy, or the
taxonomy is decorative. If you add a section to `SECTIONS`, add queries for it.

Two more patterns worth copying when you add a vendor:
- **Chase the version string, not the product name.** Jev ships as versioned
  aliases (`jev-latest` → `jev-1.13.0`), so `"Jev model release jev-latest
  version"` catches a bump that no blog post announces.
- **Query the distribution channels too.** Jev reached Vercel AI Gateway,
  Cloudflare Workers AI, OpenRouter and Portkey within weeks of launch, and each
  announces independently of the vendor. Gateway availability is often the first
  public signal that something shipped.

Add a query per source you care about. Each returns up to 4 results, each
trimmed to 600 characters, deduped by URL across queries. If one query fails the
others still run; the check only errors if all of them fail.

Ollama's docs recommend at least ~32k context when feeding search results to a
model, so `ollama.js` sets `num_ctx: 32000`. A model with a smaller window will
silently truncate the results — which looks like the model ignoring sources.

## In CI

Actions runners have no GPU, so the scheduled check needs a hosted endpoint. Set
repository variable `OLLAMA_BASE_URL` to `https://ollama.com` (Ollama Cloud) or
a tunnel to a machine of yours, and secret `OLLAMA_API_KEY`. The same key covers
both the search API and Ollama Cloud models.

Running the model locally and only the *search* remotely works fine for `npm run
check` at your desk — it's the cron that needs a reachable model.
