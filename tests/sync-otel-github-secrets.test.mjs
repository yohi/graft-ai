import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import assert from "node:assert/strict";

const root = resolve(import.meta.dirname, "..");
const script = resolve(root, "scripts/sync-otel-github-secrets.sh");

function createFixture({ missingOutput = false } = {}) {
  const directory = mkdtempSync(join(tmpdir(), "graft-ai-otel-sync-"));
  const binDirectory = join(directory, "bin");
  mkdirSync(binDirectory);
  const adminEnv = join(directory, "admin.env");
  const capture = join(directory, "gh-capture");

  writeFileSync(
    adminEnv,
    [
      "OTEL_INGEST_TOKEN=test-ingest-token",
      "OTEL_RATE_LIMIT_HMAC_KEY=test-hmac-key",
    ].join("\n") + "\n",
  );

  writeExecutable(
    join(binDirectory, "terraform"),
    `#!/usr/bin/env bash
set -euo pipefail
name="\${@: -1}"
case "$name" in
  grafana_otlp_url)
    ${missingOutput ? "exit 1" : "printf '%s' 'https://otlp.example'"}
    ;;
  grafana_otlp_username) printf '%s' '999999' ;;
  grafana_loki_url) printf '%s' 'https://logs.example' ;;
  grafana_prometheus_username) printf '%s' '123456' ;;
  grafana_loki_username) printf '%s' '654321' ;;
  grafana_telemetry_write_token) printf '%s' 'telemetry-token' ;;
  grafana_loki_write_token) printf '%s' 'loki-token' ;;
  *) exit 1 ;;
esac
`,
  );
  writeExecutable(
    join(binDirectory, "gh"),
    `#!/usr/bin/env bash
set -euo pipefail
[[ "$1" == secret && "$2" == set ]]
name="$3"
value="$(< /dev/stdin)"
printf '%s=%s\\n' "$name" "$value" >> "$GH_CAPTURE"
`,
  );

  return {
    adminEnv,
    capture,
    env: {
      ...process.env,
      GH_CAPTURE: capture,
      PATH: `${binDirectory}:${process.env.PATH}`,
    },
    cleanup: () => rmSync(directory, { force: true, recursive: true }),
  };
}

function writeExecutable(path, content) {
  writeFileSync(path, content);
  chmodSync(path, 0o700);
}

function runScript(fixture, ...args) {
  return spawnSync(
    "bash",
    [
      script,
      "--admin-env",
      fixture.adminEnv,
      "--repo",
      "yohi/graft-ai",
      ...args,
    ],
    { cwd: root, encoding: "utf8", env: fixture.env },
  );
}

test("dry-run lists secret names without printing secret values", () => {
  const fixture = createFixture();
  try {
    const result = runScript(fixture, "--dry-run");
    const output = `${result.stdout}${result.stderr}`;

    assert.equal(result.status, 0, output);
    for (const name of [
      "OTEL_INGEST_TOKEN",
      "OTEL_RATE_LIMIT_HMAC_KEY",
      "GRAFANA_CLOUD_OTLP_TRACES_URL",
      "GRAFANA_CLOUD_OTLP_METRICS_URL",
      "GRAFANA_CLOUD_OTLP_AUTHORIZATION",
      "GRAFANA_CLOUD_LOKI_URL",
      "GRAFANA_CLOUD_LOKI_AUTHORIZATION",
    ]) {
      assert.match(output, new RegExp(name));
    }
    assert.doesNotMatch(
      output,
      /test-ingest-token|test-hmac-key|telemetry-token|loki-token/,
    );
  } finally {
    fixture.cleanup();
  }
});

test("missing Grafana Terraform outputs stop with the apply instruction", () => {
  const fixture = createFixture({ missingOutput: true });
  try {
    const result = runScript(fixture, "--dry-run");
    const output = `${result.stdout}${result.stderr}`;

    assert.notEqual(result.status, 0, output);
    assert.match(output, /grafana_otlp_url/);
    assert.match(output, /make apply-grafana/);
    assert.doesNotMatch(output, /test-ingest-token|test-hmac-key/);
  } finally {
    fixture.cleanup();
  }
});

test("sync sends ten Grafana and OTel secrets through stdin without exposing values", () => {
  const fixture = createFixture();
  try {
    const result = runScript(fixture);
    const output = `${result.stdout}${result.stderr}`;
    assert.equal(result.status, 0, output);
    assert.ok(existsSync(fixture.capture), output);
    const captured = readFileSync(fixture.capture, "utf8").trim().split("\n");
    const expected = new Map([
      ["OTEL_INGEST_TOKEN", "test-ingest-token"],
      ["OTEL_RATE_LIMIT_HMAC_KEY", "test-hmac-key"],
        ["GRAFANA_CLOUD_OTLP_TRACES_URL", "https://otlp.example/otlp/v1/traces"],
      [
        "GRAFANA_CLOUD_OTLP_METRICS_URL",
        "https://otlp.example/otlp/v1/metrics",
      ],
      [
        "GRAFANA_CLOUD_OTLP_AUTHORIZATION",
        `Basic ${Buffer.from("999999:telemetry-token").toString("base64")}`,
      ],
      ["GRAFANA_CLOUD_PROMETHEUS_URL", "https://otlp.example/otlp"],
      ["GRAFANA_CLOUD_PROMETHEUS_USERNAME", "999999"],
      ["GRAFANA_CLOUD_ACCESS_POLICY_TOKEN", "telemetry-token"],
      ["GRAFANA_CLOUD_LOKI_URL", "https://logs.example/loki/api/v1/push"],
      [
        "GRAFANA_CLOUD_LOKI_AUTHORIZATION",
        `Basic ${Buffer.from("654321:loki-token").toString("base64")}`,
      ],
    ]);

    assert.deepEqual(
      new Map(captured.map((line) => line.split(/=(.*)/s, 2))),
      expected,
    );
    assert.doesNotMatch(
      output,
      /test-ingest-token|test-hmac-key|telemetry-token|loki-token/,
    );
  } finally {
    fixture.cleanup();
  }
});
