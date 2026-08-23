const smokeUrl = process.env.OTEL_SMOKE_URL;
const token = process.env.OTEL_SMOKE_TOKEN;
const prometheusUrl = process.env.OTEL_SMOKE_PROMETHEUS_URL;
const lokiUrl = process.env.OTEL_SMOKE_LOKI_URL;
const tempoUrl = process.env.OTEL_SMOKE_TEMPO_URL;

if (!smokeUrl || !token || !prometheusUrl || !lokiUrl || !tempoUrl) {
  throw new Error("OTel smoke environment is incomplete");
}

const traceId = Buffer.from("00112233445566778899aabbccddeeff", "hex").toString(
  "base64",
);
const spanId = Buffer.from("0112233445566778", "hex").toString("base64");
const traceIdHex = "00112233445566778899aabbccddeeff";
const smokeMetricLabels = {
  model: "smoke-model",
  provider: "smoke-provider",
  status_code: "200",
  env: "smoke",
  gateway: "smoke",
};
const expectedLokiLabels = {
  env: "smoke",
  gateway: "smoke",
  model: "smoke-model",
  status_code: "200",
};
const prometheusQuery = `ai_gateway_requests_total{${Object.entries(
  smokeMetricLabels,
)
  .map(([key, value]) => `${key}="${value}"`)
  .join(",")}}`;
const tempoResponseHasTrace = (json) =>
  [...(json?.batches ?? []), ...(json?.resourceSpans ?? [])].some((batch) =>
    batch?.scopeSpans?.some((scope) =>
      scope?.spans?.some(
        (span) => span?.traceId === traceId || span?.traceId === traceIdHex,
      ),
    ),
  );
function lokiRecordMatches(stream) {
  const labels = stream?.stream;
  if (
    labels === null ||
    typeof labels !== "object" ||
    Array.isArray(labels) ||
    JSON.stringify(Object.keys(labels).sort()) !==
      JSON.stringify(Object.keys(expectedLokiLabels).sort()) ||
    !Object.entries(expectedLokiLabels).every(
      ([key, value]) => labels[key] === value,
    )
  ) {
    return false;
  }

  if (!Array.isArray(stream.values)) return false;

  return stream.values.some(([, rawRecord]) => {
    try {
      const record = JSON.parse(rawRecord);
      const serialized = JSON.stringify(record);
      return (
        record.provider === "smoke-provider" &&
        record.input_tokens === 12 &&
        record.output_tokens === 7 &&
        record.total_tokens === 19 &&
        record.cost_usd === 0.0125 &&
        serialized.includes("[REDACTED]") &&
        !serialized.includes("sk-live-smoke")
      );
    } catch {
      return false;
    }
  });
}
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
                {
                  key: "gen_ai.request.model",
                  value: { stringValue: "smoke-model" },
                },
                {
                  key: "gen_ai.model.provider",
                  value: { stringValue: "smoke-provider" },
                },
                { key: "gen_ai.usage.input_tokens", value: { intValue: "12" } },
                { key: "gen_ai.usage.output_tokens", value: { intValue: "7" } },
                { key: "gen_ai.usage.total_tokens", value: { intValue: "19" } },
                { key: "gen_ai.usage.cost", value: { doubleValue: 0.0125 } },
                {
                  key: "http.response.status_code",
                  value: { intValue: "200" },
                },
                {
                  key: "cf-aig-request-id",
                  value: { stringValue: "smoke-request" },
                },
                { key: "gateway", value: { stringValue: "smoke" } },
                { key: "env", value: { stringValue: "smoke" } },
                {
                  key: "gen_ai.prompt_json",
                  value: { stringValue: '{"token":"sk-live-smoke"}' },
                },
              ],
            },
          ],
        },
      ],
    },
  ],
};

async function fetchWithRetry(url, init, description, validate) {
  const attempts = Number(process.env.OTEL_SMOKE_RETRY_ATTEMPTS || "20");
  const delayMs = Number(process.env.OTEL_SMOKE_RETRY_DELAY_MS || "500");
  let lastError;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const response = await fetch(url, {
        ...init,
        signal: AbortSignal.timeout(3_000),
      });
      if (!response.ok) {
        lastError = new Error(
          `${description} returned HTTP ${response.status}`,
        );
      } else if (validate) {
        const body = await response.json();
        if (validate(body)) {
          return response;
        }
        lastError = new Error(
          `${description} response did not match expected data`,
        );
      } else {
        return response;
      }
    } catch (error) {
      lastError = error;
    }
    if (attempt < attempts - 1) {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
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
  (json) => json?.reason === "accepted",
);

await fetchWithRetry(
  `${prometheusUrl}/api/v1/query?query=${encodeURIComponent(prometheusQuery)}`,
  {},
  "Prometheus query",
  (json) =>
    json?.data?.result?.some((sample) => {
      const metric = sample?.metric;
      return (
        metric?.__name__ === "ai_gateway_requests_total" &&
        Object.entries(smokeMetricLabels).every(
          ([key, value]) => metric?.[key] === value,
        ) &&
        Number(sample?.value?.[1]) > 0
      );
    }),
);
await fetchWithRetry(
  `${lokiUrl}/loki/api/v1/query_range?query=${encodeURIComponent('{gateway="smoke",env="smoke",model="smoke-model",status_code="200"}')}`,
  {},
  "Loki query",
  (json) => json?.data?.result?.some(lokiRecordMatches),
);
await fetchWithRetry(
  `${tempoUrl}/api/traces/${traceIdHex}`,
  {},
  "Tempo query",
  tempoResponseHasTrace,
);
