const workerUrl = process.env.OTEL_WORKER_URL;
const token = process.env.OTEL_INGEST_TOKEN;
if (!workerUrl || !token) throw new Error("OTEL_WORKER_URL and OTEL_INGEST_TOKEN are required");
const timeoutMs = 10_000;

const endpoint = new URL("/v1/traces", workerUrl);
const traceId = "00112233445566778899aabbccddeeff";
const body = {
  resourceSpans: [
    {
      resource: { attributes: [{ key: "service.name", value: { stringValue: "graft-ai-smoke" } }] },
      scopeSpans: [
        {
          spans: [
            {
              traceId,
              spanId: "0112233445566778",
              name: "graft-ai.smoke",
              kind: "SPAN_KIND_SERVER",
              startTimeUnixNano: "1700000000000000000",
              endTimeUnixNano: "1700000000100000000",
              status: { code: "STATUS_CODE_OK" },
              attributes: [
                { key: "model", value: { stringValue: "smoke-model" } },
                { key: "provider", value: { stringValue: "smoke-provider" } },
                { key: "gateway", value: { stringValue: "main" } },
                { key: "env", value: { stringValue: "prod" } },
              ],
            },
          ],
        },
      ],
    },
  ],
};

const controller = new AbortController();
const timeout = setTimeout(() => controller.abort(), timeoutMs);
let response;
try {
  response = await fetch(endpoint, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
    signal: controller.signal,
  });
} finally {
  clearTimeout(timeout);
}
if (response.status !== 200) throw new Error(`OTel Worker smoke failed with status ${response.status}`);
process.stdout.write(`OTel Worker smoke passed: status=${response.status} trace_id=${traceId}\n`);
