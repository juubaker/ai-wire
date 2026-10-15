# demo/artifact.jsx — the wire as a single file

A paste-able version of the interface for a Claude artifact, where there is no
bundler, no filesystem and no server. Use it to show someone the UI from a link
without a clone or a key.

```bash
npm run demo
```

`artifact.jsx` is **generated. Don't edit it** — edit the real sources and
re-run. `src/App.jsx` stays the only copy of the UI, which is what keeps the
demo from drifting into a fork.

## What the script does

Inlines `src/App.jsx`, `src/lib/check.js`, `src/data/seed.js` and
`src/styles/wire.css` into one module, then swaps four things an artifact can't
do:

| Real module | Demo stub |
| --- | --- |
| `lib/storage.js` | in-memory — an artifact's localStorage is per-viewer and can throw |
| `lib/wire-api.js` | throws, so the status line explains that checking needs the deployment |
| `lib/providers/` | one "Demo" entry, so the picker has something to show |
| `import.meta.env` | undefined — there's no bundler to define it |

It also ships a shim for the Tailwind utility classes App.jsx uses for layout.
**If you add a utility class to App.jsx, add it to `TAILWIND_SHIM` too**, or
that bit of layout silently disappears from the demo. The script fails loudly on
the two mistakes that otherwise pass quietly: a surviving relative import, and a
surviving `import.meta`.

## What works, and what doesn't

Works: all four section tabs, the When/What/Model filter rows with live counts,
clickable model badges, sorting, the empty states, and every link out to a
source.

Doesn't: **Check now**, deliberately. It reports that the demo has no backend
rather than failing silently — the real check needs a key and a scheduled job.
Nothing persists between reloads either, by design.

Note the seed entries are from August 2026, so the 7- and 30-day presets
correctly show nothing. That's the date filter working, not a bug — and it
doubles as a look at the empty state.
