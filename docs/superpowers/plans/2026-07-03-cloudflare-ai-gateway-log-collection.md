# Cloudflare AI Gateway Log Collection Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a Cloudflare Worker that receives encrypted AI Gateway Logpush logs, decrypts/decompresses them, transforms each log line into Loki JSON streams format, and pushes to Grafana Cloud Loki — all provisioned via Terraform.

**Architecture:** A single TypeScript Cloudflare Worker handles the full inbound pipeline: verify origin-secret header → decompress gzip body → decrypt each log line (RSA-OAEP unwrap AES-GCM key, AES-GCM decrypt payload) → parse NDJSON → transform to Loki push format with 4 fixed labels → push to Grafana Cloud Loki via HTTPS with Basic Auth. The Worker is deployed via Wrangler; Terraform provisions only the Logpush job. Unit tests run inside the Workers runtime using `@cloudflare/vitest-pool-workers`.

**Tech Stack:** TypeScript, Cloudflare Workers, Web Crypto API (RSA-OAEP-SHA256 + AES-GCM), `DecompressionStream("gzip")`, Wrangler v4, Vitest v4 with `@cloudflare/vitest-pool-workers`, Terraform with Cloudflare provider v5, Grafana Cloud Loki HTTP push API.

> **Implementation status (as of 2026-07-04):** Most code/tasks are complete and verified. Tests pass (46/46), typecheck passes, `terraform validate` passes, and `make fmt` is clean. The `X-Origin-Secret` validation described in the Architecture/Global Constraints is implemented in `workers/src/index.ts`; the secret is defined in `workers/.dev.vars.example` and sent via Terraform `header_X-Origin-Secret`. Tasks 9 and 10 require real Cloudflare/Grafana credentials and deployment, so they remain unchecked.

## Global Constraints

- Workers implementation language: TypeScript (spec §9 — TypeScript 推奨).
- Infrastructure as Code: Terraform with `cloudflare/cloudflare` provider v5.x (spec §2, §3.3).
- Secrets (Grafana token, Cloudflare API token) must NOT be stored in `*.tfvars`; inject via environment variables or Workers secret bindings (spec §3.3, §6.1).
- HTTPS only for Logpush → Workers and Workers → Loki (spec §6.3).
- Loki push uses HTTP Basic Auth: username = Grafana Cloud Loki tenant ID (User value from portal), password = `logs:write` scope Access Policy Token (spec §6.3).
- Workers ingress must validate `X-Origin-Secret` header against `env.ORIGIN_SECRET`; mismatch returns 4xx to avoid Logpush retries (spec §6.4).
- Exclude user IP, auth headers, full prompts, response bodies from logs (spec §6.5).
- Loki labels limited to exactly 4: `model`, `status_code`, `env`, `gateway` (spec §4.4, §7.3).
- Grafana Cloud Free Tier: 14-day retention, 50 GB/month logs, 10k active series (spec §7.2, README).
- Terraform state should use a remote encrypted backend (spec §3.3, §6.2) — local state acceptable for initial dev; switch before production.
- Logpush to HTTP destination does NOT require `ownership_challenge` (Cloudflare docs: HTTP destination).
- Logpush HTTP destination supports `header_*` URL query params to set custom request headers (e.g. `header_X-Origin-Secret`).
- Worker deployment is handled by Wrangler (`npx wrangler deploy`); Terraform manages only the Logpush job.
- Pre-implementation verification required (spec §9): exact Logpush dataset name, field names, `RequestTime` unit, Grafana Cloud Loki token issuance, Terraform remote backend selection.

---

## File Structure

```
graft-ai/
├── workers/
│   ├── src/
│   │   ├── index.ts          # Worker fetch handler: orchestrates decompress→decrypt→transform→push
│   │   ├── crypto.ts          # RSA-OAEP unwrap + AES-GCM decrypt for encrypted log fields
│   │   ├── transform.ts       # NDJSON line → Loki stream entry (timestamp, labels, log line)
│   │   ├── loki.ts            # Loki push client with retry/backoff for 429
│   │   └── types.ts           # Shared TypeScript types (Env, AIGatewayLog, LokiStream, etc.)
│   ├── tests/
│   │   ├── crypto.test.ts     # Unit tests for decryption module
│   │   ├── transform.test.ts  # Unit tests for transformation module
│   │   ├── loki.test.ts       # Unit tests for Loki push with mocked fetch
│   │   └── index.test.ts      # Integration test for full fetch handler
│   ├── package.json
│   ├── tsconfig.json
│   ├── vitest.config.ts
│   ├── wrangler.jsonc
│   └── .dev.vars              # Local dev secrets (gitignored)
├── terraform/
│   ├── main.tf                # Cloudflare Logpush job only; Worker script is deployed via Wrangler
│   ├── outputs.tf             # Useful outputs (worker URL, logpush job ID)
│   ├── versions.tf            # Provider version constraints
│   └── terraform.tfvars.example  # Non-secret variable examples (gitignored actual tfvars)
├── tests/
│   └── fixtures/
│       └── sample_aigateway_log.json  # NDJSON test fixture (spec §8.2)
├── .gitignore                 # Add: workers/.dev.vars, terraform/terraform.tfvars, terraform/.terraform/
└── Makefile                   # Convenience targets (fmt, validate, test, plan, apply, deploy)
```

**Responsibilities:**

- `workers/src/types.ts` — Shared types only. No logic. Prevents circular deps.
- `workers/src/crypto.ts` — All Web Crypto operations: import RSA private key, unwrap AES key, decrypt AES-GCM ciphertext. Pure async functions, no I/O.
- `workers/src/transform.ts` — Pure functions: parse NDJSON, normalize model name, convert timestamp to nanoseconds, build Loki stream entry. No network calls.
- `workers/src/loki.ts` — Loki HTTP push client with Basic Auth, 429 retry/backoff logic. Takes a `fetch`-compatible function for testability.
- `workers/src/index.ts` — Worker `fetch` handler. Orchestrates: auth check → decompress → decrypt → transform → push. Returns appropriate HTTP status codes.
- `terraform/main.tf` — Single file with the Cloudflare `cloudflare_logpush_job`; Worker script is deployed via Wrangler.
- `terraform/variables.tf` — Input variables including `workers_subdomain` for the Worker URL.

---

### Task 1: Workers Project Scaffold

**Files:**
- Create: `workers/package.json`
- Create: `workers/tsconfig.json`
- Create: `workers/wrangler.jsonc`
- Create: `workers/vitest.config.ts`
- Create: `workers/src/types.ts`
- Create: `workers/.dev.vars.example`
- Modify: `.gitignore`

**Interfaces:**
- Consumes: nothing (first task)
- Produces: `Env` interface in `workers/src/types.ts` with fields: `GRAFANA_CLOUD_LOKI_URL: string`, `GRAFANA_CLOUD_LOKI_USERNAME: string`, `GRAFANA_CLOUD_ACCESS_POLICY_TOKEN: string`, `ORIGIN_SECRET: string`, `RSA_PRIVATE_KEY_PEM: string`, `GATEWAY_NAME: string`, `ENV_LABEL: string`

- [x] **Step 1: Create `workers/package.json`**

```json
{
  "name": "graft-ai-aig-logpush-worker",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "wrangler dev",
    "deploy": "wrangler deploy",
    "test": "vitest run",
    "test:watch": "vitest",
    "typecheck": "tsc --noEmit",
    "cf-typegen": "wrangler types"
  },
  "devDependencies": {
    "@cloudflare/vitest-pool-workers": "^4.1.0",
    "typescript": "^5.9.0",
    "vitest": "^4.1.0",
    "wrangler": "^4.0.0"
  }
}
```

- [x] **Step 2: Create `workers/tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "esnext",
    "module": "esnext",
    "moduleResolution": "bundler",
    "lib": ["esnext"],
    "types": ["./worker-configuration.d.ts"],
    "strict": true,
    "noUnusedLocals": true,
    "noUnusedParameters": true,
    "noUncheckedIndexedAccess": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "isolatedModules": true,
    "verbatimModuleSyntax": true,
    "declaration": false,
    "outDir": "./dist",
    "rootDir": "."
  },
  "include": ["src/**/*.ts", "tests/**/*.ts"],
  "exclude": ["node_modules", "dist"]
}
```

- [x] **Step 3: Create `workers/wrangler.jsonc`**

```jsonc
{
  "$schema": "node_modules/wrangler/config-schema.json",
  "name": "graft-ai-aig-logpush",
  "main": "src/index.ts",
  "compatibility_date": "2026-07-01",
  "compatibility_flags": ["nodejs_compat"],
  "observability": {
    "enabled": true
  },
  "vars": {
    "GATEWAY_NAME": "main",
    "ENV_LABEL": "prod"
  }
}
```

- [x] **Step 4: Create `workers/vitest.config.ts`**

```ts
import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
    }),
  ],
});
```

- [ ] **Step 5: Create `workers/src/types.ts`**

```ts
export interface Env {
  GRAFANA_CLOUD_LOKI_URL: string;
  GRAFANA_CLOUD_LOKI_USERNAME: string;
  GRAFANA_CLOUD_ACCESS_POLICY_TOKEN: string;
  ORIGIN_SECRET: string;
  RSA_PRIVATE_KEY_PEM: string;
  GATEWAY_NAME: string;
  ENV_LABEL: string;
}

export interface AIGatewayLog {
  RequestID: string;
  RequestTime: number;
  CacheStatus: string;
  StatusCode: number;
  Model: string;
  PromptTokens: number;
  CompletionTokens: number;
  TotalTokens: number;
  RequestDuration: number;
  Path: string;
  Method: string;
  RequestHeaders?: Record<string, string>;
  ResponseHeaders?: Record<string, string>;
  Metadata?: EncryptedField;
  RequestBody?: EncryptedField;
  ResponseBody?: EncryptedField;
  [key: string]: unknown;
}

export interface EncryptedField {
  key: string;
  iv: string;
  data: string;
}

export interface LokiStream {
  stream: {
    model: string;
    status_code: string;
    env: string;
    gateway: string;
  };
  values: [string, string][];
}

export interface LokiPushPayload {
  streams: LokiStream[];
}
```

- [ ] **Step 6: Create `workers/.dev.vars.example`**

```bash
# Copy to .dev.vars and fill with real values for local development
# For production, set secrets via `npx wrangler secret put`.
GRAFANA_CLOUD_LOKI_URL=https://logs-prod-xxx.grafana.net
GRAFANA_CLOUD_LOKI_USERNAME=123456
GRAFANA_CLOUD_ACCESS_POLICY_TOKEN=glc_xxxxxxxxxxxx
ORIGIN_SECRET=your-random-origin-secret-here
RSA_PRIVATE_KEY_PEM=-----BEGIN PRIVATE KEY-----\\n...\\n-----END PRIVATE KEY-----
```

- [x] **Step 7: Update `.gitignore`**

Append these lines to the project root `.gitignore`:

```gitignore
# Workers
workers/node_modules/
workers/.dev.vars
workers/.wrangler/
workers/dist/
workers/worker-configuration.d.ts

# Terraform
terraform/.terraform/
terraform/terraform.tfstate
terraform/terraform.tfstate.backup
terraform/terraform.tfvars

# OS
.DS_Store
```

- [x] **Step 8: Install dependencies and generate types**

Run from `workers/` directory:

```bash
cd workers && npm install && npx wrangler types
```

Expected: `node_modules/` created, `worker-configuration.d.ts` generated, no errors.

- [x] **Step 9: Verify typecheck passes**

Run: `cd workers && npx tsc --noEmit`
Expected: PASS with no output (no type errors).

- [x] **Step 10: Commit**

```bash
git add workers/ .gitignore
git commit -m "feat: scaffold Cloudflare Workers project for AI Gateway log collection"
```

---

### Task 2: Test Fixture — Sample AI Gateway NDJSON

**Files:**
- Create: `tests/fixtures/sample_aigateway_log.json`

**Interfaces:**
- Consumes: `AIGatewayLog` type from Task 1
- Produces: NDJSON fixture file used by all subsequent test tasks

- [x] **Step 1: Create the fixture file**

Create `tests/fixtures/sample_aigateway_log.json` with NDJSON (one JSON object per line, no trailing newline):

```json
{"RequestID":"req-001","RequestTime":1720032000,"CacheStatus":"miss","StatusCode":200,"Model":"@cf/meta/llama-3.1-8b-instruct","PromptTokens":150,"CompletionTokens":80,"TotalTokens":230,"RequestDuration":1250,"Path":"/v1/chat/completions","Method":"POST","RequestHeaders":{"Content-Type":"application/json"},"ResponseHeaders":{"Content-Type":"application/json"}}
{"RequestID":"req-002","RequestTime":1720032060,"CacheStatus":"hit","StatusCode":200,"Model":"@cf/meta/llama-3.1-8b-instruct","PromptTokens":200,"CompletionTokens":120,"TotalTokens":420,"RequestDuration":50,"Path":"/v1/chat/completions","Method":"POST","RequestHeaders":{"Content-Type":"application/json"},"ResponseHeaders":{"Content-Type":"application/json"}}
{"RequestID":"req-003","RequestTime":1720032120,"CacheStatus":"miss","StatusCode":400,"Model":"@cf/meta/llama-3.1-8b-instruct","PromptTokens":10,"CompletionTokens":0,"TotalTokens":10,"RequestDuration":100,"Path":"/v1/chat/completions","Method":"POST","RequestHeaders":{"Content-Type":"application/json"},"ResponseHeaders":{"Content-Type":"application/json"}}
{"RequestID":"req-004","RequestTime":1720032180,"CacheStatus":"miss","StatusCode":500,"Model":"@cf/meta/llama-3.1-70b-instruct","PromptTokens":300,"CompletionTokens":0,"TotalTokens":300,"RequestDuration":5000,"Path":"/v1/chat/completions","Method":"POST","RequestHeaders":{"Content-Type":"application/json"},"ResponseHeaders":{"Content-Type":"application/json"}}
{"RequestID":"req-005","RequestTime":1720032240,"CacheStatus":"miss","StatusCode":200,"Model":"@cf/meta/llama-3.1-70b-instruct","PromptTokens":500,"CompletionTokens":250,"TotalTokens":750,"RequestDuration":3000,"Path":"/v1/chat/completions","Method":"POST","RequestHeaders":{"Content-Type":"application/json"},"ResponseHeaders":{"Content-Type":"application/json"}}
```

This covers: status 200 (×3), 400, 500; two models (`llama-3.1-8b-instruct`, `llama-3.1-70b-instruct`); cache miss/hit; `RequestTime` in seconds (10-digit epoch).

- [x] **Step 2: Commit**

```bash
git add tests/fixtures/sample_aigateway_log.json
git commit -m "test: add sample AI Gateway NDJSON fixture with 200/400/500 status codes"
```

---

### Task 3: Crypto Module — RSA Unwrap + AES-GCM Decrypt

**Files:**
- Create: `workers/src/crypto.ts`
- Create: `workers/tests/crypto.test.ts`

**Interfaces:**
- Consumes: `EncryptedField` from `workers/src/types.ts` (Task 1)
- Produces: `importRsaPrivateKey(pem: string): Promise<CryptoKey>` — imports PKCS#8 PEM private key for RSA-OAEP-SHA256 decrypt.
- Produces: `decryptField(privateKey: CryptoKey, field: EncryptedField): Promise<string>` — unwraps AES-GCM key via RSA, then decrypts ciphertext, returns UTF-8 string.
- Produces: `decryptIfEncrypted(privateKey: CryptoKey, value: unknown): Promise<unknown>` — if value is `EncryptedField`, decrypts; otherwise returns as-is.

- [x] **Step 1: Write the failing test**

Create `workers/tests/crypto.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { importRsaPrivateKey, decryptField, decryptIfEncrypted } from "../src/crypto";
import type { EncryptedField } from "../src/types";

// Generate a test RSA key pair inside the Workers runtime
async function generateTestKeyPair(): Promise<{ privateKeyPem: string; publicKeyPem: string }> {
  const keyPair = await crypto.subtle.generateKey(
    {
      name: "RSA-OAEP",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["encrypt", "decrypt"],
  );

  const privateKeyDer = await crypto.subtle.exportKey("pkcs8", keyPair.privateKey);
  const publicKeyDer = await crypto.subtle.exportKey("spki", keyPair.publicKey);

  const privateKeyPem = pemEncode(privateKeyDer, "PRIVATE KEY");
  const publicKeyPem = pemEncode(publicKeyDer, "PUBLIC KEY");

  return { privateKeyPem, publicKeyPem };
}

function pemEncode(der: ArrayBuffer, type: string): string {
  const bytes = new Uint8Array(der);
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  const base64 = btoa(binary);
  const lines = base64.match(/.{1,64}/g) ?? [base64];
  return `-----BEGIN ${type}-----\n${lines.join("\n")}\n-----END ${type}-----`;
}

// Encrypt a string using hybrid encryption (RSA-OAEP + AES-GCM) matching Cloudflare's scheme
async function encryptForTest(publicKeyPem: string, plaintext: string): Promise<EncryptedField> {
  const pubKey = await crypto.subtle.importKey(
    "spki",
    derFromPem(publicKeyPem, "PUBLIC KEY"),
    { name: "RSA-OAEP", hash: "SHA-256" },
    true,
    ["encrypt"],
  );

  const aesKey = await crypto.subtle.generateKey(
    { name: "AES-GCM", length: 256 },
    true,
    ["encrypt", "decrypt"],
  );

  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encoder = new TextEncoder();
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    aesKey,
    encoder.encode(plaintext),
  );

  const aesKeyRaw = await crypto.subtle.exportKey("raw", aesKey);
  const wrappedKey = await crypto.subtle.encrypt(
    { name: "RSA-OAEP" },
    pubKey,
    aesKeyRaw,
  );

  return {
    key: base64Encode(wrappedKey),
    iv: base64Encode(iv.buffer),
    data: base64Encode(ciphertext),
  };
}

function derFromPem(pem: string, type: string): ArrayBuffer {
  const header = `-----BEGIN ${type}-----`;
  const footer = `-----END ${type}-----`;
  const b64 = pem.substring(header.length, pem.length - footer.length).replace(/\s/g, "");
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes.buffer;
}

function base64Encode(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}

describe("crypto module", () => {
  it("imports an RSA PKCS#8 private key from PEM", async () => {
    const { privateKeyPem } = await generateTestKeyPair();
    const key = await importRsaPrivateKey(privateKeyPem);
    expect(key).toBeDefined();
    expect(key.algorithm.name).toBe("RSA-OAEP");
  });

  it("decrypts an encrypted field back to original plaintext", async () => {
    const { privateKeyPem, publicKeyPem } = await generateTestKeyPair();
    const privateKey = await importRsaPrivateKey(privateKeyPem);
    const original = '{"model":"llama-3.1-8b","tokens":230}';
    const encrypted = await encryptForTest(publicKeyPem, original);
    const decrypted = await decryptField(privateKey, encrypted);
    expect(decrypted).toBe(original);
  });

  it("decryptIfEncrypted returns plaintext string for EncryptedField", async () => {
    const { privateKeyPem, publicKeyPem } = await generateTestKeyPair();
    const privateKey = await importRsaPrivateKey(privateKeyPem);
    const original = "hello world";
    const encrypted = await encryptForTest(publicKeyPem, original);
    const result = await decryptIfEncrypted(privateKey, encrypted);
    expect(result).toBe("hello world");
  });

  it("decryptIfEncrypted returns value as-is when not encrypted", async () => {
    const { privateKeyPem } = await generateTestKeyPair();
    const privateKey = await importRsaPrivateKey(privateKeyPem);
    const result = await decryptIfEncrypted(privateKey, "plain string value");
    expect(result).toBe("plain string value");
  });

  it("decryptIfEncrypted returns null as-is", async () => {
    const { privateKeyPem } = await generateTestKeyPair();
    const privateKey = await importRsaPrivateKey(privateKeyPem);
    const result = await decryptIfEncrypted(privateKey, null);
    expect(result).toBe(null);
  });
});
```

- [x] **Step 2: Run test to verify it fails**

Run: `cd workers && npx vitest run tests/crypto.test.ts`
Expected: FAIL with "Failed to resolve import" or "module not found" for `../src/crypto`.

- [x] **Step 3: Write the implementation**

Create `workers/src/crypto.ts`:

```ts
import type { EncryptedField } from "./types";

function pemToDer(pem: string): ArrayBuffer {
  const lines = pem
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("-----"));
  const base64 = lines.join("");
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes.buffer;
}

export async function importRsaPrivateKey(pem: string): Promise<CryptoKey> {
  const der = pemToDer(pem);
  return crypto.subtle.importKey(
    "pkcs8",
    der,
    { name: "RSA-OAEP", hash: "SHA-256" },
    false,
    ["decrypt"],
  );
}

function base64ToUint8Array(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

export async function decryptField(
  privateKey: CryptoKey,
  field: EncryptedField,
): Promise<string> {
  // 1. Unwrap AES-GCM key using RSA-OAEP-SHA256
  const wrappedKeyBuf = base64ToUint8Array(field.key);
  const aesKeyRaw = await crypto.subtle.decrypt(
    { name: "RSA-OAEP" },
    privateKey,
    wrappedKeyBuf,
  );

  const aesKey = await crypto.subtle.importKey(
    "raw",
    aesKeyRaw,
    { name: "AES-GCM", length: 256 },
    false,
    ["decrypt"],
  );

  // 2. Decrypt the data using AES-GCM
  const iv = base64ToUint8Array(field.iv);
  const ciphertext = base64ToUint8Array(field.data);
  const decrypted = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv },
    aesKey,
    ciphertext,
  );

  return new TextDecoder().decode(decrypted);
}

export async function decryptIfEncrypted(
  privateKey: CryptoKey,
  value: unknown,
): Promise<unknown> {
  if (value === null || value === undefined) {
    return value;
  }
  if (typeof value === "object" && value !== null && "key" in value && "iv" in value && "data" in value) {
    return decryptField(privateKey, value as EncryptedField);
  }
  return value;
}
```

- [x] **Step 4: Run tests to verify they pass**

Run: `cd workers && npx vitest run tests/crypto.test.ts`
Expected: PASS — all 5 tests pass.

- [x] **Step 5: Commit**

```bash
git add workers/src/crypto.ts workers/tests/crypto.test.ts
git commit -m "feat: add crypto module for RSA-OAEP unwrap and AES-GCM decrypt"
```

---

### Task 4: Transform Module — NDJSON to Loki Streams

**Files:**
- Create: `workers/src/transform.ts`
- Create: `workers/tests/transform.test.ts`

**Interfaces:**
- Consumes: `AIGatewayLog`, `LokiStream`, `LokiPushPayload` from `workers/src/types.ts` (Task 1)
- Produces: `normalizeModelName(modelId: string): string` — strips `@cf/<scope>/` prefix, returns model name portion.
- Produces: `requestTimeToNanos(requestTime: number): string` — auto-detects seconds (≤10 digits) vs milliseconds (13 digits), returns nanosecond timestamp as string.
- Produces: `buildLogLine(log: AIGatewayLog): string` — extracts selected fields and JSON-stringifies them.
- Produces: `transformLogToLokiStream(log: AIGatewayLog, gatewayName: string, envLabel: string): LokiStream` — builds a complete Loki stream entry with labels and values.
- Produces: `transformNdjsonToLokiPayload(ndjson: string, gatewayName: string, envLabel: string): LokiPushPayload` — parses NDJSON, transforms each line, groups by label set.

- [x] **Step 1: Write the failing test**

Create `workers/tests/transform.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import {
  normalizeModelName,
  requestTimeToNanos,
  buildLogLine,
  transformLogToLokiStream,
  transformNdjsonToLokiPayload,
} from "../src/transform";
import type { AIGatewayLog } from "../src/types";

describe("normalizeModelName", () => {
  it("strips @cf/meta/ prefix", () => {
    expect(normalizeModelName("@cf/meta/llama-3.1-8b-instruct")).toBe("llama-3.1-8b-instruct");
  });

  it("strips @cf/ prefix with multi-segment scope", () => {
    expect(normalizeModelName("@cf/openai/gpt-4o-mini")).toBe("gpt-4o-mini");
  });

  it("returns name as-is when no @cf/ prefix", () => {
    expect(normalizeModelName("gpt-4o")).toBe("gpt-4o");
  });

  it("returns empty string for empty input", () => {
    expect(normalizeModelName("")).toBe("");
  });
});

describe("requestTimeToNanos", () => {
  it("converts seconds (10-digit epoch) to nanoseconds", () => {
    expect(requestTimeToNanos(1720032000)).toBe("1720032000000000000");
  });

  it("converts milliseconds (13-digit epoch) to nanoseconds", () => {
    expect(requestTimeToNanos(1720032000000)).toBe("1720032000000000000");
  });

  it("handles 0 as seconds", () => {
    expect(requestTimeToNanos(0)).toBe("0");
  });
});

describe("buildLogLine", () => {
  it("builds JSON log line with selected fields in snake_case", () => {
    const log: AIGatewayLog = {
      RequestID: "abc123",
      RequestTime: 1720032000,
      CacheStatus: "miss",
      StatusCode: 200,
      Model: "@cf/meta/llama-3.1-8b-instruct",
      PromptTokens: 150,
      CompletionTokens: 80,
      TotalTokens: 230,
      RequestDuration: 1250,
      Path: "/v1/chat/completions",
      Method: "POST",
      RequestHeaders: { Authorization: "Bearer secret" },
      ResponseHeaders: { "X-Trace": "abc" },
    };
    const line = buildLogLine(log);
    const parsed = JSON.parse(line);
    expect(parsed.request_id).toBe("abc123");
    expect(parsed.cache_status).toBe("miss");
    expect(parsed.prompt_tokens).toBe(150);
    expect(parsed.completion_tokens).toBe(80);
    expect(parsed.total_tokens).toBe(230);
    expect(parsed.duration_ms).toBe(1250);
    expect(parsed.path).toBe("/v1/chat/completions");
    expect(parsed.method).toBe("POST");
    // Sensitive fields must NOT be present
    expect(parsed.RequestHeaders).toBeUndefined();
    expect(parsed.ResponseHeaders).toBeUndefined();
    expect(parsed.authorization).toBeUndefined();
  });
});

describe("transformLogToLokiStream", () => {
  it("creates a Loki stream with correct labels and values", () => {
    const log: AIGatewayLog = {
      RequestID: "req-001",
      RequestTime: 1720032000,
      CacheStatus: "miss",
      StatusCode: 200,
      Model: "@cf/meta/llama-3.1-8b-instruct",
      PromptTokens: 150,
      CompletionTokens: 80,
      TotalTokens: 230,
      RequestDuration: 1250,
      Path: "/v1/chat/completions",
      Method: "POST",
    };
    const stream = transformLogToLokiStream(log, "main", "prod");
    expect(stream.stream.model).toBe("llama-3.1-8b-instruct");
    expect(stream.stream.status_code).toBe("200");
    expect(stream.stream.env).toBe("prod");
    expect(stream.stream.gateway).toBe("main");
    expect(stream.values).toHaveLength(1);
    expect(stream.values[0]![0]).toBe("1720032000000000000");
    const logLine = JSON.parse(stream.values[0]![1]);
    expect(logLine.request_id).toBe("req-001");
  });

  it("uses 400 status code in label", () => {
    const log: AIGatewayLog = {
      RequestID: "req-003",
      RequestTime: 1720032120,
      CacheStatus: "miss",
      StatusCode: 400,
      Model: "@cf/meta/llama-3.1-8b-instruct",
      PromptTokens: 10,
      CompletionTokens: 0,
      TotalTokens: 10,
      RequestDuration: 100,
      Path: "/v1/chat/completions",
      Method: "POST",
    };
    const stream = transformLogToLokiStream(log, "main", "prod");
    expect(stream.stream.status_code).toBe("400");
  });
});

describe("transformNdjsonToLokiPayload", () => {
  it("groups log lines with identical labels into one stream", () => {
    const ndjson = [
      JSON.stringify({
        RequestID: "req-001",
        RequestTime: 1720032000,
        CacheStatus: "miss",
        StatusCode: 200,
        Model: "@cf/meta/llama-3.1-8b-instruct",
        PromptTokens: 150,
        CompletionTokens: 80,
        TotalTokens: 230,
        RequestDuration: 1250,
        Path: "/v1/chat/completions",
        Method: "POST",
      }),
      JSON.stringify({
        RequestID: "req-002",
        RequestTime: 1720032060,
        CacheStatus: "hit",
        StatusCode: 200,
        Model: "@cf/meta/llama-3.1-8b-instruct",
        PromptTokens: 200,
        CompletionTokens: 120,
        TotalTokens: 420,
        RequestDuration: 50,
        Path: "/v1/chat/completions",
        Method: "POST",
      }),
    ].join("\n");

    const payload = transformNdjsonToLokiPayload(ndjson, "main", "prod");
    expect(payload.streams).toHaveLength(1);
    expect(payload.streams[0]!.values).toHaveLength(2);
    expect(payload.streams[0]!.stream.model).toBe("llama-3.1-8b-instruct");
    expect(payload.streams[0]!.stream.status_code).toBe("200");
  });

  it("creates separate streams for different label combinations", () => {
    const ndjson = [
      JSON.stringify({
        RequestID: "req-001",
        RequestTime: 1720032000,
        CacheStatus: "miss",
        StatusCode: 200,
        Model: "@cf/meta/llama-3.1-8b-instruct",
        PromptTokens: 150,
        CompletionTokens: 80,
        TotalTokens: 230,
        RequestDuration: 1250,
        Path: "/v1/chat/completions",
        Method: "POST",
      }),
      JSON.stringify({
        RequestID: "req-004",
        RequestTime: 1720032180,
        CacheStatus: "miss",
        StatusCode: 500,
        Model: "@cf/meta/llama-3.1-70b-instruct",
        PromptTokens: 300,
        CompletionTokens: 0,
        TotalTokens: 300,
        RequestDuration: 5000,
        Path: "/v1/chat/completions",
        Method: "POST",
      }),
    ].join("\n");

    const payload = transformNdjsonToLokiPayload(ndjson, "main", "prod");
    expect(payload.streams).toHaveLength(2);
  });

  it("skips invalid JSON lines and continues", () => {
    const ndjson = [
      "this is not json",
      JSON.stringify({
        RequestID: "req-001",
        RequestTime: 1720032000,
        CacheStatus: "miss",
        StatusCode: 200,
        Model: "@cf/meta/llama-3.1-8b-instruct",
        PromptTokens: 150,
        CompletionTokens: 80,
        TotalTokens: 230,
        RequestDuration: 1250,
        Path: "/v1/chat/completions",
        Method: "POST",
      }),
    ].join("\n");

    const payload = transformNdjsonToLokiPayload(ndjson, "main", "prod");
    expect(payload.streams).toHaveLength(1);
    expect(payload.streams[0]!.values).toHaveLength(1);
  });

  it("handles empty input", () => {
    const payload = transformNdjsonToLokiPayload("", "main", "prod");
    expect(payload.streams).toHaveLength(0);
  });
});
```

- [x] **Step 2: Run test to verify it fails**

Run: `cd workers && npx vitest run tests/transform.test.ts`
Expected: FAIL with "Failed to resolve import" for `../src/transform`.

- [x] **Step 3: Write the implementation**

Create `workers/src/transform.ts`:

```ts
import type { AIGatewayLog, LokiStream, LokiPushPayload } from "./types";

export function normalizeModelName(modelId: string): string {
  if (modelId.startsWith("@cf/")) {
    const withoutPrefix = modelId.slice(4);
    const slashIndex = withoutPrefix.indexOf("/");
    if (slashIndex >= 0) {
      return withoutPrefix.slice(slashIndex + 1);
    }
    return withoutPrefix;
  }
  return modelId;
}

export function requestTimeToNanos(requestTime: number): string {
  const s = Math.floor(requestTime).toString();
  if (s.length <= 10) {
    // Seconds → nanoseconds
    return (BigInt(requestTime) * 1_000_000_000n).toString();
  }
  if (s.length <= 13) {
    // Milliseconds → nanoseconds
    return (BigInt(requestTime) * 1_000_000n).toString();
  }
  // Already nanoseconds (≥19 digits)
  return BigInt(requestTime).toString();
}

export function buildLogLine(log: AIGatewayLog): string {
  const line = {
    request_id: log.RequestID,
    cache_status: log.CacheStatus,
    prompt_tokens: log.PromptTokens,
    completion_tokens: log.CompletionTokens,
    total_tokens: log.TotalTokens,
    duration_ms: log.RequestDuration,
    path: log.Path,
    method: log.Method,
  };
  return JSON.stringify(line);
}

function labelKey(stream: { model: string; status_code: string; env: string; gateway: string }): string {
  return `${stream.model}|${stream.status_code}|${stream.env}|${stream.gateway}`;
}

export function transformLogToLokiStream(
  log: AIGatewayLog,
  gatewayName: string,
  envLabel: string,
): LokiStream {
  return {
    stream: {
      model: normalizeModelName(log.Model),
      status_code: log.StatusCode.toString(),
      env: envLabel,
      gateway: gatewayName,
    },
    values: [[requestTimeToNanos(log.RequestTime), buildLogLine(log)]],
  };
}

export function transformNdjsonToLokiPayload(
  ndjson: string,
  gatewayName: string,
  envLabel: string,
): LokiPushPayload {
  const lines = ndjson.split("\n").filter((line) => line.trim().length > 0);
  const streamMap = new Map<string, LokiStream>();

  for (const line of lines) {
    try {
      const log = JSON.parse(line) as AIGatewayLog;
      const stream = transformLogToLokiStream(log, gatewayName, envLabel);
      const key = labelKey(stream.stream);
      const existing = streamMap.get(key);
      if (existing) {
        existing.values.push(...stream.values);
      } else {
        streamMap.set(key, stream);
      }
    } catch (err) {
      // Skip invalid JSON line, log to console (Workers Logs)
      console.error(`Failed to parse log line: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return { streams: Array.from(streamMap.values()) };
}
```

- [x] **Step 4: Run tests to verify they pass**

Run: `cd workers && npx vitest run tests/transform.test.ts`
Expected: PASS — all tests pass.

- [x] **Step 5: Commit**

```bash
git add workers/src/transform.ts workers/tests/transform.test.ts
git commit -m "feat: add transform module for NDJSON to Loki streams conversion"
```

---

### Task 5: Loki Push Client with Retry

**Files:**
- Create: `workers/src/loki.ts`
- Create: `workers/tests/loki.test.ts`

**Interfaces:**
- Consumes: `LokiPushPayload` from `workers/src/types.ts` (Task 1), `Env` from `workers/src/types.ts` (Task 1)
- Produces: `pushToLoki(env: Pick<Env, "GRAFANA_CLOUD_LOKI_URL" | "GRAFANA_CLOUD_LOKI_USERNAME" | "GRAFANA_CLOUD_ACCESS_POLICY_TOKEN">, payload: LokiPushPayload, fetchFn?: typeof fetch): Promise<{ ok: boolean; status: number }>` — pushes Loki payload via HTTP, retries on 429 up to 3 times with exponential backoff. Returns `{ ok: true, status: 200 }` on success.

- [x] **Step 1: Write the failing test**

Create `workers/tests/loki.test.ts`:

```ts
import { describe, it, expect, vi } from "vitest";
import { pushToLoki } from "../src/loki";
import type { LokiPushPayload } from "../src/types";

const testPayload: LokiPushPayload = {
  streams: [
    {
      stream: { model: "llama-3.1-8b", status_code: "200", env: "prod", gateway: "main" },
      values: [["1720032000000000000", '{"request_id":"abc123"}']],
    },
  ],
};

const testEnv = {
  GRAFANA_CLOUD_LOKI_URL: "https://logs-prod-xxx.grafana.net",
  GRAFANA_CLOUD_LOKI_USERNAME: "123456",
  GRAFANA_CLOUD_ACCESS_POLICY_TOKEN: "glc_testtoken",
};

describe("pushToLoki", () => {
  it("returns ok on HTTP 200", async () => {
    const mockFetch = vi.fn().mockResolvedValue(
      new Response("", { status: 200 }),
    );
    const result = await pushToLoki(testEnv, testPayload, mockFetch);
    expect(result.ok).toBe(true);
    expect(result.status).toBe(200);
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it("returns ok on HTTP 204", async () => {
    const mockFetch = vi.fn().mockResolvedValue(
      new Response(null, { status: 204 }),
    );
    const result = await pushToLoki(testEnv, testPayload, mockFetch);
    expect(result.ok).toBe(true);
    expect(result.status).toBe(204);
  });

  it("returns not-ok on HTTP 400 without retry", async () => {
    const mockFetch = vi.fn().mockResolvedValue(
      new Response("Bad Request", { status: 400 }),
    );
    const result = await pushToLoki(testEnv, testPayload, mockFetch);
    expect(result.ok).toBe(false);
    expect(result.status).toBe(400);
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it("retries on HTTP 429 up to 3 times then returns not-ok", async () => {
    const mockFetch = vi.fn().mockResolvedValue(
      new Response("Too Many Requests", { status: 429 }),
    );
    const result = await pushToLoki(testEnv, testPayload, mockFetch);
    expect(result.ok).toBe(false);
    expect(result.status).toBe(429);
    expect(mockFetch).toHaveBeenCalledTimes(4); // 1 initial + 3 retries
  });

  it("succeeds on retry after initial 429", async () => {
    const mockFetch = vi.fn()
      .mockResolvedValueOnce(new Response("Too Many Requests", { status: 429 }))
      .mockResolvedValueOnce(new Response("", { status: 200 }));
    const result = await pushToLoki(testEnv, testPayload, mockFetch);
    expect(result.ok).toBe(true);
    expect(result.status).toBe(200);
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it("does not retry on HTTP 500", async () => {
    const mockFetch = vi.fn().mockResolvedValue(
      new Response("Internal Server Error", { status: 500 }),
    );
    const result = await pushToLoki(testEnv, testPayload, mockFetch);
    expect(result.ok).toBe(false);
    expect(result.status).toBe(500);
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it("sends Basic Auth header with username:token", async () => {
    const mockFetch = vi.fn().mockResolvedValue(
      new Response("", { status: 200 }),
    );
    await pushToLoki(testEnv, testPayload, mockFetch);
    const call = mockFetch.mock.calls[0]!;
    const url = call[0] as string;
    const init = call[1] as RequestInit;
    expect(url).toBe("https://logs-prod-xxx.grafana.net/loki/api/v1/push");
    const authHeader = (init.headers as Record<string, string>)["Authorization"];
    expect(authHeader).toBeDefined();
    const expectedBasic = btoa("123456:glc_testtoken");
    expect(authHeader).toBe(`Basic ${expectedBasic}`);
  });

  it("sends Content-Type application/json", async () => {
    const mockFetch = vi.fn().mockResolvedValue(
      new Response("", { status: 200 }),
    );
    await pushToLoki(testEnv, testPayload, mockFetch);
    const call = mockFetch.mock.calls[0]!;
    const init = call[1] as RequestInit;
    const headers = init.headers as Record<string, string>;
    expect(headers["Content-Type"]).toBe("application/json");
  });

  it("sends payload as JSON body", async () => {
    const mockFetch = vi.fn().mockResolvedValue(
      new Response("", { status: 200 }),
    );
    await pushToLoki(testEnv, testPayload, mockFetch);
    const call = mockFetch.mock.calls[0]!;
    const init = call[1] as RequestInit;
    expect(init.body).toBe(JSON.stringify(testPayload));
  });
});
```

- [x] **Step 2: Run test to verify it fails**

Run: `cd workers && npx vitest run tests/loki.test.ts`
Expected: FAIL with "Failed to resolve import" for `../src/loki`.

- [x] **Step 3: Write the implementation**

Create `workers/src/loki.ts`:

```ts
import type { LokiPushPayload, Env } from "./types";

type LokiEnv = Pick<Env, "GRAFANA_CLOUD_LOKI_URL" | "GRAFANA_CLOUD_LOKI_USERNAME" | "GRAFANA_CLOUD_ACCESS_POLICY_TOKEN">;

const MAX_RETRIES = 3;
const INITIAL_BACKOFF_MS = 500;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function pushToLoki(
  env: LokiEnv,
  payload: LokiPushPayload,
  fetchFn: typeof fetch = fetch,
): Promise<{ ok: boolean; status: number }> {
  const url = `${env.GRAFANA_CLOUD_LOKI_URL}/loki/api/v1/push`;
  const basicAuth = btoa(`${env.GRAFANA_CLOUD_LOKI_USERNAME}:${env.GRAFANA_CLOUD_ACCESS_POLICY_TOKEN}`);
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "Authorization": `Basic ${basicAuth}`,
  };
  const body = JSON.stringify(payload);

  let lastStatus = 0;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    if (attempt > 0) {
      const backoffMs = INITIAL_BACKOFF_MS * Math.pow(2, attempt - 1);
      await sleep(backoffMs);
    }

    const response = await fetchFn(url, {
      method: "POST",
      headers,
      body,
    });
    lastStatus = response.status;

    if (response.status >= 200 && response.status < 300) {
      return { ok: true, status: response.status };
    }

    if (response.status !== 429) {
      // Non-429 errors: do not retry, let caller decide
      return { ok: false, status: response.status };
    }
    // 429: retry with backoff
  }

  return { ok: false, status: lastStatus };
}
```

- [x] **Step 4: Run tests to verify they pass**

Run: `cd workers && npx vitest run tests/loki.test.ts`
Expected: PASS — all 9 tests pass.

- [x] **Step 5: Commit**

```bash
git add workers/src/loki.ts workers/tests/loki.test.ts
git commit -m "feat: add Loki push client with 429 retry and Basic Auth"
```

---

### Task 6: Worker Fetch Handler — Full Pipeline

**Files:**
- Create: `workers/src/index.ts`
- Create: `workers/tests/index.test.ts`

**Interfaces:**
- Consumes: `importRsaPrivateKey`, `decryptIfEncrypted` from `workers/src/crypto.ts` (Task 3); `transformNdjsonToLokiPayload` from `workers/src/transform.ts` (Task 4); `pushToLoki` from `workers/src/loki.ts` (Task 5); `Env`, `AIGatewayLog`, `LokiPushPayload` from `workers/src/types.ts` (Task 1)
- Produces: `default export` satisfying `ExportedHandler<Env>` with a `fetch` handler.

- [ ] **Step 1: Write the failing test**

Create `workers/tests/index.test.ts`:

```ts
import { describe, it, expect, vi } from "vitest";
import { exports } from "cloudflare:workers";
import type { Env } from "../src/types";

// Helper to generate a test RSA key pair and return PEM strings
async function getTestPrivateKeyPem(): Promise<string> {
  const keyPair = await crypto.subtle.generateKey(
    {
      name: "RSA-OAEP",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["encrypt", "decrypt"],
  );
  const der = await crypto.subtle.exportKey("pkcs8", keyPair.privateKey);
  const bytes = new Uint8Array(der);
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  const base64 = btoa(binary);
  const lines = base64.match(/.{1,64}/g) ?? [base64];
  return `-----BEGIN PRIVATE KEY-----\n${lines.join("\n")}\n-----END PRIVATE KEY-----`;
}

const mockEnv: Env = {
  GRAFANA_CLOUD_LOKI_URL: "https://logs-prod-xxx.grafana.net",
  GRAFANA_CLOUD_LOKI_USERNAME: "123456",
  GRAFANA_CLOUD_ACCESS_POLICY_TOKEN: "glc_testtoken",
  ORIGIN_SECRET: "test-origin-secret",
  RSA_PRIVATE_KEY_PEM: "", // set per-test
  GATEWAY_NAME: "main",
  ENV_LABEL: "prod",
};

const sampleNdjson = [
  JSON.stringify({
    RequestID: "req-001",
    RequestTime: 1720032000,
    CacheStatus: "miss",
    StatusCode: 200,
    Model: "@cf/meta/llama-3.1-8b-instruct",
    PromptTokens: 150,
    CompletionTokens: 80,
    TotalTokens: 230,
    RequestDuration: 1250,
    Path: "/v1/chat/completions",
    Method: "POST",
  }),
].join("\n");

async function gzipText(text: string): Promise<ArrayBuffer> {
  // Use CompressionStream to gzip the text
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(text));
      controller.close();
    },
  });
  const compressed = stream.pipeThrough(new CompressionStream("gzip"));
  // Consume the compressed stream into an ArrayBuffer
  return new Response(compressed).arrayBuffer();
}

describe("Worker fetch handler", () => {
  it("returns 401 when X-Origin-Secret header is missing", async ({ env }) => {
    const privateKeyPem = await getTestPrivateKeyPem();
    (mockEnv as any).RSA_PRIVATE_KEY_PEM = privateKeyPem;
    // Note: in Vitest Workers pool, env is the global env from wrangler config
    // We need to set secrets via env override — but since we can't easily do that,
    // we test the handler directly with explicit env injection via exports.default.fetch
    const request = new Request("https://worker.example.com/", {
      method: "POST",
      body: await gzipText(sampleNdjson),
      headers: { "Content-Encoding": "gzip" },
    });
    // Call the exported handler with our mock env
    const response = await exports.default.fetch(request, mockEnv as any, {
      waitUntil: vi.fn(),
    } as any);
    expect(response.status).toBe(401);
  });

  it("returns 401 when X-Origin-Secret header is wrong", async () => {
    const privateKeyPem = await getTestPrivateKeyPem();
    (mockEnv as any).RSA_PRIVATE_KEY_PEM = privateKeyPem;
    const request = new Request("https://worker.example.com/", {
      method: "POST",
      body: await gzipText(sampleNdjson),
      headers: { "Content-Encoding": "gzip", "X-Origin-Secret": "wrong-secret" },
    });
    const response = await exports.default.fetch(request, mockEnv as any, {
      waitUntil: vi.fn(),
    } as any);
    expect(response.status).toBe(401);
  });

  it("returns 405 for GET requests", async () => {
    const request = new Request("https://worker.example.com/", {
      method: "GET",
    });
    const response = await exports.default.fetch(request, mockEnv as any, {
      waitUntil: vi.fn(),
    } as any);
    expect(response.status).toBe(405);
  });

  it("returns 200 on valid POST with correct origin secret and unencrypted logs", async () => {
    const privateKeyPem = await getTestPrivateKeyPem();
    (mockEnv as any).RSA_PRIVATE_KEY_PEM = privateKeyPem;

    // Mock the Loki push to return 200
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input: any) => {
      const url = typeof input === "string" ? input : input.url;
      if (url.includes("/loki/api/v1/push")) {
        return new Response("", { status: 200 });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });

    const request = new Request("https://worker.example.com/", {
      method: "POST",
      body: await gzipText(sampleNdjson),
      headers: {
        "Content-Encoding": "gzip",
        "X-Origin-Secret": "test-origin-secret",
      },
    });
    const response = await exports.default.fetch(request, mockEnv as any, {
      waitUntil: vi.fn(),
    } as any);
    expect(response.status).toBe(200);

    vi.restoreAllMocks();
  });

  it("returns 503 when Loki push fails with 500", async () => {
    const privateKeyPem = await getTestPrivateKeyPem();
    (mockEnv as any).RSA_PRIVATE_KEY_PEM = privateKeyPem;

    vi.spyOn(globalThis, "fetch").mockImplementation(async (input: any) => {
      const url = typeof input === "string" ? input : input.url;
      if (url.includes("/loki/api/v1/push")) {
        return new Response("Internal Server Error", { status: 500 });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });

    const request = new Request("https://worker.example.com/", {
      method: "POST",
      body: await gzipText(sampleNdjson),
      headers: {
        "Content-Encoding": "gzip",
        "X-Origin-Secret": "test-origin-secret",
      },
    });
    const response = await exports.default.fetch(request, mockEnv as any, {
      waitUntil: vi.fn(),
    } as any);
    expect(response.status).toBe(503);

    vi.restoreAllMocks();
  });

  it("returns 400 for a malformed gzip body (stops Logpush retry)", async () => {
    const privateKeyPem = await getTestPrivateKeyPem();
    (mockEnv as any).RSA_PRIVATE_KEY_PEM = privateKeyPem;

    // Valid gzip magic bytes (0x1f 0x8b) followed by corrupt/truncated data
    const request = new Request("https://worker.example.com/", {
      method: "POST",
      body: new Uint8Array([0x1f, 0x8b, 0x08, 0x00, 0xde, 0xad, 0xbe, 0xef]),
      headers: {
        "Content-Encoding": "gzip",
        "X-Origin-Secret": "test-origin-secret",
      },
    });
    const response = await exports.default.fetch(request, mockEnv as any, {
      waitUntil: vi.fn(),
    } as any);
    expect(response.status).toBe(400);
  });

  it("returns 400 when the gzip body is missing", async () => {
    const privateKeyPem = await getTestPrivateKeyPem();
    (mockEnv as any).RSA_PRIVATE_KEY_PEM = privateKeyPem;

    const request = new Request("https://worker.example.com/", {
      method: "POST",
      headers: {
        "Content-Encoding": "gzip",
        "X-Origin-Secret": "test-origin-secret",
      },
    });
    const response = await exports.default.fetch(request, mockEnv as any, {
      waitUntil: vi.fn(),
    } as any);
    expect(response.status).toBe(400);
  });

  it("returns 400 when all log lines fail to parse (stops Logpush retry)", async () => {
    const privateKeyPem = await getTestPrivateKeyPem();
    (mockEnv as any).RSA_PRIVATE_KEY_PEM = privateKeyPem;

    // Valid gzip, but every decompressed line is unparseable JSON, so no
    // record survives parse/decrypt and the batch is unprocessable.
    const request = new Request("https://worker.example.com/", {
      method: "POST",
      body: await gzipText("not-json\n{invalid\n"),
      headers: {
        "Content-Encoding": "gzip",
        "X-Origin-Secret": "test-origin-secret",
      },
    });
    const response = await exports.default.fetch(request, mockEnv as any, {
      waitUntil: vi.fn(),
    } as any);
    expect(response.status).toBe(400);
  });
});
```

- [x] **Step 2: Run test to verify it fails**

Run: `cd workers && npx vitest run tests/index.test.ts`
Expected: FAIL with "Failed to resolve import" for `../src` or `exports.default` undefined.

- [ ] **Step 3: Write the implementation**

Create `workers/src/index.ts`:

```ts
import type { Env, AIGatewayLog, LokiPushPayload } from "./types";
import { importRsaPrivateKey, decryptIfEncrypted } from "./crypto";
import { transformNdjsonToLokiPayload } from "./transform";
import { pushToLoki } from "./loki";

// Cache imported RSA private keys across warm Worker invocations
const privateKeyCache = new Map<string, CryptoKey>();

function timingSafeSecretEqual(a: string, b: string): boolean {
  const enc = new TextEncoder();
  const aBytes = enc.encode(a);
  const bBytes = enc.encode(b);
  if (aBytes.length !== bBytes.length) {
    return false;
  }
  return crypto.subtle.timingSafeEqual(aBytes, bBytes);
}

async function getCachedPrivateKey(pem: string): Promise<CryptoKey> {
  let key = privateKeyCache.get(pem);
  if (!key) {
    key = await importRsaPrivateKey(pem);
    privateKeyCache.set(pem, key);
  }
  return key;
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    if (request.method !== "POST") {
      return new Response("Method Not Allowed", { status: 405 });
    }

    // 1. Validate origin secret using constant-time comparison
    const originSecret = request.headers.get("X-Origin-Secret");
    if (!originSecret || !timingSafeSecretEqual(originSecret, env.ORIGIN_SECRET)) {
      return new Response("Unauthorized", { status: 401 });
    }

    // 2. Decompress gzip body if Content-Encoding: gzip.
    //    Malformed gzip makes DecompressionStream throw a TypeError; if left
    //    uncaught the handler returns HTTP 500 and Logpush retries the same
    //    corrupt batch (~5x over 5 min). Return 400 to stop the retry loop.
    let bodyText: string;
    const contentEncoding = request.headers.get("Content-Encoding");
    if (contentEncoding === "gzip") {
      if (!request.body) {
        return new Response("Missing gzip body", { status: 400 });
      }
      try {
        const ds = new DecompressionStream("gzip");
        const decompressed = request.body.pipeThrough(ds);
        bodyText = await new Response(decompressed).text();
      } catch (err) {
        console.error(
          `Failed to decompress gzip body: ${err instanceof Error ? err.message : String(err)}`,
        );
        return new Response("Invalid gzip body", { status: 400 });
      }
    } else {
      bodyText = await request.text();
    }

    // 3. Import RSA private key (cached across warm Worker invocations)
    const privateKey = await getCachedPrivateKey(env.RSA_PRIVATE_KEY_PEM);

    // 4. Parse NDJSON, decrypt encrypted fields per line
    const lines = bodyText.split("\n").filter((line) => line.trim().length > 0);
    const decryptedLogs: AIGatewayLog[] = [];

    for (const line of lines) {
      try {
        const parsed = JSON.parse(line) as Record<string, unknown>;
        // Decrypt encrypted fields if present (Metadata, RequestBody, ResponseBody)
        const decrypted: Record<string, unknown> = {};
        for (const [key, value] of Object.entries(parsed)) {
          decrypted[key] = await decryptIfEncrypted(privateKey, value);
        }
        decryptedLogs.push(decrypted as unknown as AIGatewayLog);
      } catch (err) {
        console.error(`Failed to parse/decrypt log line: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    // No log lines at all — nothing to process; acknowledge success so
    // Logpush does not retry an empty batch.
    if (lines.length === 0) {
      return new Response("No log lines", { status: 200 });
    }

    // Every line failed to parse/decrypt — the batch is unprocessable. Return
    // 4xx (not 5xx) so Logpush does not retry non-recoverable data, matching
    // the malformed-gzip handling above.
    if (decryptedLogs.length === 0) {
      return new Response("No valid log lines", { status: 400 });
    }

    // 5. Re-serialize to NDJSON and transform to Loki push payload
    //    (transformNdjsonToLokiPayload expects NDJSON string input)
    const decryptedNdjson = decryptedLogs.map((log) => JSON.stringify(log)).join("\n");
    const lokiPayload: LokiPushPayload = transformNdjsonToLokiPayload(
      decryptedNdjson,
      env.GATEWAY_NAME,
      env.ENV_LABEL,
    );

    if (lokiPayload.streams.length === 0) {
      return new Response("No transformable logs", { status: 200 });
    }

    // 6. Push to Loki
    const result = await pushToLoki(env, lokiPayload);

    if (result.ok) {
      return new Response("OK", { status: 200 });
    }

    // Return 503 to trigger Logpush retry for 5xx Loki responses
    // Return 400 for 4xx (non-429) Loki responses to avoid retry
    if (result.status >= 500 || result.status === 429) {
      return new Response(`Loki push failed: ${result.status}`, { status: 503 });
    }
    return new Response(`Loki push rejected: ${result.status}`, { status: 400 });
  },
} satisfies ExportedHandler<Env>;
```

- [x] **Step 4: Run tests to verify they pass**

Run: `cd workers && npx vitest run tests/index.test.ts`
Expected: PASS — all 8 tests pass.

- [x] **Step 5: Run all tests together**

Run: `cd workers && npx vitest run`
Expected: PASS — all tests across crypto, transform, loki, and index pass.

- [x] **Step 6: Commit**

```bash
git add workers/src/index.ts workers/tests/index.test.ts
git commit -m "feat: add Worker fetch handler orchestrating decrypt-transform-push pipeline"
```

---

### Task 7: Terraform Infrastructure

**Files:**
- Create: `terraform/versions.tf`
- Create: `terraform/variables.tf`
- Create: `terraform/main.tf`
- Create: `terraform/outputs.tf`
- Create: `terraform/terraform.tfvars.example`

**Interfaces:**
- Consumes: Worker script at `workers/src/index.ts` (Task 6), spec requirements for Logpush job, and IaC management.
- Produces: A Terraform configuration that provisions only the Logpush job targeting the Wrangler-deployed Worker URL, plus outputs for monitoring. Worker script and secrets are managed by Wrangler.

- [x] **Step 1: Create `terraform/versions.tf`**

```hcl
terraform {
  required_version = ">= 1.5.0"

  required_providers {
    cloudflare = {
      source  = "cloudflare/cloudflare"
      version = "~> 5.0"
    }
  }

  # Remote backend — configure before production use (spec §3.3, §6.2)
  # backend "s3" {
  #   bucket         = "graft-ai-tfstate"
  #   key            = "terraform.tfstate"
  #   region         = "us-east-1"
  #   encrypt        = true
  #   dynamodb_table = "graft-ai-tf-locks"
  # }
}
```

- [ ] **Step 2: Create `terraform/variables.tf`**

```hcl
variable "cloudflare_account_id" {
  description = "Cloudflare Account ID"
  type        = string
  sensitive   = true
}

variable "cloudflare_api_token" {
  description = "Cloudflare API Token with Logpush and Workers permissions"
  type        = string
  sensitive   = true
}

variable "grafana_cloud_loki_url" {
  description = "Grafana Cloud Loki push endpoint URL (e.g. https://logs-prod-xxx.grafana.net)"
  type        = string
  sensitive   = true
}

variable "grafana_cloud_loki_username" {
  description = "Grafana Cloud Loki tenant ID (User value from portal)"
  type        = string
  sensitive   = true
}

variable "grafana_cloud_access_policy_token" {
  description = "Grafana Cloud Access Policy Token with logs:write scope"
  type        = string
  sensitive   = true
}

variable "origin_secret" {
  description = "Shared secret for X-Origin-Secret header validation between Logpush and Worker"
  type        = string
  sensitive   = true
}

variable "rsa_private_key_pem" {
  description = "RSA private key (PKCS#8 PEM) for decrypting AI Gateway logpush logs"
  type        = string
  sensitive   = true
}

variable "gateway_name" {
  description = "AI Gateway name (used as Loki 'gateway' label and Worker GATEWAY_NAME var)"
  type        = string
  default     = "main"
}

variable "env_label" {
  description = "Environment label for Loki 'env' label (prod / stg)"
  type        = string
  default     = "prod"
}

variable "logpush_dataset" {
  description = "Cloudflare Logpush dataset name for AI Gateway logs. Verify via Cloudflare API before applying (spec §9)."
  type        = string
  default     = "gateway_http"
}

variable "worker_script_name" {
  description = "Cloudflare Workers script name"
  type        = string
  default     = "graft-ai-aig-logpush"
}

variable "logpush_job_name" {
  description = "Human-readable name for the Logpush job"
  type        = string
  default     = "graft-ai-aig-logpush"
}

variable "workers_subdomain" {
  description = "Cloudflare Workers account subdomain (set in Workers & Pages › Your subdomain)"
  type        = string
}
```

- [ ] **Step 3: Create `terraform/main.tf`**

```hcl
provider "cloudflare" {
  api_token = var.cloudflare_api_token
}

# Worker script is deployed by Wrangler; Terraform manages only the Logpush job.
# Use `make deploy` (wrangler deploy + terraform apply) after setting secrets via
# `npx wrangler secret put` and `TF_VAR_*` environment variables.

resource "cloudflare_logpush_job" "aig_logs" {
  account_id      = var.cloudflare_account_id
  dataset         = var.logpush_dataset
  name            = var.logpush_job_name
  enabled         = true
  destination_conf = "https://${var.worker_script_name}.${var.workers_subdomain}.workers.dev?header_X-Origin-Secret=${urlencode(var.origin_secret)}"
  max_upload_bytes = 5000000
  max_upload_records = 1000

  output_options = {
    field_names = [
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
    ]
    timestamp_format = "unixnano"
    output_type      = "ndjson"
  }
}
```

And add this variable to `variables.tf`:

```hcl
variable "origin_secret" {
  description = "Shared secret that Cloudflare Logpush sends as the X-Origin-Secret header"
  type        = string
  sensitive   = true
}

- [x] **Step 4: Create `terraform/outputs.tf`**

```hcl
output "worker_url" {
  description = "URL of the deployed Worker"
  value       = "https://${var.worker_script_name}.${var.workers_subdomain}.workers.dev"
}

output "logpush_job_id" {
  description = "ID of the created Logpush job"
  value       = cloudflare_logpush_job.aig_logs.id
}

output "logpush_job_name" {
  description = "Name of the created Logpush job"
  value       = cloudflare_logpush_job.aig_logs.name
}

output "worker_script_name" {
  description = "Name of the deployed Worker script"
  value       = var.worker_script_name
}
```

- [ ] **Step 5: Create `terraform/terraform.tfvars.example`**

```hcl
# Non-secret variables — copy to terraform.tfvars and fill in
# Secret variables should be set via TF_VAR_* environment variables, NOT in this file.

cloudflare_account_id = "your-cloudflare-account-id-hex"
gateway_name          = "main"
env_label             = "prod"
logpush_dataset        = "gateway_http"
worker_script_name     = "graft-ai-aig-logpush"
logpush_job_name       = "graft-ai-aig-logpush"
workers_subdomain      = "your-account-subdomain"
```

- [x] **Step 6: Verify Terraform formatting and validation**

Run: `cd terraform && terraform fmt -check`
Expected: PASS (no formatting issues).

Run: `cd terraform && terraform init && terraform validate`
Expected: PASS — "The configuration is valid."

Note: `terraform validate` requires all variables to have either a default or be set. Secret variables without defaults will trigger a warning during `plan` but not during `validate`. If `validate` fails due to missing variables, temporarily set `TF_VAR_cloudflare_api_token=dummy TF_VAR_cloudflare_account_id=dummy TF_VAR_workers_subdomain=dummy TF_VAR_origin_secret=dummy TF_VAR_origin_secret_urlencoded=dummy` before running validate.

```bash
git add terraform/
git commit -m "feat: add Terraform configuration for Logpush job targeting Wrangler-deployed Worker"
```
---

### Task 8: Makefile and CI Checks

**Files:**
- Create: `Makefile`
- Modify: `workers/package.json` (add lint script if missing)

**Interfaces:**
- Consumes: All previous tasks
- Produces: Convenience Makefile targets for formatting, validation, testing, and deployment

- [x] **Step 1: Create `Makefile`**

```makefile
.PHONY: install fmt validate test typecheck plan apply dev deploy clean

install:
	cd workers && npm install
	cd workers && npx wrangler types

fmt:
	cd workers && npx tsc --noEmit
	terraform fmt -recursive

validate:
	terraform -chdir=terraform validate

test:
	cd workers && npx vitest run

typecheck:
	cd workers && npx tsc --noEmit

plan:
	terraform -chdir=terraform plan

apply:
	terraform -chdir=terraform apply

dev:
	cd workers && npx wrangler dev

deploy:
	cd workers && npx wrangler deploy
	terraform -chdir=terraform apply

clean:
	rm -rf terraform/.terraform terraform/terraform.tfstate*
```

- [x] **Step 2: Verify Makefile targets work**

Run: `make typecheck`
Expected: PASS — no TypeScript errors.

Run: `make test`
Expected: PASS — all Vitest tests pass.

Run: `make fmt`
Expected: PASS — no formatting changes needed.

- [x] **Step 3: Commit**

```bash
git add Makefile
git commit -m "build: add Makefile with fmt, validate, test, plan, apply, deploy targets"
```

---

### Task 9: Pre-Deployment Verification Checklist

**Files:**
- No files created. This task is a manual verification checklist to complete before running `terraform apply`.

**Interfaces:**
- Consumes: All previous tasks
- Produces: Verified prerequisites ready for production deployment

- [ ] **Step 1: Generate RSA key pair for AI Gateway Logpush encryption**

Run this Node.js script to generate a 4096-bit RSA key pair:

```bash
node -e "
const crypto = require('crypto');
const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', {
  modulusLength: 4096,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});
console.log('=== PUBLIC KEY (upload to AI Gateway settings) ===');
console.log(publicKey);
console.log('=== PRIVATE KEY (set as TF_VAR_rsa_private_key_pem) ===');
console.log(privateKey);
"
```

Save the private key securely. Upload the public key to your AI Gateway settings in the Cloudflare dashboard (Workers Logpush section).

- [ ] **Step 2: Issue Grafana Cloud Loki Access Policy Token**

1. Log in to Grafana Cloud Portal.
2. Navigate to Access Policies.
3. Create a new Access Policy with:
   - Scope: `logs:write`
   - Name: `graft-ai-aig-logpush`
4. Copy the generated token (starts with `glc_`).
5. Note your Loki URL (e.g., `https://logs-prod-us-central1.grafana.net`) and Loki User ID (numeric tenant ID).

Set these as environment variables:

```bash
export TF_VAR_grafana_cloud_loki_url="https://logs-prod-xxx.grafana.net"
export TF_VAR_grafana_cloud_loki_username="123456"
export TF_VAR_grafana_cloud_access_policy_token="glc_xxxxxxxxxxxx"
```

- [ ] **Step 3: Set remaining secret environment variables**

```bash
export TF_VAR_cloudflare_api_token="your-cloudflare-api-token"
export TF_VAR_cloudflare_account_id="your-cloudflare-account-id"
export TF_VAR_workers_subdomain="your-account-subdomain"
export TF_VAR_origin_secret="$(openssl rand -hex 32)"
export TF_VAR_origin_secret_urlencoded="$(python3 -c \"import urllib.parse; import os; print(urllib.parse.quote(os.environ['TF_VAR_origin_secret']))\")"
export TF_VAR_rsa_private_key_pem="$(cat private_key.pem)"
```

- [ ] **Step 4: Verify Logpush dataset and field names**

Query the Cloudflare API to confirm the dataset and available fields for AI Gateway logs:

```bash
curl -s "https://api.cloudflare.com/client/v4/accounts/${TF_VAR_cloudflare_account_id}/logpush/datasets/gateway_http/fields" \
  -H "Authorization: Bearer ${TF_VAR_cloudflare_api_token}" | python3 -m json.tool
```

Verify that the fields listed in `terraform/main.tf` `output_options.field_names` exist in the response. If the dataset name is different (e.g., a dedicated `ai_gateway` dataset), update `var.logpush_dataset` in your `terraform.tfvars`.

- [ ] **Step 5: Run `terraform plan`**

Run: `cd terraform && terraform plan`
Expected: Plan shows creation of 1 resource: `cloudflare_logpush_job.aig_logs`. No unexpected changes.

- [ ] **Step 6: Commit any field name corrections**

If Step 4 revealed different field names, update `terraform/main.tf` and commit:

```bash
git add terraform/main.tf
git commit -m "fix: correct Logpush field names based on API verification"
```

---

### Task 10: Post-Deployment Smoke Test

**Files:**
- No files created. This task verifies the deployed pipeline end-to-end.

**Interfaces:**
- Consumes: Deployed Worker (Task 7), deployed Logpush job (Task 7), Grafana Cloud Loki (Task 9 prerequisites)
- Produces: Verified end-to-end log collection pipeline

- [ ] **Step 1: Deploy the Worker and infrastructure**

Run: `make deploy`
Expected: Worker deployed via Wrangler, Terraform apply succeeds for the Logpush job, and the Logpush job is created and enabled.

- [ ] **Step 2: Verify Worker responds to POST with 401 without secret**

Run:

```bash
curl -s -o /dev/null -w "%{http_code}" -X POST "https://graft-ai-aig-logpush.${TF_VAR_workers_subdomain}.workers.dev" -d "test"
```
Expected: `401` (Unauthorized — missing X-Origin-Secret header).

- [ ] **Step 3: Verify Worker responds to POST with 200 with correct secret and gzipped NDJSON**

Run:

```bash
echo '{"RequestID":"smoke-001","RequestTime":1720032000,"CacheStatus":"miss","StatusCode":200,"Model":"@cf/meta/llama-3.1-8b-instruct","PromptTokens":10,"CompletionTokens":5,"TotalTokens":15,"RequestDuration":100,"Path":"/v1/chat/completions","Method":"POST"}' | gzip | curl -s -o /dev/null -w "%{http_code}" -X POST "https://graft-ai-aig-logpush.${TF_VAR_workers_subdomain}.workers.dev" -H "Content-Encoding: gzip" -H "X-Origin-Secret: ${TF_VAR_origin_secret}" --data-binary @-
```
Expected: `200` (OK — Worker processed the log and pushed to Loki).

- [ ] **Step 4: Verify logs appear in Grafana Cloud Loki**

Run a Loki query via Grafana Cloud dashboard or API:

```bash
curl -s -G "https://logs-prod-xxx.grafana.net/loki/api/v1/query_range" \
  -u "${TF_VAR_grafana_cloud_loki_username}:${TF_VAR_grafana_cloud_access_policy_token}" \
  --data-urlencode 'query={gateway="main"}' \
  --data-urlencode 'start='$(date -d '5 minutes ago' +%s)000000000 \
  --data-urlencode 'end='$(date +%s)000000000 \
  --data-urlencode 'limit=10' | python3 -m json.tool
```

Expected: Response contains `status: "success"` and `data.result` has at least one stream with labels matching `model="llama-3.1-8b-instruct"`, `status_code="200"`, `env="prod"`, `gateway="main"`.

- [ ] **Step 5: Send a test AI Gateway request to generate a real log**

Run a test request through your AI Gateway:

```bash
export TF_VAR_workers_subdomain="your-account-subdomain"
curl -X POST "https://gateway.ai.cloudflare.com/v1/${TF_VAR_cloudflare_account_id}/main/openai/chat/completions" \
  -H "Authorization: Bearer ${OPENAI_API_KEY}" \
  -H "Content-Type: application/json" \
  -d '{"model":"gpt-4o-mini","messages":[{"role":"user","content":"Hello"}]}'
```

Wait 1-5 minutes for Logpush to deliver the log.

- [ ] **Step 6: Verify the real AI Gateway log appears in Loki**

Run the same Loki query from Step 4. Expected: At least one log entry with `model` label matching the model used (e.g., `gpt-4o-mini` or the AI Gateway's internal model name).

- [ ] **Step 7: Commit final state**

No code changes. If any issues were found and fixed during smoke testing, commit the fixes:

```bash
git add -A
git commit -m "fix: address smoke test findings"
```
