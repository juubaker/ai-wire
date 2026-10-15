# AI Wire

A live changelog for LLM systems work: model releases, API changes, deprecations, pricing and
papers, each linked to the announcement it came from. Leave the tab open and it keeps checking.

## Commands

```bash
npm run dev        # http://localhost:5173
npm test           # 45 tests, Node's built-in runner, no network
npm run lint
npm run verify     # lint + test + build

npm run check      # run a wire check now, writes public/feed.json
npm run demo       # regenerate demo/artifact.jsx
npm run build      # production bundle into dist/ (mounted at /)
npm run build:pages   # GitHub Pages build, mounted at /ai-wire/
npm run preview:pages # check that sub-path build locally
npm run deploy     # build + wrangler deploy (Cloudflare)
```

Deploying it is a different shape from running it locally — see **[DEPLOY.md](DEPLOY.md)** for the
Cloudflare Worker, or **[PAGES.md](PAGES.md)** for GitHub Pages with Gemini, which is the free
route.

## Run it

```bash
npm install
npm install-scripts approve esbuild workerd    # see note below
cp .env.example .env.local                     # add your Anthropic API key
npm run dev                                    # http://localhost:5173
```

Recent npm blocks dependency install scripts by default and prints a list of
what it skipped. Vite and Wrangler need theirs: esbuild and workerd download a
platform-specific binary in `postinstall`, and without it `npm run dev` and
`wrangler` fail at first use rather than at install time. `npm install-scripts
ls` shows the pending list; `approve` records the decision so it doesn't
re-prompt. Leave anything you don't recognise blocked.

In VS Code: open `ai-wire.code-workspace`, then **Run → Open AI Wire in Chrome** (F5). That starts
the dev server as a pre-launch task and attaches the debugger.

## Swapping the model

The picker in the status bar switches provider and model mid-session; the choice is saved and the
watch loop restarts against the new one. Entries carry a `via` badge showing which provider filed
them, so a wire built from several models stays legible.

Currently registered: **Ollama** (default) and **Google Gemini**. Ollama runs the model locally for
free; because it can't reach the web, the check pre-searches and injects the results into the prompt
— see **[SEARCH.md](SEARCH.md)**. That combination costs nothing and still yields real, current
sources. Gemini stays registered for native grounding if you add billing later.

Anthropic (Messages), OpenAI (Responses) and Google (Gemini `generateContent`) are still on disk
and still conform to the contract. Re-enable one by uncommenting its import in
`src/lib/providers/index.js`, adding it to the `PROVIDERS` array, and setting its key in
`.env.local`. The vendor dropdown reappears on its own once more than one is registered.

Note what Ollama can't do: it's registered `supportsSearch: false`, so the prompt switches to
asking only for what the model already knows, with instructions to return `[]` rather than guess a
URL. You get the full pipeline, not current entries.

### Adding one

Write a module under `src/lib/providers/` matching the `Provider` contract documented in
`provider.js`, then add it to the array in `providers/index.js`. That's the whole change — the
proxy, the picker, and the prompt builder all read from the registry.

The contract is eight fields: `id`, `label`, `docs`, `models`, `supportsSearch`, `envKey`,
`endpoint(env)`, `headers(key)`, `buildBody({prompt, model, search})` and `extractText(json)`.
`endpoint` may contain `{model}`, which the proxy substitutes — that's how Gemini's path-based
routing fits the same shape as everyone else's.

`supportsSearch: false` is not a downgrade path, it changes the prompt: a model that can't reach
the web is asked for only what it can source from memory and told that returning `[]` is the right
answer when it can't. Without that, local models invent plausible URLs.

## Sections and filters

Three tabs — **AI Business**, **Product Releases**, **Innovations** — plus Everything. The model
assigns each entry exactly one section on the way in; the definitions it's given are in `SECTIONS`
in `src/lib/check.js`, and changing a `brief` there changes how entries get sorted on the next
check. Entries that arrive without a recognisable section fall back to a mapping from their type,
so nothing is ever dropped.

Within a tab, three filter rows narrow further, combining with AND:

- **When** — presets (7/30/90 days) or a custom date range.
- **What** — the finer, model-invented types.
- **Model** — the model family an entry concerns: Claude, GPT, Gemini, Llama, Muse, Qwen, Jev and
  the rest of `MODEL_FAMILIES` in `src/lib/check.js`. Families, not versions, so narrowing to
  Claude gets every Claude item rather than one release.

An entry can belong to several families, or to none — a protocol revision, a funding round and a
paper about no particular model all legitimately have zero. Families come from the model's own
`models` field, and are otherwise derived from the entry's title, summary and source, so the filter
works on entries collected before the field existed. Each model badge on an entry is clickable and
filters to that family.

Counts stay honest: tab counts respect the date range, and the **What** and **Model** rows each
count against the other's active filter, so a count you can see is a count you can reach. A chip
that stops matching anything resets itself rather than stranding you on an empty wire.

## How the update check works

`Watch for updates` runs a check immediately, then every `VITE_WIRE_POLL_MINUTES` minutes for as
long as the tab is open. `Check now` runs a single pass.

Each check sends the newest date on the wire plus the last 25 titles to the selected provider with
its web search tool on, and asks for anything published since, from primary sources only. The model
returns JSON and **assigns each entry a type** — the suggested taxonomy is in
`src/lib/wire-api.js`, but it can coin a better label, which is why the filter row grows on its own.

Results are deduped by `url + title`, so a repeated find never double-posts.

## Keys never reach the browser

The client POSTs `{model, prompt, search}` to `/api/wire/:providerId`. The middleware in
`vite.config.js` looks the provider up in the registry, builds the vendor-shaped body, attaches the
key named by that provider's `envKey`, and returns the upstream response verbatim. The browser only
ever talks to your own origin, which also sidesteps CORS.

**This middleware only runs under `vite dev`.** In production the checking moves to a scheduled job
and the browser reads a prebuilt feed instead — see [DEPLOY.md](DEPLOY.md) for why, and for the
Cloudflare Worker that implements it.

## Layout

```
ai-wire.code-workspace           workspace file — open this, not the folder
.vscode/                 settings, recommended extensions, launch + tasks
index.html               entry document
vite.config.js           dev server + the /api/wire proxy
src/
  main.jsx               mounts the app
  App.jsx                the wire: state, polling, filtering, rendering
  data/seed.js           entries the wire starts with
  lib/wire-api.js        feed mode vs direct mode; provider-agnostic
  lib/check.js           prompt, parse, normalise — shared by browser and worker
  lib/providers/
    provider.js          the contract, documented
    index.js             the registry — add new providers here
    anthropic.js         Messages API + web_search tool
    openai.js            Responses API + web_search tool
    google.js            Gemini generateContent + google_search tool
    ollama.js            local runtime, no key, no live search
  lib/storage.js         localStorage-backed persistence
  styles/wire.css        the visual system (custom properties + components)
  index.css              Tailwind layers and page reset
demo/build-artifact.mjs  generates a single-file demo for a Claude artifact
demo/artifact.jsx        GENERATED — re-run `npm run demo`, don't edit
worker/index.js          production: assets + /api/feed + cron check (Cloudflare)
wrangler.toml            Worker config, cron schedule, KV binding
deploy/vercel/           the same endpoints for a Vercel deployment
.github/workflows/       external scheduler for hosts with coarse cron
```

## Editing entries

`src/data/seed.js` is plain data. Add an object with `date`, `source`, `tier`, `type`, `title`,
`summary`, `url`, and optionally `flagged` for claims resting only on a vendor's own benchmark, and
it appears on the wire on reload. Saved entries take precedence over seeds with the same
`url + title`.

## Clearing what's stored

Entries live in `localStorage` under the `wire:` prefix. To start fresh, run
`localStorage.removeItem("wire:items:v1")` in the console and reload.

## License

MIT — see [LICENSE](LICENSE).

The code is MIT. The entries the wire collects are not: each one links to, and
summarises, someone else's announcement or paper, and those remain the property
of whoever published them.
