# Tests

```bash
npm test          # once
npm run test:watch
npm run verify    # lint + test + build, what CI should run
```

Node's built-in runner — nothing to install, and it works offline.

## What's covered

`check.test.js` — the pure logic. Model-family and section classification,
JSON parsing, entry normalisation, and prompt assembly in all three retrieval
modes.

`run-check.test.js` — a whole check with `fetch` stubbed, so no network. Covers
mode selection, search results reaching the prompt, the url guard, and that
failures surface rather than being swallowed.

## What isn't

The React component. The filter chain, the drawer and the rail have been
verified by rendering in headless Chromium, but that needs Playwright and a
JSX transform, which is more setup than this repo currently carries. If the UI
grows, that's the gap worth closing first.

## A note on the regression tests

Several tests exist because the bug actually shipped, and they say so in a
comment. The word-boundary cases are there because substring matching had
`"sol"` firing on *solution*; the vendor-in-prose case is there because a
funding story carried by a third party came back with no model family. A test
whose reason is forgotten is a test someone deletes.
