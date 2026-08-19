import { describe, expect, it, vi } from "vitest";
import { fetchOllamaMetrics, parseOllamaUsageHtml } from "../../src/provider-metrics/ollama";

const MOCK_OLLAMA_HTML_PRO = `
<!DOCTYPE html>
<html lang="en">
<head><title>Ollama Settings</title></head>
<body>
  <div id="header-email">user@example.com</div>
  <div class="cloud-usage">
    <span>Cloud Usage</span>
    <span>Pro</span>
  </div>
  <div class="usage-section">
    <h3>Session usage</h3>
    <div class="progress" style="width: 35.5%">35.5% used</div>
    <span data-time="2026-08-19T06:00:00.000Z">Resets in 2 hours</span>
  </div>
  <div class="usage-section">
    <h3>Weekly usage</h3>
    <div class="progress" style="width: 12%">12% used</div>
    <span data-time="2026-08-25T00:00:00.000Z">Resets in 6 days</span>
  </div>
</body>
</html>
`;

const MOCK_OLLAMA_HTML_FREE = `
<!DOCTYPE html>
<html>
<body>
  <div id="header-email">freeuser@test.org</div>
  <span>Cloud Usage</span>
  <span class="badge">Free</span>
  <div>
    <h4>Hourly usage</h4>
    <div class="bar">80% used</div>
    <span data-time="2026-08-19T05:30:00Z">Resets in 30m</span>
  </div>
</body>
</html>
`;

const MOCK_OLLAMA_HTML_SIGNED_OUT = `
<!DOCTYPE html>
<html>
<head><title>Sign in - Ollama</title></head>
<body>
  <h2>Sign in to Ollama</h2>
  <form action="/api/auth/signin" method="POST">
    <input type="email" name="email" placeholder="Email" />
    <input type="password" name="password" placeholder="Password" />
    <button type="submit">Sign In</button>
  </form>
</body>
</html>
`;

describe("parseOllamaUsageHtml", () => {
  it("parses Pro plan with session and weekly usage correctly", () => {
    const result = parseOllamaUsageHtml(MOCK_OLLAMA_HTML_PRO);

    expect(result.plan).toBe("Pro");
    expect(result.email).toBe("user@example.com");
    expect(result.sessionUsageRatio).toBeCloseTo(0.355);
    expect(result.weeklyUsageRatio).toBeCloseTo(0.12);
    expect(result.sessionResetTimestampSeconds).toBe(
      Math.floor(Date.parse("2026-08-19T06:00:00.000Z") / 1000),
    );
    expect(result.weeklyResetTimestampSeconds).toBe(
      Math.floor(Date.parse("2026-08-25T00:00:00.000Z") / 1000),
    );
  });

  it("parses Free plan with Hourly usage correctly", () => {
    const result = parseOllamaUsageHtml(MOCK_OLLAMA_HTML_FREE);

    expect(result.plan).toBe("Free");
    expect(result.email).toBe("freeuser@test.org");
    expect(result.sessionUsageRatio).toBeCloseTo(0.8);
    expect(result.weeklyUsageRatio).toBeUndefined();
    expect(result.sessionResetTimestampSeconds).toBe(
      Math.floor(Date.parse("2026-08-19T05:30:00Z") / 1000),
    );
    expect(result.weeklyResetTimestampSeconds).toBeUndefined();
  });

  it("throws 401 when signed out HTML is received", () => {
    expect(() => parseOllamaUsageHtml(MOCK_OLLAMA_HTML_SIGNED_OUT)).toThrowError(
      expect.objectContaining({
        message: expect.stringMatching(/invalid or expired/i),
        statusCode: 401,
      }),
    );
  });

  it("throws when usage blocks are completely absent", () => {
    const emptyHtml = "<html><body><div>Random page content</div></body></html>";
    expect(() => parseOllamaUsageHtml(emptyHtml)).toThrowError(
      /Could not find Ollama Cloud usage data/i,
    );
  });
});

describe("fetchOllamaMetrics", () => {
  it("fetches and parses Ollama settings successfully", async () => {
    const mockFetch = vi.fn().mockResolvedValue(
      new Response(MOCK_OLLAMA_HTML_PRO, {
        status: 200,
        headers: { "Content-Type": "text/html" },
      }),
    );

    const result = await fetchOllamaMetrics("wos-session=secret123", mockFetch);

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [url, init] = mockFetch.mock.calls[0]! as [string, RequestInit];
    expect(url).toBe("https://ollama.com/settings");
    expect((init.headers as Record<string, string>)["Cookie"]).toBe("wos-session=secret123");
    expect(result.plan).toBe("Pro");
    expect(result.sessionUsageRatio).toBeCloseTo(0.355);
  });

  it("formats raw cookie string without key into standard cookie header", async () => {
    const mockFetch = vi.fn().mockResolvedValue(
      new Response(MOCK_OLLAMA_HTML_PRO, {
        status: 200,
        headers: { "Content-Type": "text/html" },
      }),
    );

    await fetchOllamaMetrics("raw_cookie_value", mockFetch);
    const init = mockFetch.mock.calls[0]![1] as RequestInit;
    expect((init.headers as Record<string, string>)["Cookie"]).toContain(
      "ollama_session=raw_cookie_value",
    );
  });

  it("throws 401 when cookie is empty", async () => {
    await expect(fetchOllamaMetrics("   ")).rejects.toThrowError(
      expect.objectContaining({ statusCode: 401 }),
    );
  });

  it("throws on HTTP error response", async () => {
    const mockFetch = vi
      .fn()
      .mockResolvedValue(new Response("Internal Server Error", { status: 500 }));

    await expect(fetchOllamaMetrics("cookie", mockFetch)).rejects.toThrowError(
      expect.objectContaining({ statusCode: 500 }),
    );
  });
});
