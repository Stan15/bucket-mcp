import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Contract tests hit the real Bitbucket API and run only via `npm run test:contract` -
    // excluded here so `npm test` never needs network access or can flake on rate limits.
    exclude: ["**/node_modules/**", "test/contract/**"],
  },
});
