const smokeUrl = process.env.OTEL_SMOKE_URL;
const token = process.env.OTEL_SMOKE_TOKEN;
const prometheusUrl = process.env.OTEL_SMOKE_PROMETHEUS_URL;
const lokiUrl = process.env.OTEL_SMOKE_LOKI_URL;
const tempoUrl = process.env.OTEL_SMOKE_TEMPO_URL;

if (!smokeUrl || !token || !prometheusUrl || !lokiUrl || !tempoUrl) {
  throw new Error("OTel smoke environment is incomplete");
}

const traceId = Buffer.from("00112233445566778899aabbccddeeff", "hex").toString("base64");
const spanId = Buffer.from("0112233445566778", "hex").toString("base64");
const now = BigInt(Date.now()) * 1_000_000n;
const body = {
  resourceSpans: [
    {
      scopeSpans: [
        {
          spans: [
            {
              traceId,
              spanId,
              name: "synthetic-request",
              kind: "SPAN_KIND_SERVER",
              startTimeUnixNano: String(now),
              endTimeUnixNano: String(now + 25_000_000n),
              attributes: [
                { key: "model", value: { stringValue: "smoke-model" } },
                { key: "provider", value: { stringValue: "smoke-provider" } },
                { key: "status_code", value: { intValue: "200" } },
                { key: "env", value: { stringValue: "smoke" } },
                { key: "gateway", value: { stringValue: "smoke" } },
                { key: "request_id", value: { stringValue: "smoke-request" } },
                {
                  key: "gen_ai.prompt_json",
                  value: { stringValue: '{"prompt":"smoke","token":"sk-live-smoke"}' },
                },
              ],
            },
          ],
        },
      ],
    },
  ],
};

async function fetchWithRetry(url, init, description) {
  let lastError;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      const response = await fetch(url, {
        ...init,
        signal: AbortSignal.timeout(3_000),
      });
      if (response.ok) {
        return response;
      }
      lastError = new Error(`${description} returned HTTP ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`${description} did not become ready: ${lastError}`);
}

await fetchWithRetry(
  smokeUrl,
  {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  },
  "OTel receiver",
);

await fetchWithRetry(
  `${prometheusUrl}/api/v1/query?query=ai_gateway_requests_total`,
  {},
  "Prometheus query",
);
await fetchWithRetry(
  `${lokiUrl}/loki/api/v1/query_range?query=${encodeURIComponent('{gateway="smoke"}')}`,
  {},
  "Loki query",
);
await fetchWithRetry(`${tempoUrl}/api/search?limit=1`, {}, "Tempo query");
