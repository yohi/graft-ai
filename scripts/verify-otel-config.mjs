import { readFileSync } from "node:fs";
import { resolve } from "node:path";

export function extractPrometheusRetentionValues(compose) {
  const lines = compose.split(/\r?\n/);
  const serviceStart = lines.findIndex((line) =>
    /^  prometheus:\s*$/.test(line),
  );
  if (serviceStart === -1) return [];

  const commandValues = [];
  let commandStarted = false;
  for (const line of lines.slice(serviceStart + 1)) {
    if (/^  \S/.test(line)) break;

    const commandMatch = line.match(/^    command:\s*(.*)$/);
    if (commandMatch) {
      commandStarted = true;
      if (commandMatch[1] !== "") commandValues.push(commandMatch[1]);
      continue;
    }
    if (!commandStarted) continue;

    const itemMatch = line.match(/^\s{6}-\s*(.*)$/);
    if (itemMatch) {
      commandValues.push(itemMatch[1]);
      continue;
    }
    if (line.trim() === "") continue;
    break;
  }

  return commandValues.flatMap((value) =>
    [...value.matchAll(/--storage\.tsdb\.retention\.time=([^\s,\]"']+)/g)].map(
      ([, retention]) => retention,
    ),
  );
}

export function hasCanonicalPrometheusRetention(compose) {
  const retentionValues = extractPrometheusRetentionValues(compose);
  return retentionValues.length === 1 && retentionValues[0] === "14d";
}

export function hasOnlyLoopbackGrafanaPorts(grafanaBlock) {
  const lines = grafanaBlock.split(/\r?\n/);
  const portsStart = lines.findIndex((line) => /^    ports:\s*$/.test(line));
  if (portsStart === -1) return false;

  const ports = [];
  for (const line of lines.slice(portsStart + 1)) {
    if (/^    \S/.test(line)) break;
    if (line.trim() === "") continue;
    const portMatch = line.match(/^\s{6}-\s*(?:"([^"]+)"|(\S+))\s*$/);
    if (!portMatch) return false;
    ports.push(portMatch[1] ?? portMatch[2]);
  }

  return (
    ports.length > 0 && ports.every((port) => port.startsWith("127.0.0.1:"))
  );
}

function verifyOtelConfig() {
  const root = resolve(import.meta.dirname, "..");
  const compose = readFileSync(
    resolve(root, "deploy/otel/docker-compose.yml"),
    "utf8",
  );
  const tempo = readFileSync(
    resolve(root, "deploy/otel/config/tempo.yaml"),
    "utf8",
  );
  const loki = readFileSync(
    resolve(root, "deploy/otel/config/loki.yaml"),
    "utf8",
  );
  const dashboard = JSON.parse(
    readFileSync(
      resolve(root, "grafana/dashboards/graft-ai-otel.json"),
      "utf8",
    ),
  );

  const imageLines = compose
    .split("\n")
    .filter((line) => line.trimStart().startsWith("image:"));
  if (
    imageLines.length < 5 ||
    imageLines.some((line) => !line.includes("@sha256:"))
  ) {
    throw new Error("all OTel Compose images must be digest-pinned");
  }
  for (const forbidden of [
    "0.0.0.0/0",
    "::/0",
    "OTEL_INGEST_TOKEN:",
    "Authorization:",
  ]) {
    if (compose.includes(forbidden)) {
      throw new Error(
        `OTel Compose contains forbidden inline trust or credential value: ${forbidden}`,
      );
    }
  }
  if (!compose.includes("OTEL_TRUSTED_PROXY_CIDRS: 172.30.0.10/32")) {
    throw new Error(
      "production Compose must trust only the cloudflared address",
    );
  }
  for (const service of [
    "alloy",
    "tempo",
    "loki",
    "prometheus",
    "cloudflared",
  ]) {
    const block =
      compose.match(
        new RegExp(`\\n  ${service}:[\\s\\S]*?(?=\\n  [a-z]|\\nvolumes:)`),
      )?.[0] ?? "";
    if (block === "") {
      throw new Error(`${service} block not found in OTel Compose`);
    }
    if (block.includes("\n    ports:")) {
      throw new Error(`${service} must not publish a host port`);
    }
  }
  const grafanaBlock =
    compose.match(/\n  grafana:[\s\S]*?(?=\n  [a-z]|\nvolumes:)/)?.[0] ?? "";
  if (grafanaBlock === "") {
    throw new Error("grafana block not found in OTel Compose");
  }
  if (!hasOnlyLoopbackGrafanaPorts(grafanaBlock)) {
    throw new Error("grafana must publish a loopback host port only");
  }
  if (
    !compose.includes("--web.enable-otlp-receiver") ||
    !compose.includes("--enable-feature=otlp-deltatocumulative")
  ) {
    throw new Error(
      "Prometheus OTLP receiver is not enabled with delta-to-cumulative conversion",
    );
  }
  if (!hasCanonicalPrometheusRetention(compose)) {
    throw new Error(
      "self-hosted Prometheus retention must have exactly one 14d command flag",
    );
  }
  if (
    !tempo.includes("block_retention: 336h") ||
    !loki.includes("retention_period: 168h")
  ) {
    throw new Error(
      "self-hosted OTel retention is not configured to the contract",
    );
  }
  if (dashboard.dashboard?.uid !== "graft-ai-otel-observability") {
    throw new Error("OTel dashboard UID is not canonical");
  }
  process.stdout.write("OTel configuration validation passed\n");
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) ===
    resolve(import.meta.dirname, "verify-otel-config.mjs")
) {
  verifyOtelConfig();
}
