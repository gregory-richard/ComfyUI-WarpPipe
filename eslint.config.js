import js from "@eslint/js";
import globals from "globals";

// The frontend is browser ES modules loaded by ComfyUI. There is no bundler and
// no framework, so the flat recommended set plus a few rules that catch the
// mistakes this code actually made is the whole configuration.
export default [
  {
    files: ["web/**/*.js"],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: "module",
      globals: globals.browser,
    },
    rules: {
      ...js.configs.recommended.rules,
      // An argument threaded through a call and never read is a leftover from
      // a refactor; two of them survived here because nothing was looking.
      "no-unused-vars": ["error", { args: "all", argsIgnorePattern: "^_" }],
      eqeqeq: ["error", "smart"],
      "no-var": "error",
      "prefer-const": "error",
    },
  },
];
