import { describe, expect, it, vi } from "vitest";
import {
  fetchOllamaSettingsHtml,
  parseOllamaUsageHtml,
} from "../../src/provider-metrics/ollama/settings-html";

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

const MOCK_OLLAMA_HTML_SIGNED_OUT_WITH_RESET = `
<!DOCTYPE html>
<html>
<body>
  <h2>Sign in to Ollama</h2>
  <form action="/api/auth/signin" method="POST">
    <input type="email" name="email" placeholder="Email" />
    <input type="password" name="password" placeholder="Password" />
  </form>
  <span>Cloud Usage</span>
  <span class="badge">Free</span>
  <div>
    <h4>Monthly usage</h4>
    <span data-time="2026-09-01T00:00:00Z">Resets next month</span>
  </div>
</body>
</html>
`;

function response(status: number, body: string, contentType = "application/json"): Response {
  return new Response(body, { status, headers: { "Content-Type": contentType } });
}

describe("parseOllamaUsageHtml", () => {
  it("parses Pro plan with session and weekly usage correctly", () => {
    const result = parseOllamaUsageHtml(MOCK_OLLAMA_HTML_PRO);

    expect(result.plan).toBe("Pro");
    expect(result.email).toBe("user@example.com");
    expect(result.windows).toEqual([
      {
        period: "session",
        usageRatio: 0.355,
        resetTimestampSeconds: Math.floor(Date.parse("2026-08-19T06:00:00.000Z") / 1000),
      },
      {
        period: "weekly",
        usageRatio: 0.12,
        resetTimestampSeconds: Math.floor(Date.parse("2026-08-25T00:00:00.000Z") / 1000),
      },
    ]);
  });

  it("parses Free plan with Hourly usage correctly", () => {
    const result = parseOllamaUsageHtml(MOCK_OLLAMA_HTML_FREE);

    expect(result.plan).toBe("Free");
    expect(result.email).toBe("freeuser@test.org");
    expect(result.windows).toEqual([
      {
        period: "session",
        usageRatio: 0.8,
        resetTimestampSeconds: Math.floor(Date.parse("2026-08-19T05:30:00Z") / 1000),
      },
    ]);
  });

  it("throws 401 when signed out HTML is received", () => {
    expect(() => parseOllamaUsageHtml(MOCK_OLLAMA_HTML_SIGNED_OUT)).toThrow(
      expect.objectContaining({
        message: expect.stringMatching(/invalid or expired/i),
        statusCode: 401,
      }),
    );
  });

  it("keeps valid plan and reset data when sign-in markup is present", () => {
    expect(parseOllamaUsageHtml(MOCK_OLLAMA_HTML_SIGNED_OUT_WITH_RESET)).toEqual({
      plan: "Free",
      windows: [
        {
          period: "monthly",
          resetTimestampSeconds: Math.floor(Date.parse("2026-09-01T00:00:00Z") / 1000),
        },
      ],
    });
  });

  it("returns an empty contribution when no valid field is present", () => {
    const emptyHtml = "<html><body><div>Random page content</div></body></html>";
    expect(parseOllamaUsageHtml(emptyHtml)).toEqual({ windows: [] });
  });
});

describe("fetchOllamaSettingsHtml", () => {
  it("fetches and parses Ollama settings successfully", async () => {
    const mockFetch = vi.fn().mockResolvedValue(response(200, MOCK_OLLAMA_HTML_PRO, "text/html"));

    const result = await fetchOllamaSettingsHtml("wos-session=secret123", mockFetch);

    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(mockFetch).toHaveBeenCalledWith(
      "https://ollama.com/settings",
      expect.objectContaining({
        headers: expect.objectContaining({ Cookie: "wos-session=secret123" }),
      }),
    );
    expect(result).toEqual({
      status: "success",
      contribution: {
        email: "user@example.com",
        plan: "Pro",
        windows: [
          {
            period: "session",
            usageRatio: 0.355,
            resetTimestampSeconds: Math.floor(Date.parse("2026-08-19T06:00:00.000Z") / 1000),
          },
          {
            period: "weekly",
            usageRatio: 0.12,
            resetTimestampSeconds: Math.floor(Date.parse("2026-08-25T00:00:00.000Z") / 1000),
          },
        ],
      },
    });
  });

  it("formats raw cookie string without key into standard cookie header", async () => {
    const mockFetch = vi.fn().mockResolvedValue(response(200, MOCK_OLLAMA_HTML_PRO, "text/html"));

    await fetchOllamaSettingsHtml("raw_cookie_value", mockFetch);
    expect(mockFetch).toHaveBeenCalledWith(
      "https://ollama.com/settings",
      expect.objectContaining({
        headers: expect.objectContaining({
          Cookie: "ollama_session=raw_cookie_value; wos-session=raw_cookie_value",
        }),
      }),
    );
  });

  it("throws 401 when cookie is empty", async () => {
    await expect(fetchOllamaSettingsHtml("   ")).resolves.toEqual({
      status: "failed",
      error: { kind: "auth", statusCode: 401 },
    });
  });

  it("throws on HTTP error response", async () => {
    const mockFetch = vi.fn().mockResolvedValue(response(500, "Internal Server Error"));

    await expect(fetchOllamaSettingsHtml("cookie", mockFetch)).resolves.toEqual({
      status: "failed",
      error: { kind: "upstream_5xx", statusCode: 500 },
    });
  });

  it("returns an auth failure for signed-out HTML without a contribution", async () => {
    const mockFetch = vi
      .fn()
      .mockResolvedValue(response(200, MOCK_OLLAMA_HTML_SIGNED_OUT, "text/html"));

    await expect(fetchOllamaSettingsHtml("cookie", mockFetch)).resolves.toEqual({
      status: "failed",
      error: { kind: "auth", statusCode: 401 },
    });
  });
});
