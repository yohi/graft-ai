import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./.wrangler/otel.r2.test.jsonc" },
    }),
  ],
  test: {
    include: ["tests/otel/**/*.test.ts"],
  },
});
