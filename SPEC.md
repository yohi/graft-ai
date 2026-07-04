<!-- markdownlint-disable MD013 -->

# graft-ai Specification

日本語版: [SPEC.ja.md](./SPEC.ja.md)

## 1. Purpose

Aggregate telemetry from Cloudflare AI Gateway, OpenAI, and Ollama Cloud into a
unified Grafana Cloud dashboard, while remaining within the Grafana Cloud Free
Tier limits (14-day retention, 10k active series, 50GB logs).

## 2. Subsystems

### Subsystem 1 — Cloudflare AI Gateway → Grafana Cloud Loki

#### 2.1 Goal

Receive encrypted AI Gateway access logs from Cloudflare Logpush in near real
time, transform them into Loki JSON streams, and push them to Grafana Cloud
Loki.

#### 2.2 Architecture

```text
[Client/App]
    ↓
[Cloudflare AI Gateway] ── logs ──→ [Cloudflare Logpush]
                                       ↓ encrypted, gzip-compressed NDJSON
[Cloudflare Workers (receive/decrypt/decompress)]
                                       ↓ NDJSON
[Cloudflare Workers (transform)]
                                       ↓ JSON streams
[Grafana Cloud Loki]
                                       ↓
[Grafana Cloud Dashboard]
```

#### 2.3 Components

| Component        | Managed By                             | Responsibility                                                             |
| ---------------- | -------------------------------------- | -------------------------------------------------------------------------- |
| AI Gateway       | Existing service                       | Proxies AI requests and generates access logs.                             |
| Logpush Job      | Terraform (`cloudflare_logpush_job`)   | Fetches gateway logs and POSTs NDJSON to the Worker.                       |
| Transform Worker | Wrangler (`workers/src/index.ts`)      | Validates ingress, decompresses, decrypts, transforms, and pushes to Loki. |
| Credentials      | Wrangler secrets + `TF_VAR_*` env vars | Holds Grafana token, origin secret, and RSA private key.                   |
| Loki             | Grafana Cloud managed                  | Stores transformed logs for 14 days.                                       |

#### 2.4 Data Transformation Rules

1. **Timestamp and Encryption**
   - Incoming payload is gzip-compressed NDJSON. Each encrypted field uses
     hybrid encryption: an AES-GCM key is wrapped with RSA-OAEP-SHA256, and the
     payload is encrypted with AES-GCM. The Worker imports the PKCS#8 RSA
     private key (`env.RSA_PRIVATE_KEY_PEM`) to unwrap and decrypt.
   - `RequestTime` is seconds when ≤10 digits, milliseconds when 11–13 digits.
   - Converted to nanoseconds for Loki.
   - Values ≥14 digits are treated as precision-lost and the log line is
     skipped.

2. **Labels**
   - Strictly four: `model`, `status_code`, `env`, `gateway`.
   - `model` is normalized by stripping the `@cf/<scope>/` prefix.

3. **Log Line Fields**
   - Always included: `request_id`, `cache_status`, `prompt_tokens`,
     `completion_tokens`, `total_tokens`, `duration_ms`, `path`, `method`.
   - Optionally included only when explicitly enabled via
     `env.INCLUDE_REQUEST_BODY`, `env.INCLUDE_RESPONSE_BODY`,
     `env.INCLUDE_METADATA`: decrypted `request_body`, `response_body`,
     `metadata`. These are opt-in because they may contain prompts, response
     bodies, or other sensitive data.
   - Headers, user IPs, auth tokens, and raw prompts/response bodies are
     excluded by default.

#### 2.5 Reliability and Error Handling

| Failure Point                   | Behavior                                                                   |
| ------------------------------- | -------------------------------------------------------------------------- |
| Missing/wrong `X-Origin-Secret` | Return `401`; no Logpush retry.                                            |
| Malformed gzip body             | Return `400`; no Logpush retry.                                            |
| Invalid RSA private key         | Return `400`; no Logpush retry.                                            |
| Unparseable NDJSON line         | Skip line and continue; other lines are processed.                         |
| Loki 429                        | Retry up to 3 times with exponential backoff; final failure returns `503`. |
| Loki 5xx or network failure     | Return `503`; Logpush retries the batch.                                   |
| Loki 4xx (non-429)              | Return `400`; no Logpush retry.                                            |

#### 2.6 Security

- HTTPS only for Logpush → Worker and Worker → Loki.
- Loki push uses HTTP Basic Auth: username = Grafana Cloud Loki tenant ID,
  password = Access Policy Token with `logs:write` scope.
- Secrets are never committed or stored in `*.tfvars`. Use environment variables
  or Wrangler secrets.
- Terraform state should use an encrypted remote backend.

#### 2.7 Testing and Validation

- Unit tests for crypto, transform, and Loki modules
  (`@cloudflare/vitest-pool-workers`).
- Integration test for the full Worker fetch handler.
- CI checks: `terraform fmt`, `terraform validate`, TypeScript type check,
  Vitest run.
- Test fixtures are in `tests/fixtures/sample_aigateway_log.json` covering
  200/400/500 status codes, cache hit/miss, and two model names.

## 3. Global Constraints

- Workers implementation language: TypeScript.
- Terraform provider: `cloudflare/cloudflare` v5.x.
- Worker deployment via Wrangler; Terraform manages only the Logpush job.
- Grafana Cloud Free Tier limits apply.

## 4. Operational Notes

- Verify the Logpush dataset name and field names via the Cloudflare API before
  applying Terraform.
- Upload the RSA public key to the AI Gateway Logpush settings; the private key
  is used by the Worker.
- Configure a remote encrypted Terraform backend before production use.
- **Monitoring checklist:** Workers Analytics for exceptions and subrequest
  errors; Logpush `last_delivery` status via Terraform output or the Cloudflare
  dashboard; Grafana Cloud **Logs Usage** dashboard; weekly comparison of actual
  log volume against the design estimate (~0.5–1.5 KB per transformed request).
- **Quota estimate:** Transformed logs are ~0.5–1.5 KB per request vs. ~3–8 KB
  raw. At 100k requests/day, expect roughly 1.5–4.5 GB/month, which fits within
  the Grafana Cloud Free Tier 50 GB/month logs allowance.
