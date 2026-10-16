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
   ollama pull qwen3:8b
   ```
   **Pick a model that fits in GPU memory.** Summarising search results into
   JSON is not a frontier task, and an oversized model is worse than a small
   one: Ollama will load what fits and run the rest on CPU, which turns a
   20-second check into a multi-minute one that looks like a hang. Rough
   footprints, plus ~2 GiB for the context below:

   | Model | Weights | Wants |
   | --- | --- | --- |
   | `qwen3:8b` | ~5 GiB | 8 GiB machine |
   | `qwen3:14b` | ~9 GiB | 16 GiB machine |
   | `qwen3:32b` | ~19 GiB | 32 GiB machine |

   If `ollama serve`'s log says `offloaded 29/65 layers to GPU` or
   `cannot meet free memory target`, the model is too big — drop a size.
4. Run a check:
   ```bash
   npm run check
   ```
   Output tells you which path it took, stage by stage:
   ```
   checking via ollama / qwen3:8b
     searched      17 results
     model returned 5 entries
     already known  2 dropped
     kept          3
   added=3 total=18 provider=ollama model=qwen3:8b
   ```

In the app, the status line reads "3 new entries via Ollama, from 17 search
results", and a **Pre-search on** badge replaces the old "No live search"
warning.

## The failure this is built to prevent

Memory mode is the dangerous one, because it looks like success. The model is
told that `[]` is the correct answer when it isn't sure, so it returns `[]`,
the check exits 0, and the build goes green — forever, while the wire quietly
stops moving.

It bit this project for two weeks. `.env.local` is loaded by Vite, so the dev
proxy pre-searched correctly and the page showed a **Pre-search on** badge —
but `scripts/check.mjs` is plain Node and read only `process.env`, so the CLI
and the scheduled cron silently ran in memory mode. Same code, two modes, one
of them invisible.

Two guards now:
- `check.mjs` loads `.env.local` itself (real env still wins, so CI secrets
  aren't shadowed).
- It **refuses to run in memory mode** unless you pass `--no-search`. A
  degraded mode you can enter by accident is a degraded mode you will ship.

The quickest way to tell which mode a run used is the prompt size: memory mode
is ~1,200 tokens, injected is ~4,000+. `llama-server` prints it as
`task.n_tokens`.

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

### Don't burst

The first implementation fired all 15 queries at once through `Promise.all`.
That is 15 simultaneous requests at a free-tier API, and it earned a blanket
`HTTP 429` — every query failed the same way, so the "one dead query shouldn't
sink the run" guard didn't help: they were all dead.

Retrieval now runs **two at a time** with exponential backoff and jitter, and
honours `Retry-After` when the server sends one. Only 429 and 5xx are retried;
a 401 is a bad key and will still be bad in two seconds, so it fails on the
first attempt rather than taking four to tell you.

The cost is a few seconds per check. The alternative is a wire that stops
updating and a green build that says everything is fine.

### Bound every wait

Throttling introduced its own failure: retry budgets *multiply*. Three retries
honouring a 30-second `Retry-After`, across 15 queries at concurrency 2, is
twelve minutes of total silence — which from the outside is a hang.

Three ceilings now, all tested:

| Guard | Default | Why |
| --- | --- | --- |
| `timeoutMs` | 15s | Node's `fetch` has **no** default timeout; a hung socket waits forever. |
| `maxRetryAfterMs` | 8s | One long server hint can't dominate the run. |
| `budgetMs` | 90s | Wall clock for the whole phase. Past it, stop retrying and use what arrived. |

Measured against a server that always 429s with `Retry-After: 30`: **96s** to
fail, versus twelve minutes before.

The check also prints `searching N/15` as it goes. A slow stage that prints
nothing is indistinguishable from a dead one, and that ambiguity is what let
the original problem sit for two weeks.

Feeding search results needs context, so `ollama.js` sets `num_ctx: 20000`.
That's measured, not guessed: a real 15-query search builds a **12,088-token**
prompt, leaving room for the 2k reply plus ~25% slack. Below that the results
truncate silently, which looks like the model ignoring its sources. Above it
you pay memory for nothing, and on a tight machine that padding is what forces
layers onto the CPU.

If you widen `QUERIES` or raise the 600-char per-result trim, re-measure rather
than assume. `llama-server` prints the real number as `task.n_tokens`, and it
doubles as the fastest way to tell injected mode (~12k) from memory mode
(~1.2k) at a glance.

## In CI

**The model endpoint needs auth too.** Runners have no GPU, so a scheduled
check must point at a hosted runtime — and `OLLAMA_API_KEY` is sent as a bearer
token on the chat call, not only on search. A local daemon needs no auth and
gets none; anything else 401s without it.


Actions runners have no GPU, so the scheduled check needs a hosted endpoint. Set
repository variable `OLLAMA_BASE_URL` to `https://ollama.com` (Ollama Cloud) or
a tunnel to a machine of yours, and secret `OLLAMA_API_KEY`. The same key covers
both the search API and Ollama Cloud models.

Running the model locally and only the *search* remotely works fine for `npm run
check` at your desk — it's the cron that needs a reachable model.
