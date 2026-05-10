// vs-fork Plan 4 §C BLOCK-2 — frontend test runner config.
//
// Inherits the existing vite.config.js wholesale (so the `@`
// alias, asset includes, postcss, and JSX/React plugin all
// match the production build) and layers a `test` block on top.
// Keeps the test config side-by-side with vite.config.js rather
// than mutating it, so the upstream merge surface stays minimal.

import { defineConfig, mergeConfig } from "vitest/config"
import viteConfig from "./vite.config.js"

export default mergeConfig(
  viteConfig,
  defineConfig({
    test: {
      environment: "jsdom",
      globals: true,
      setupFiles: ["./vitest.setup.js"],
      include: ["src/**/*.{test,spec}.{js,jsx}"],
      // Excluded by default but make it explicit — Storybook
      // / e2e patterns should never be picked up by unit runs.
      exclude: ["node_modules", "dist", "**/*.e2e.*"],
    },
  })
)
