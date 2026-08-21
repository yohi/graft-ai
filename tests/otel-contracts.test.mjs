import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  contentTypeForOtelEncoding,
  resolveOtelEncoding,
} from "../deploy/otel/contracts/encoding.mjs";
import {
  extractPrometheusRetentionValues,
  hasCanonicalPrometheusRetention,
} from "../scripts/verify-otel-config.mjs";

const contracts = JSON.parse(
  readFileSync(
    new URL("../deploy/otel/contracts/contracts.json", import.meta.url),
    "utf8",
  ),
);
const compose = readFileSync(
  new URL("../deploy/otel/docker-compose.yml", import.meta.url),
  "utf8",
);
const sampling = JSON.parse(
  readFileSync(
    new URL("../deploy/otel/contracts/sampling-fixtures.json", import.meta.url),
    "utf8",
  ),
);

const dayMs = 24 * 60 * 60 * 1000;

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const goContracts = JSON.parse(
  execFileSync("go", ["run", "./cmd/export-contracts"], {
    cwd: join(__dirname, "../deploy/otel/alloy"),
    encoding: "utf8",
  }),
);

function decimalRateToPpm(rate) {
  assert.match(rate, /^(?:0|1|0\.\d+|1\.0+)$/);
  const [whole, fraction = ""] = rate.split(".");
  const fractionalPpm = Number(`${fraction}000000`.slice(0, 6));
  return Number(whole) * 1_000_000 + fractionalPpm;
}

function samplingDecision(traceId, seed, ratePpm) {
  const hash = createHash("sha256")
    .update(`${traceId}${seed}`, "utf8")
    .digest();
  const hash64 = BigInt(`0x${hash.subarray(0, 8).toString("hex")}`);
  return hash64 * 1_000_000n < BigInt(ratePpm) * (1n << 64n);
}

test("resolves the two supported OTEL encodings", () => {
  assert.equal(
    resolveOtelEncoding({ CLOUDFLARE_OTEL_EXPORT_ENCODING: "protobuf" }),
    "protobuf",
  );
  assert.equal(
    resolveOtelEncoding({ CLOUDFLARE_OTEL_EXPORT_ENCODING: "json" }),
    "json",
  );
  assert.equal(
    contentTypeForOtelEncoding("protobuf"),
    "application/x-protobuf",
  );
  assert.equal(contentTypeForOtelEncoding("json"), "application/json");
  assert.equal(
    contracts.encoding.protobuf.contentType,
    "application/x-protobuf",
  );
  assert.equal(contracts.encoding.json.contentType, "application/json");
});

test("rejects missing and unknown OTEL encodings", () => {
  assert.throws(
    () => resolveOtelEncoding({}),
    /CLOUDFLARE_OTEL_EXPORT_ENCODING/,
  );
  assert.throws(
    () => resolveOtelEncoding({ CLOUDFLARE_OTEL_EXPORT_ENCODING: "yaml" }),
    /protobuf.*json/i,
  );
});

test("pins every receiver status and reason pair", () => {
  assert.deepEqual(contracts.receiver.statusReasonPairs, [
    { status: 401, reason: "auth" },
    { status: 403, reason: "untrusted_source" },
    { status: 404, reason: "path" },
    { status: 400, reason: "parse" },
    { status: 415, reason: "content_type" },
    { status: 415, reason: "compression" },
    { status: 413, reason: "body_size" },
    { status: 408, reason: "timeout" },
    { status: 429, reason: "rate_limit" },
    { status: 200, reason: "accepted" },
  ]);
});

test("pins receiver limits and accepted content types", () => {
  assert.deepEqual(contracts.receiver.contentTypes, {
    protobuf: "application/x-protobuf",
    json: "application/json",
  });
  assert.deepEqual(contracts.receiver.limits, {
    maxBodyBytes: 8 * 1024 * 1024,
    readHeaderTimeoutSeconds: 5,
    readTimeoutSeconds: 30,
    writeTimeoutSeconds: 10,
    maxConcurrentRequests: 100,
    ingressQueueItems: 1_000,
  });
  assert.deepEqual(contracts.receiver.rateLimit, {
    capacity: 20,
    refillPerSecond: 2,
    retryAfterMinimumSeconds: 1,
  });
  assert.deepEqual(contracts.receiver.sourceIdentity, {
    trustedForwardingHeader: "CF-Connecting-IP",
    ignoredForwardingHeaders: ["X-Forwarded-For", "True-Client-IP"],
    unknownBucket: "unknown",
    hmacDomain: "otel-ingress-source-v1\u0000",
  });
});

test("converts decimal rates to integer ppm without floating point", () => {
  const expected = new Map(
    sampling.rates.map(({ decimal, ratePpm }) => [decimal, ratePpm]),
  );
  for (const [decimal, ratePpm] of expected) {
    assert.equal(decimalRateToPpm(decimal), ratePpm, decimal);
  }
  assert.equal(decimalRateToPpm("0.000001"), 1);
  assert.equal(decimalRateToPpm("0.9999999"), 999999);
  assert.throws(() => decimalRateToPpm("-0.1"));
  assert.throws(() => decimalRateToPpm("1.000001"));
});

test("matches every fixed SHA-256 sampling fixture with exact integer arithmetic", () => {
  assert.equal(sampling.seed, "graft-ai-otel-v1");
  for (const fixture of sampling.traceIds) {
    const prefix = createHash("sha256")
      .update(`${fixture.traceId}${sampling.seed}`, "utf8")
      .digest("hex")
      .slice(0, 16);
    assert.equal(prefix, fixture.sha256Prefix, fixture.traceId);
    for (const { decimal, ratePpm } of sampling.rates) {
      assert.equal(
        samplingDecision(fixture.traceId, sampling.seed, ratePpm),
        fixture.decisions[decimal],
        `${fixture.traceId} at ${decimal}`,
      );
    }
  }
});

test("pins sampling rejection fixtures", () => {
  assert.deepEqual(sampling.invalidRates, ["-0.1", "1.000001", "2"]);
  assert.equal(sampling.priorityOverridesRejected, true);
});

test("pins canonical metrics, labels, and duration buckets", () => {
  assert.deepEqual(contracts.metrics.canonicalNames, [
    "ai_gateway_requests_total",
    "ai_gateway_errors_total",
    "ai_gateway_request_duration_seconds",
  ]);
  assert.deepEqual(contracts.metrics.allowedLabels, [
    "model",
    "provider",
    "status_code",
    "env",
    "gateway",
  ]);
  assert.deepEqual(contracts.metrics.durationBucketsSeconds, [
    0.005,
    0.01,
    0.025,
    0.05,
    0.1,
    0.25,
    0.5,
    1,
    2.5,
    5,
    10,
    "+Inf",
  ]);
});

test("pins spanlogs redaction and serialized-size contracts", () => {
  assert.deepEqual(contracts.spanlogs, {
    maxLineBytes: 262144,
    allowlistedFields: goContracts.allowlistedFields,
    lokiLabels: goContracts.lokiLabels,
    payloadDropReasons: goContracts.payloadDropReasons,
    truncatedSuffix: goContracts.truncatedSuffix,
  });
});

test("spanlogs contract matches Go implementation", () => {
  assert.equal(contracts.spanlogs.maxLineBytes, goContracts.maxLineBytes);
  assert.deepEqual(
    contracts.spanlogs.allowlistedFields,
    goContracts.allowlistedFields,
  );
  assert.deepEqual(contracts.spanlogs.lokiLabels, goContracts.lokiLabels);
  assert.deepEqual(
    contracts.spanlogs.payloadDropReasons,
    goContracts.payloadDropReasons,
  );
  assert.equal(contracts.spanlogs.truncatedSuffix, goContracts.truncatedSuffix);
});

test("keeps retention payload export fail-closed", () => {
  assert.deepEqual(contracts.retention.reasons, [
    "retention_unavailable",
    "retention_lookup_failed",
    "retention_invalid",
    "retention_exceeds_14d",
  ]);
  assert.equal(contracts.retention.maxPayloadRetentionDays, 14);
  assert.equal(contracts.retention.fixtures.valid14d.enabled, true);
  assert.equal(contracts.retention.fixtures.valid14d.reason, null);
  assert.equal(contracts.retention.fixtures.valid1d.enabled, true);
  for (const reason of contracts.retention.reasons) {
    const fixture = Object.values(contracts.retention.fixtures).find(
      (candidate) => candidate.reason === reason,
    );
    assert.ok(fixture, `missing fixture for ${reason}`);
    assert.equal(fixture.enabled, false);
  }
});

test("keeps retention duration parsing bounded to positive fourteen days", () => {
  const validDurations = [1, 14].map((days) => days * dayMs);
  assert.deepEqual(validDurations, [dayMs, 14 * dayMs]);
  assert.equal(contracts.retention.maxPayloadRetentionDays * dayMs, 14 * dayMs);
});

test("pins self-hosted Prometheus retention to one fourteen-day command flag", () => {
  assert.deepEqual(extractPrometheusRetentionValues(compose), ["14d"]);
  assert.equal(hasCanonicalPrometheusRetention(compose), true);
});

test("detects invalid or multiple self-hosted Prometheus retention flags", () => {
  const canonicalFlag = "--storage.tsdb.retention.time=14d";
  const invalidValue = compose.replace(
    canonicalFlag,
    "--storage.tsdb.retention.time=30d",
  );
  const malformedValue = compose.replace(
    canonicalFlag,
    "--storage.tsdb.retention.time=14days",
  );
  const duplicateValue = compose.replace(
    canonicalFlag,
    `${canonicalFlag}\n      - ${canonicalFlag}`,
  );
  const conflictingValues = compose.replace(
    canonicalFlag,
    `${canonicalFlag}\n      - --storage.tsdb.retention.time=30d`,
  );

  assert.deepEqual(extractPrometheusRetentionValues(invalidValue), ["30d"]);
  assert.deepEqual(extractPrometheusRetentionValues(malformedValue), [
    "14days",
  ]);
  assert.deepEqual(extractPrometheusRetentionValues(duplicateValue), [
    "14d",
    "14d",
  ]);
  assert.deepEqual(extractPrometheusRetentionValues(conflictingValues), [
    "14d",
    "30d",
  ]);
  for (const invalidCompose of [
    invalidValue,
    malformedValue,
    duplicateValue,
    conflictingValues,
  ]) {
    assert.equal(hasCanonicalPrometheusRetention(invalidCompose), false);
  }
});
