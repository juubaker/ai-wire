# Running AI Wire on GitHub Pages, checked by Gemini

Two things set up here: Gemini as the provider, and GitHub as both the host and
the scheduler. Neither requires a card if you stay inside the free allowances.

## 1. Gemini

1. Get a key at **https://aistudio.google.com/apikey**. No credit card, and no
   Cloud project needed for the Developer API.
2. Local use — add it to `.env.local`:
   ```
   GOOGLE_API_KEY=...
   ```
3. Restart the dev server and confirm it loaded:
   ```bash
   curl -s localhost:5173/api/wire/_env | python3 -m json.tool
   ```
   `GOOGLE_API_KEY` should read `true`.
4. Google is now the default provider, so **Check now** uses it. Ollama stays in
   the picker as the offline fallback.

**Verify grounding actually works on your tier before building around it.** Free
tier is Flash and Flash-Lite only, at roughly 1,000 requests a day, and Search
grounding carries 5,000 free prompts a month across the Gemini 3.x family. Some
sources report grounding as paid-tier only, so run one check and look at whether
the entries carry real, current URLs. If they don't, the model answered from
memory and you'll see a quota error in the dev server log.

An hourly cron is ~720 checks a month, inside both allowances. Free-tier data
may be used to improve Google's products — irrelevant for public changelog
queries, but worth knowing.

## 2. GitHub Pages

Pages serves static files, so the feed is a **file in the repo** rather than an
endpoint:

```
Actions (hourly cron) → scripts/check.mjs → public/feed.json → commit → Pages redeploys
```

### Setup

1. Push the repo to GitHub.
2. **Settings → Pages → Source: GitHub Actions.**
3. **Settings → Secrets and variables → Actions:**
   - Secret `GOOGLE_API_KEY` — your key.
   - Variable `VITE_BASE` — `/ai-wire/` for a project repo, or `/` for a custom
     domain or a `<user>.github.io` repo. Getting this wrong is the usual cause
     of a blank page with 404s on the JS bundle.
4. **Actions → pages → Run workflow** to trigger the first check by hand. The
   model field lets you override the model for one run.

### What the workflow does

`.github/workflows/pages.yml` runs on push, hourly, and on demand:

- **check** — skipped on push, because a code change doesn't need to spend an
  API call. Runs the script, commits `public/feed.json` only if it changed.
- **deploy** — builds with `VITE_WIRE_MODE=feed` and `VITE_FEED_URL=feed.json`,
  then publishes `dist/`. Runs even if the check failed, so a provider outage
  leaves the last good feed up instead of taking the site down.

Concurrency is set so a scheduled run and a push never deploy simultaneously,
and in-flight checks are never cancelled — a half-written feed would get
committed.

### Running the check locally

```bash
GOOGLE_API_KEY=... npm run check
```

Writes `public/feed.json` in place and prints what it added. Safe to run
repeatedly; entries dedupe on `url + title`.

## Tradeoffs versus the Cloudflare Worker

| | Pages | Worker |
| --- | --- | --- |
| Manual "Check now" in production | No — there's no endpoint. Use **Run workflow**. | Yes, gated on `ADMIN_TOKEN`. |
| Freshness | Hourly is sensible; faster means commit noise. | 15 minutes or tighter. |
| History | Every refresh is a commit. | Feed lives in KV, no commits. |
| Ollama as the checker | No — runners have no GPU or model. | Only with a publicly reachable `OLLAMA_BASE_URL`. |

Both are still wired. `wrangler.toml` and `worker/index.js` are untouched, so
deploying to Cloudflare instead is still `npm run deploy`.

## Commit noise

An hourly cron is 24 commits a day at worst, and fewer in practice since the
check only commits when the feed actually changes. If it bothers you, widen the
cron or point the commit at an orphan branch and have Pages read from there.
