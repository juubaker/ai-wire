npm run dev        # http://localhost:5173
npm test           # 45 tests
npm run lint
npm run verify     # lint + test + build — what CI should run

npm run check      # run a wire check now, writes public/feed.json
npm run demo       # regenerate demo/artifact.jsx
npm run build      # production bundle into dist/
npm run build:pages   # feed-mode build for GitHub Pages
npm run deploy     # build + wrangler deploy (Cloudflare)
npm run cf:check   # fire the scheduled handler locally
npm run cf:tail    # stream Worker logs
