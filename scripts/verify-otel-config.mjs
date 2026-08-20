import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const compose = readFileSync(resolve(root, "deploy/otel/docker-compose.yml"), "utf8");
const tempo = readFileSync(resolve(root, "deploy/otel/config/tempo.yaml"), "utf8");
const loki = readFileSync(resolve(root, "deploy/otel/config/loki.yaml"), "utf8");
const dashboard = JSON.parse(readFileSync(resolve(root, "grafana/dashboards/graft-ai-otel.json"), "utf8"));

const imageLines = compose.split("\n").filter((line) => line.trimStart().startsWith("image:"));
if (imageLines.length < 5 || imageLines.some((line) => !line.includes("@sha256:"))) {
  throw new Error("all OTel Compose images must be digest-pinned");
}
for (const forbidden of ["0.0.0.0/0", "::/0", "OTEL_INGEST_TOKEN:", "Authorization:"]) {
  if (compose.includes(forbidden)) {
    throw new Error(`OTel Compose contains forbidden inline trust or credential value: ${forbidden}`);
  }
}
if (!compose.includes("OTEL_TRUSTED_PROXY_CIDRS: 172.30.0.10/32")) {
  throw new Error("production Compose must trust only the cloudflared address");
}
for (const service of ["alloy", "tempo", "loki", "prometheus", "cloudflared", "grafana"]) {
  const block = compose.match(new RegExp(`\\n  ${service}:[\\s\\S]*?(?=\\n  [a-z]|\\nvolumes:)`))?.[0] ?? "";
  if (block === "") {
    throw new Error(`${service} block not found in OTel Compose`);
  }
  if (block.includes("\n    ports:")) {
    throw new Error(`${service} must not publish a host port`);
  }
}
if (!compose.includes("--web.enable-otlp-receiver") || !compose.includes("--enable-feature=otlp-deltatocumulative")) {
  throw new Error("Prometheus OTLP receiver is not enabled with delta-to-cumulative conversion");
}
if (!tempo.includes("block_retention: 336h") || !loki.includes("retention_period: 168h")) {
  throw new Error("self-hosted OTel retention is not configured to the contract");
}
if (dashboard.dashboard?.uid !== "graft-ai-otel-observability") {
  throw new Error("OTel dashboard UID is not canonical");
}
process.stdout.write("OTel configuration validation passed\n");
