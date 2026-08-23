import { strict as assert } from "node:assert";
import { createServer } from "node:http";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { test } from "node:test";

const smokeScript = fileURLToPath(
  new URL("../deploy/otel/scripts/synthetic-otlp-smoke.mjs", import.meta.url),
);

test(
  "smoke validates the synthetic metric and directly queries Tempo",
  { timeout: 5_000 },
  async () => {
    let prometheusAttempts = 0;
    const prometheusAttemptTimes = [];
    const prometheusQueries = [];
    let submittedTrace;
    let lokiAttempts = 0;
    const lokiQueries = [];
    const tempoPaths = [];

    const server = createServer((request, response) => {
      const chunks = [];
      request.on("data", (chunk) => chunks.push(chunk));
      request.on("end", () => {
        response.setHeader("Content-Type", "application/json");

        if (request.method === "POST" && request.url === "/v1/traces") {
          submittedTrace = JSON.parse(Buffer.concat(chunks).toString("utf8"));
          response.end(JSON.stringify({ reason: "accepted" }));
          return;
        }

        if (request.url?.startsWith("/api/v1/query?")) {
          prometheusAttempts += 1;
          prometheusAttemptTimes.push(Date.now());
          prometheusQueries.push(
            new URL(request.url, "http://localhost").searchParams.get("query"),
          );
          const result =
            prometheusAttempts === 1
              ? [
                  {
                    metric: {
                      __name__: "ai_gateway_requests_total",
                      model: "other-model",
                      provider: "other-provider",
                      status_code: "200",
                      env: "other",
                      gateway: "other",
                    },
                    value: ["1", "1"],
                  },
                ]
              : [
                  {
                    metric: {
                      __name__: "ai_gateway_requests_total",
                      model: "smoke-model",
                      provider: "smoke-provider",
                      status_code: "200",
                      env: "smoke",
                      gateway: "smoke",
                    },
                    value: ["1", "1"],
                  },
                ];
          response.end(JSON.stringify({ status: "success", data: { result } }));
          return;
        }

        if (request.url?.startsWith("/loki/api/v1/query_range?")) {
          lokiAttempts += 1;
          lokiQueries.push(
            new URL(request.url, "http://localhost").searchParams.get("query"),
          );
          const stream = {
            stream:
              lokiAttempts === 1
                ? {
                    env: "smoke",
                    gateway: "smoke",
                    model: "smoke-model",
                    provider: "smoke-provider",
                    status_code: "200",
                  }
                : {
                    env: "smoke",
                    gateway: "smoke",
                    model: "smoke-model",
                    status_code: "200",
                  },
            values: [
              [
                "1",
                JSON.stringify({
                  provider: "smoke-provider",
                  input_tokens: 12,
                  output_tokens: 7,
                  total_tokens: 19,
                  cost_usd: 0.0125,
                  prompt: "[REDACTED]",
                }),
              ],
            ],
          };
          response.end(
            JSON.stringify({
              status: "success",
              data: {
                result: [stream],
              },
            }),
          );
          return;
        }

        if (request.url?.startsWith("/api/search?")) {
          response.end(JSON.stringify({ traces: [] }));
          return;
        }

        if (request.url?.startsWith("/api/traces/")) {
          tempoPaths.push(request.url);
          response.end(
            JSON.stringify({
              batches: [
                {
                  scopeSpans: [
                    { spans: [{ traceId: "ABEiM0RVZneImaq7zN3u/w==" }] },
                  ],
                },
              ],
            }),
          );
          return;
        }

        response.statusCode = 404;
        response.end(JSON.stringify({ error: "not found" }));
      });
    });

    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const { port } = server.address();
    const baseUrl = `http://127.0.0.1:${port}`;
    const child = spawn(process.execPath, [smokeScript], {
      env: {
        ...process.env,
        OTEL_SMOKE_URL: `${baseUrl}/v1/traces`,
        OTEL_SMOKE_TOKEN: "smoke-token",
        OTEL_SMOKE_PROMETHEUS_URL: baseUrl,
        OTEL_SMOKE_LOKI_URL: baseUrl,
        OTEL_SMOKE_TEMPO_URL: baseUrl,
        OTEL_SMOKE_RETRY_ATTEMPTS: "3",
        OTEL_SMOKE_RETRY_DELAY_MS: "50",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });

    const [exitCode] = await once(child, "close");
    await new Promise((resolve) => server.close(resolve));

    assert.equal(exitCode, 0, stderr);
    assert.ok(submittedTrace);
    const submittedAttributes = new Set(
      submittedTrace.resourceSpans[0].scopeSpans[0].spans[0].attributes.map(
        ({ key }) => key,
      ),
    );
    for (const key of [
      "gen_ai.request.model",
      "gen_ai.model.provider",
      "gen_ai.usage.input_tokens",
      "gen_ai.usage.output_tokens",
      "gen_ai.usage.total_tokens",
      "gen_ai.usage.cost",
      "http.response.status_code",
    ]) {
      assert.ok(
        submittedAttributes.has(key),
        `missing Cloudflare attribute ${key}`,
      );
    }
    assert.equal(prometheusAttempts, 2);
    assert.ok(
      prometheusAttemptTimes[1] - prometheusAttemptTimes[0] >= 40,
      `retry delay was ${prometheusAttemptTimes[1] - prometheusAttemptTimes[0]}ms`,
    );
    assert.deepEqual(prometheusQueries, [
      'ai_gateway_requests_total{model="smoke-model",provider="smoke-provider",status_code="200",env="smoke",gateway="smoke"}',
      'ai_gateway_requests_total{model="smoke-model",provider="smoke-provider",status_code="200",env="smoke",gateway="smoke"}',
    ]);
    assert.equal(lokiAttempts, 2);
    assert.deepEqual(lokiQueries, [
      '{gateway="smoke",env="smoke",model="smoke-model",status_code="200"}',
      '{gateway="smoke",env="smoke",model="smoke-model",status_code="200"}',
    ]);
    assert.deepEqual(tempoPaths, [
      "/api/traces/00112233445566778899aabbccddeeff",
    ]);
  },
);
