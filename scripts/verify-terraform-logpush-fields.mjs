#!/usr/bin/env node
// Verifies that terraform/main.tf includes all Logpush fields required by
// workers/src/transform.ts. Run via `node scripts/verify-terraform-logpush-fields.mjs`.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const REQUIRED_FIELDS = [
  "RequestID",
  "RequestTime",
  "CacheStatus",
  "StatusCode",
  "Model",
  "PromptTokens",
  "CompletionTokens",
  "TotalTokens",
  "RequestDuration",
  "Path",
  "Method",
  "Metadata",
  "RequestBody",
  "ResponseBody",
];

const tfPath = resolve(__dirname, "../terraform/main.tf");
const content = readFileSync(tfPath, "utf8");

const start = content.indexOf("field_names = [");
if (start === -1) {
  console.error("field_names block not found");
  process.exit(1);
}
const end = content.indexOf("]", start);
if (end === -1) {
  console.error("field_names block not terminated");
  process.exit(1);
}
const block = content.slice(start, end + 1);
const fields = new Set(
  Array.from(block.matchAll(/"([A-Za-z]+)"/g), (match) => match[1]),
);

const missing = REQUIRED_FIELDS.filter((required) => !fields.has(required));
if (missing.length > 0) {
  console.error(`Missing required Logpush fields: ${missing.join(", ")}`);
  process.exit(1);
}

console.log(`All ${REQUIRED_FIELDS.length} required fields present.`);
