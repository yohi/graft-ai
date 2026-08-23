import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
      miniflare: {
        workers: [
          {
            name: "graft-ai-aig-tail",
            modules: true,
            script: "export default { async tail() {} };",
          },
        ],
      },
    }),
  ],
  test: {
    include: ["tests/**/*.test.ts"],
    exclude: ["tests/otel/**/*.test.ts", "tests/otel-worker-contracts.test.mjs"],
  },
});
