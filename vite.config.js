import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { PROVIDERS } from "./src/lib/providers/index.js";
import { runCheck } from "./src/lib/run-check.js";

/**
 * The browser never holds a key. It POSTs {model, prompt, search} to
 * /api/wire/:providerId; this middleware looks up the provider, builds the
 * vendor-shaped body, attaches the key from env, and returns the upstream
 * response verbatim so the client can parse it with the same provider module.
 *
 * Adding a vendor means adding a file under src/lib/providers/. Nothing here
 * needs to change.
 */
function wireProxy(env) {
  return {
    name: "wire-proxy",
    configureServer(server) {
      server.middlewares.use("/api/wire", async (req, res) => {
        const send = (code, obj) => {
          res.statusCode = code;
          res.setHeader("content-type", "application/json");
          res.end(JSON.stringify(obj));
        };

        const path = (req.url || "/").replace(/^\/+/, "").split("?")[0];

        // Presence-only view of what the dev server actually loaded. Values are
        // never returned — the point is to tell "unset" from "wrong", which is
        // the ambiguity behind most auth failures.
        if (path === "_env") {
          return send(200, {
            loadedFrom: process.cwd(),
            present: Object.fromEntries(
              [
                "ANTHROPIC_API_KEY",
                "ANTHROPIC_WORKSPACE_ID",
                "OPENAI_API_KEY",
                "OPENAI_ORG_ID",
                "OPENAI_PROJECT_ID",
                "GOOGLE_API_KEY",
                "GOOGLE_PROJECT_ID",
                "OLLAMA_BASE_URL",
                "OLLAMA_API_KEY",
              ].map((k) => [k, Boolean(env[k] && env[k].trim())])
            ),
          });
        }

        if (req.method !== "POST") return send(405, { error: "POST only" });

        const provider = PROVIDERS.find((p) => p.id === path);
        if (!provider) {
          return send(404, {
            error: `Unknown provider "${path}". Registered: ${PROVIDERS.map((p) => p.id).join(", ")}`,
          });
        }

        const key = provider.envKey ? env[provider.envKey] : "";
        if (provider.envKey && !key) {
          return send(500, {
            error: `${provider.envKey} is not set. Copy .env.example to .env.local and add it.`,
          });
        }

        let raw = "";
        for await (const chunk of req) raw += chunk;

        let payload;
        try {
          payload = JSON.parse(raw);
        } catch {
          return send(400, { error: "Body must be JSON." });
        }

        const model = payload.model || provider.models[0];

        // The prompt is assembled here rather than in the browser: pre-search
        // needs a key, and a key must not leave the server.
        try {
          const result = await runCheck({
            provider,
            model,
            known: Array.isArray(payload.known) ? payload.known : [],
            env,
          });
          console.log(
            `[wire] ${provider.id} ${model} mode=${result.mode} searched=${result.searched} found=${result.fresh.length}`
          );
          return send(200, result);
        } catch (err) {
          const message = String(err.message || err);
          const missing = Object.entries({
            "anthropic-workspace-id": "ANTHROPIC_WORKSPACE_ID",
            "openai-organization": "OPENAI_ORG_ID",
            "openai-project": "OPENAI_PROJECT_ID",
            "x-goog-user-project": "GOOGLE_PROJECT_ID",
          }).find(([header, name]) => message.includes(header) && !env[name]);

          return send(502, {
            error: missing
              ? `${provider.label} requires the ${missing[0]} header, and ${missing[1]} is not set. Add it to .env.local and restart the dev server.`
              : message,
          });
        }
      });
    },
  };
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "");
  return {
    // "/" for a custom domain or a user site; "/<repo>/" for project pages.
    // Where the app is mounted, as the generated asset URLs see it.
    //
    // This rewrites URLs only — it does NOT nest the output directory — so the
    // right value depends on what the host does with dist/:
    //
    //   GitHub Pages  mounts the artifact at /<repo>/ itself, so dist stays
    //                 flat and base alone is enough     → npm run build:pages
    //   Vercel        serves dist/ at the domain root, so the files have to
    //                 physically live under ai-wire/    → npm run build:vercel
    //                 (that script passes --outDir dist/ai-wire)
    //   Cloudflare    serves from the root with no sub-path → npm run build
    //
    // Set base without nesting on a root-serving host and every asset 404s,
    // which is the failure this comment exists to prevent.
    base: env.VITE_BASE || "/",
    plugins: [react(), tailwindcss(), wireProxy(env)],
    server: { port: 5173, open: false },
  };
});
