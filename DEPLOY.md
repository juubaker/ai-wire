# Putting AI Wire on the web

## The decision that comes before the host

In development every visitor triggers a model call. On a public site that is an
open relay to your paid API key: one crawler with a loop empties your account,
and a hundred readers all pay for a hundred identical searches.

So the production shape is different from the dev shape:

```
dev      browser ──POST /api/wire/:provider──▶ vite middleware ──▶ vendor API
prod     cron ──▶ worker ──▶ vendor API ──▶ KV ──▶ GET /api/feed ──▶ browsers
```

One scheduled job does the checking. Everyone else reads a static JSON feed.
Cost stops scaling with traffic, and every reader sees the same wire. The client
picks its mode from `VITE_WIRE_MODE` — `feed` in production, `direct` in dev —
and `App.jsx` doesn't branch on it beyond wording.

Keep `direct` in production only if the site is private and you are the only
reader. Put access control in front of it if you do.

## Host: Cloudflare Workers

Recommended, and what `wrangler.toml` is written for. The reasons are specific
to this app rather than general preference:

- **The schedule is the product.** Cron Triggers are included on the free plan
  and [run at a one-minute minimum](https://developers.cloudflare.com/workers/configuration/cron-triggers/).
  On Vercel's Hobby tier, [cron fires at most once a day](https://vercel.com/docs/cron-jobs/usage-and-pricing)
  and a sub-daily expression is rejected at deploy time — for a changelog that
  updates while you watch it, that's the whole feature.
- **Storage is right there.** Workers KV's free tier covers
  [100,000 reads and 1,000 writes a day](https://developers.cloudflare.com/kv/platform/pricing).
  A check every 15 minutes is 96 writes a day. Reads are the only thing that
  scales with traffic, and the 60-second edge cache on `/api/feed` keeps that
  flat too.
- **One deploy, one artifact.** The `[assets]` binding means the same Worker
  serves the built site, the feed, and the cron handler. No separate static host
  and function project to keep in sync.
- **Free-plan invocation budget** is [100,000 requests a day](https://developers.cloudflare.com/workers/about/pricing),
  which a personal site will not approach.

The real constraint to know about: **cron does not retry.** A failed check waits
for the next firing. `scheduled()` logs and returns rather than throwing, because
a missed interval only means the wire is 15 minutes staler.

### Deploy

```bash
npm i -g wrangler && wrangler login
npm run cf:kv                       # prints the namespace id
#   paste it into wrangler.toml under [[kv_namespaces]]
wrangler secret put ANTHROPIC_API_KEY
wrangler secret put ANTHROPIC_WORKSPACE_ID   # identity-linked keys only
wrangler secret put ADMIN_TOKEN     # gates the manual check route
npm run deploy
```

Then point a domain at it in the Workers dashboard, or use the
`*.workers.dev` subdomain. `npm run cf:tail` streams the cron logs;
`npm run cf:check` fires `scheduled()` locally without waiting for the clock.

## The alternatives, and when they win

| Host | Take it when | The catch |
| --- | --- | --- |
| **Cloudflare Workers** | Default. Sub-daily schedule, KV, and static assets in one deploy. | Cron has no retries or alerting. |
| **Vercel** | You already live there, or want preview deployments per PR. | [Hobby cron is daily only](https://vercel.com/docs/cron-jobs/usage-and-pricing); a tighter cadence means Pro or an external trigger. Needs a separate KV. |
| **Netlify** | Same as Vercel; scheduled functions are on the free tier. | Same split between static host and store. |
| **Fly.io / a small VM** | You want a real cron, a real database, and no platform limits. | You now operate a machine for a JSON file. |
| **GitHub Pages + Actions** | Cheapest possible: commit the feed as a file in the repo. | No server at all, so no manual-check route and no private mode. |

`deploy/vercel/` holds working `api/feed.js` and `api/cron/check.js` for the
Vercel path, plus a `vercel.json` with a daily cron. Copy `deploy/vercel/api` to
`/api` at the project root and set `KV_REST_API_URL`, `KV_REST_API_TOKEN`,
`CRON_SECRET`, and your provider key.

## Getting a tighter cadence for free

`.github/workflows/wire-check.yml` calls the check route on a schedule from
GitHub Actions. It works against any host, including Vercel Hobby, and costs
nothing. GitHub fires schedules on a best-effort basis and they can lag under
load — acceptable here, since a changelog being late is fine and being wrong is
not.

Set repo secrets `WIRE_CHECK_URL` (your `/api/cron/check` or
`/api/wire/anthropic` endpoint) and `CRON_SECRET`.

## Cost, concretely

At a 15-minute cadence the wire runs 96 model calls a day. With a search-enabled
mid-tier model and a ~2.2k-token prompt, that is small but not zero, and it is
the only thing on the bill that isn't free-tier: hosting, KV, and the scheduler
all sit inside free allowances at this scale. Two levers if it matters — widen
the cron to hourly, or point `WIRE_PROVIDER` at a cheaper model. The provider
interface means the second is a one-line change in `wrangler.toml`.

Bear in mind that the daily-check number is fixed no matter how many people read
the site. That is the entire reason for the feed split.

## Before you make it public

- `ADMIN_TOKEN` must be set. Without it the manual check route returns 401,
  which is the correct default — an unauthenticated route that spends money is
  the failure mode to avoid.
- Entries are model-written summaries with links. Say so on the page if strangers
  will read it; the wire links to primary sources precisely so a reader can check.
- Nothing here stores anything about visitors. Keep it that way and you have no
  cookie banner and no privacy policy to write.

## Toolchain notes

The pinned versions are current as of the last update to this file: Vite 8,
React 19, Tailwind 4, ESLint 10, Wrangler 4. `npm audit` reports zero
vulnerabilities on a clean install. Two things to know if you bump them:

- **Tailwind 4 is CSS-first.** There is no `tailwind.config.js` and no PostCSS
  step — `@tailwindcss/vite` plus `@import "tailwindcss"` in `src/index.css` is
  the whole setup.
- **`eslint-plugin-react` is deliberately absent.** It has not declared ESLint 10
  support, and including it pins the toolchain to ESLint 9, which npm now warns
  is out of support. `eslint-plugin-react-hooks` does support 10 and is the part
  that catches real bugs; the rest was JSX style that Prettier already handles.

Never run `npm audit fix --force` here. It resolves advisories by installing
whatever version satisfies them, including majors, which is how a working
toolchain silently becomes a broken one.
