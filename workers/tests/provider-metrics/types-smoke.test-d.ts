import { describe, expectTypeOf, it } from "vitest";
import type { ProviderResult } from "../../src/provider-metrics/types";

describe("ProviderResult closed union", () => {
  it("accepts every provider result member", () => {
    const openai: ProviderResult = {
      provider: "openai_api",
      sources: [],
      windows: [],
      costs: [{ lineItem: "tokens", costUSD: 1.25 }],
      modelUsage: [
        {
          model: "gpt-5",
          inputTokens: 10,
          outputTokens: 4,
          cachedTokens: 2,
          requests: 1,
        },
      ],
    };

    const codex: ProviderResult = {
      provider: "codex",
      sources: [],
      windows: [],
      plan: "pro",
      credits: {
        remaining: 10,
      },
    };

    const opencodego: ProviderResult = {
      provider: "opencodego",
      sources: [],
      windows: [],
      zenBalanceUSD: 23.45,
    };

    const ollama: ProviderResult = {
      provider: "ollama_cloud",
      sources: [],
      windows: [],
      modelRequests: [{ period: "session", model: "glm-5.3-flash", requestCount: 54 }],
      activityCostUSD: 12.34,
    };

    const commandcode: ProviderResult = {
      provider: "commandcode",
      sources: [],
      windows: [],
      plan: "pro",
      credits: {
        remaining: 20,
      },
    };

    expectTypeOf([openai, codex, opencodego, ollama, commandcode]).toMatchTypeOf<
      readonly ProviderResult[]
    >();
  });
});
