import js from "@eslint/js";
import globals from "globals";
import reactHooks from "eslint-plugin-react-hooks";

/**
 * eslint-plugin-react is deliberately absent: as of this writing it has not
 * declared ESLint 10 support, and keeping it would pin the whole toolchain to
 * ESLint 9, which npm now warns is out of support. react-hooks does support 10
 * and is the plugin that catches real bugs here — the rest of that plugin's
 * value is JSX style, which Prettier already handles.
 */
export default [
  { ignores: ["dist/**", "node_modules/**"] },
  js.configs.recommended,
  {
    files: ["**/*.{js,jsx}"],
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
      globals: { ...globals.browser },
      parserOptions: { ecmaFeatures: { jsx: true } },
    },
    plugins: { "react-hooks": reactHooks },
    rules: {
      ...reactHooks.configs.recommended.rules,
      "no-empty": ["error", { allowEmptyCatch: true }],
      "no-unused-vars": ["warn", { argsIgnorePattern: "^_" }],
    },
  },
  {
    // The Worker and the Vercel functions run on a server, not in a browser.
    files: ["worker/**/*.js", "deploy/**/*.js", "vite.config.js"],
    languageOptions: { globals: { ...globals.node, ...globals.worker } },
  },
];
