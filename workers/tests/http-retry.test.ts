import { describe, expect, it, vi } from "vitest";
import { getJsonWithRetry, getWithRetry, HttpTransportError } from "../src/http-retry";

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

describe("getJsonWithRetry body errors", () => {
  it.each(["AbortError", "TimeoutError"] as const)(
    "retries a %s during JSON body reading",
    async (errorName) => {
      const firstResponse = new Response("{}", { status: 200 });
      vi.spyOn(firstResponse, "json").mockRejectedValue(
        new DOMException("body timed out", errorName),
      );
      const secondResponse = new Response('{"ok":true}', { status: 200 });
      const fetchFn = vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(firstResponse)
        .mockResolvedValueOnce(secondResponse);

      const result = await getJsonWithRetry({
        url: "https://example.com",
        headers: {},
        fetchFn,
        logLabel: "test",
        isRetryableStatus: () => false,
        maxRetries: 1,
        initialBackoffMs: 0,
      });

      expect(result.response).toBe(secondResponse);
      expect(result.body).toEqual({ ok: true });
      expect(fetchFn).toHaveBeenCalledTimes(2);
    },
  );

  it("does not retry JSON syntax errors", async () => {
    const fetchFn = vi.fn<typeof fetch>().mockResolvedValue(new Response("{", { status: 200 }));

    await expect(
      getJsonWithRetry({
        url: "https://example.com",
        headers: {},
        fetchFn,
        logLabel: "test",
        isRetryableStatus: () => false,
        maxRetries: 2,
        initialBackoffMs: 0,
      }),
    ).rejects.toBeInstanceOf(SyntaxError);
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it("does not retry other JSON body errors", async () => {
    const error = new Error("body failed");
    const response = new Response("{}", { status: 200 });
    vi.spyOn(response, "json").mockRejectedValue(error);
    const fetchFn = vi.fn<typeof fetch>().mockResolvedValue(response);

    await expect(
      getJsonWithRetry({
        url: "https://example.com",
        headers: {},
        fetchFn,
        logLabel: "test",
        isRetryableStatus: () => false,
        maxRetries: 2,
        initialBackoffMs: 0,
      }),
    ).rejects.toBe(error);
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });
});
