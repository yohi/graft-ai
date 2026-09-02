import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { once } from "node:events";
import assert from "node:assert/strict";
import { resolve } from "node:path";
import { test } from "node:test";

const root = resolve(import.meta.dirname, "..");
const script = resolve(root, "scripts/otel-worker-smoke.mjs");

async function startCaptureServer() {
  const requests = [];
  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    requests.push({
      headers: request.headers,
      body: JSON.parse(Buffer.concat(chunks).toString("utf8")),
    });
    response.writeHead(200, { "content-type": "application/json" });
    response.end("{}");
  });

  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address === "object");
  return {
    requests,
    server,
    url: `http://127.0.0.1:${address.port}`,
  };
}

async function runSmoke(workerUrl) {
  const child = spawn(process.execPath, [script], {
    cwd: root,
    env: {
      ...process.env,
      OTEL_INGEST_TOKEN: "test-ingest-token",
      OTEL_WORKER_URL: workerUrl,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const stdout = [];
  const stderr = [];
  child.stdout.on("data", (chunk) => stdout.push(chunk));
  child.stderr.on("data", (chunk) => stderr.push(chunk));
  const [code] = await once(child, "close");
  assert.equal(
    code,
    0,
    `${Buffer.concat(stdout).toString()}${Buffer.concat(stderr).toString()}`,
  );
}

function firstSpan(request) {
  return request.body.resourceSpans[0].scopeSpans[0].spans[0];
}

test("smoke payload timestamps are inside the current Grafana retention window", async () => {
  const capture = await startCaptureServer();
  try {
    const beforeMs = Date.now();
    await runSmoke(capture.url);
    const afterMs = Date.now();
    const span = firstSpan(capture.requests[0]);
    const startMs = Number(span.startTimeUnixNano.slice(0, -6));
    const endMs = Number(span.endTimeUnixNano.slice(0, -6));

    assert.ok(startMs >= beforeMs - 1_000 && startMs <= afterMs + 1_000);
    assert.ok(endMs >= startMs);
  } finally {
    capture.server.close();
    await once(capture.server, "close");
  }
});

test("each smoke run uses a new trace and span ID", async () => {
  const capture = await startCaptureServer();
  try {
    await runSmoke(capture.url);
    await runSmoke(capture.url);
    const first = firstSpan(capture.requests[0]);
    const second = firstSpan(capture.requests[1]);

    assert.match(first.traceId, /^[0-9a-f]{32}$/);
    assert.match(first.spanId, /^[0-9a-f]{16}$/);
    assert.notEqual(first.traceId, second.traceId);
    assert.notEqual(first.spanId, second.spanId);
  } finally {
    capture.server.close();
    await once(capture.server, "close");
  }
});
