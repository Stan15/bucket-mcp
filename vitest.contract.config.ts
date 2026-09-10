import { defineConfig } from "vitest/config";

// Separate config for the one test tier allowed to hit the real Bitbucket
// API - kept apart from vitest.config.ts (which excludes this directory)
// so `npm test` never needs network access.
export default defineConfig({
  test: {
    include: ["test/contract/**/*.test.ts"],
  },
});
