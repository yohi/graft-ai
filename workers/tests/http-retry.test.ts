import { describe, expect, it } from "vitest";
import { getWithRetry, HttpTransportError } from "../src/http-retry";

describe("getWithRetry transport errors", () => {
  it("classifies exhausted timeout-shaped fetch failures as timeout", async () => {
    const fetchFn: typeof fetch = async () => {
      throw new DOMException("timed out", "TimeoutError");
    };

    const result = getWithRetry({
      url: "https://example.com",
      headers: {},
      fetchFn,
      logLabel: "test",
      isRetryableStatus: () => false,
      maxRetries: 0,
    });

    await expect(result).rejects.toBeInstanceOf(HttpTransportError);
    await expect(result).rejects.toMatchObject({ kind: "timeout" });
  });

  it("classifies exhausted network fetch failures as network", async () => {
    const fetchFn: typeof fetch = async () => {
      throw new TypeError("socket failed");
    };

    await expect(
      getWithRetry({
        url: "https://example.com",
        headers: {},
        fetchFn,
        logLabel: "test",
        isRetryableStatus: () => false,
        maxRetries: 0,
      }),
    ).rejects.toMatchObject({ kind: "network" });
  });
});
