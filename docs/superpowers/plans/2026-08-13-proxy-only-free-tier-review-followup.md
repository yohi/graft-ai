# Proxy-Only Free Tier Review Follow-up Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the regressions introduced by the current Free Tier proxy-only diff: restore the Logpush field contract in Terraform, make setup preserve local dev credentials and support standard API-token auth, and bring Japanese/English docs into agreement.

**Architecture:** Keep the existing proxy-only runtime behavior. Only change deployment/docs artifacts: Terraform `field_names`, setup script user experience, and README/SPEC copy. No Worker source changes unless required for tests.

**Tech Stack:** Terraform, Bash, TypeScript/Vitest, Markdown.

## Global Constraints

- Do not commit credentials or absolute paths.
- `make test`, `make typecheck`, `make fmt`, and `git diff --check` must pass before finishing.
- Loki labels remain limited to `model`, `status_code`, `env`, `gateway`.
- Terraform `cloudflare/cloudflare` provider remains `~> 5.0`.

---

### Task 1: Restore Logpush field contract in Terraform

**Files:**
- Modify: `terraform/main.tf:23-35`

**Interfaces:**
- Consumes: Cloudflare `ai_gateway_events` dataset field names expected by `workers/src/transform.ts` and `workers/src/types.ts`.
- Produces: A `field_names` list that includes all fields required to build a valid `AIGatewayLog` and transform it to Loki streams.

- [ ] **Step 1: Update `field_names` to the original contract**

  Replace the shortened list with the full set required by `transform.ts`:

  ```hcl
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
  ```

- [ ] **Step 2: Validate Terraform**

  Run:

  ```bash
  make validate
  ```

  Expected: `Success! The configuration is valid.`

---

### Task 2: Preserve `.dev.vars` and support CLOUDFLARE_API_TOKEN in setup-free-tier.sh

**Files:**
- Modify: `scripts/setup-free-tier.sh`

**Interfaces:**
- Consumes: `workers/wrangler.proxy.jsonc`, optional env vars `PROXY_SECRET` and `CLOUDFLARE_API_TOKEN`.
- Produces: A safe `.dev.vars` update that keeps existing non-proxy values, and wrangler commands that honor `CLOUDFLARE_API_TOKEN` when present.

- [ ] **Step 1: Add AI_GATEWAY_ID placeholder check**

  After the existing `CF_ACCOUNT_ID` check, reject the placeholder value from the parsed configuration:

  ```bash
  ai_gateway_id="$(jq -r '.vars.AI_GATEWAY_ID // empty' "$proxy_config")"
  [[ -n "$ai_gateway_id" && "$ai_gateway_id" != "main" ]] ||
    die "Set AI_GATEWAY_ID in ${proxy_config} before deploying."
  ```

  This matches the existing guard style and prevents deploying with the default placeholder.

- [ ] **Step 2: Stop overwriting `.dev.vars`**

  Replace the unconditional write:

  ```bash
  umask 077
  tmp_vars="$(mktemp "${dev_vars}.tmp.XXXXXX")"
  chmod 600 "$tmp_vars"
  trap 'rm -f "$tmp_vars"' EXIT
  proxy_secret_written=false
  if [[ -f "$dev_vars" ]]; then
    while IFS= read -r line || [[ -n "$line" ]]; do
      if [[ "$line" == PROXY_SECRET=* ]]; then
        printf 'PROXY_SECRET=%s\n' "$PROXY_SECRET" >> "$tmp_vars"
        proxy_secret_written=true
      else
        printf '%s\n' "$line" >> "$tmp_vars"
      fi
    done < "$dev_vars"
  fi
  if [[ "$proxy_secret_written" == false ]]; then
    printf 'PROXY_SECRET=%s\n' "$PROXY_SECRET" >> "$tmp_vars"
  fi
  mv "$tmp_vars" "$dev_vars"
  trap - EXIT
  ```

- [ ] **Step 3: Make wrangler commands work with CLOUDFLARE_API_TOKEN**

  Remove the `env -u CLOUDFLARE_API_TOKEN` wrapper from both wrangler calls:

  ```bash
  printf '%s' "$PROXY_SECRET" | npx wrangler secret put PROXY_SECRET --config wrangler.proxy.jsonc
  ```

  and

  ```bash
  npx wrangler deploy --config wrangler.proxy.jsonc
  ```

- [ ] **Step 4: Validate shell syntax and run formatter**

  Run:

  ```bash
  bash -n scripts/setup-free-tier.sh
  shellcheck scripts/setup-free-tier.sh
  terraform fmt -check -recursive
  ```

  Expected: no errors.

---

### Task 3: Align README.md Free Tier / Logpush instructions with new behavior

**Files:**
- Modify: `README.md`

**Interfaces:**
- Consumes: Current README text, new `scripts/setup-free-tier.sh` behavior, Logpush-only deployment path.
- Produces: Consistent instructions that do not tell users to skip required Logpush secrets.

- [ ] **Step 1: Fix the Free Tier feature matrix**

  In the Feature Support matrix around line 30, change **Workers AI** current support from `(both Logpush & Free Proxy modes)` to `Collect access logs via AI Gateway and forward them to Grafana Loki (Logpush mode only)`. Proxy-only mode does not forward logs.

- [ ] **Step 2: Remove stale references to `scripts/setup.sh`**

  Around line 291, replace the paragraph that says `scripts/setup.sh` fetches Loki info. In proxy-only mode there is no Loki setup. Use:

  ```markdown
  Proxy-only mode does not need a Cloud Access Policy token for Loki because it does not forward access logs.
  Use `make setup-grafana` only when you also want to set up the Grafana Loki token for Logpush mode or another Worker.
  ```

- [ ] **Step 3: Restore Logpush secret registration in the paid setup steps**

  Around line 431, restore the three Loki secret commands in the Logpush setup block:

  ```bash
  npx wrangler secret put GRAFANA_CLOUD_LOKI_URL
  npx wrangler secret put GRAFANA_CLOUD_LOKI_USERNAME
  npx wrangler secret put GRAFANA_CLOUD_ACCESS_POLICY_TOKEN
  ```

- [ ] **Step 4: Remove contradictory Common Setup Check**

  Around line 448, the bullet `Proxy-only mode does not use Logpush delivery or RSA key settings.` is in the Logpush section; either remove it or move it to the Free Tier section.

---

### Task 4: Bring Japanese docs in line with proxy-only mode

**Files:**
- Modify: `README.ja.md`
- Modify: `SPEC.ja.md`

**Interfaces:**
- Consumes: Current Japanese docs, updated English README, new setup behavior.
- Produces: Japanese docs that no longer claim Tail Worker / Loki forwarding in Free Tier.

- [ ] **Step 1: Update README.ja.md overview and matrix**

  Around line 20-22, mirror the English change: remove Tail Worker mention, clarify that Free Tier proxy-only mode routes traffic without Logpush/Tail Worker.

  Around line 30, change **Workers AI** current support to mirror the English correction: `(Logpush モードのみ)`.

- [ ] **Step 2: Update README.ja.md Free Tier data flow**

  Around lines 165-203, remove the Tail Worker box from the diagram and update the explanatory text to state that proxy-only mode forwards to AI Gateway but does not push logs to Loki.

- [ ] **Step 3: Update README.ja.md setup steps**

  Around lines 245-266, replace the 10-step `scripts/setup.sh` description with the same 5-step summary as the English README, and point to `scripts/setup-free-tier.sh`.

- [ ] **Step 4: Update SPEC.ja.md component table and data flow**

  Around lines 42-50, mark Tail Worker as `有料プランのオプションコンポーネント` and not used in Free Tier proxy-only mode. Update the Free Tier data-flow diagram around lines 28-40 to remove Loki/Tail Worker boxes.

---

### Task 5: Regression tests for critical contracts

**Files:**
- Create or modify tests in `workers/tests/`

**Interfaces:**
- Consumes: `terraform/main.tf` output semantics, `scripts/setup-free-tier.sh` behavior.
- Produces: Tests that prevent future field-name drift and `.dev.vars` data loss.

- [ ] **Step 1: Add a Terraform field contract test**

  Create `workers/tests/terraform-logpush-fields.test.ts` that reads `terraform/main.tf`, extracts `field_names`, and asserts it contains at least:

  ```typescript
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
  ```

  The test can be a simple Node script executed by Vitest that parses the HCL-like list with a regex. Keep the test deterministic and fast.

- [ ] **Step 2: Run tests and typecheck**

  Run:

  ```bash
  make test
  make typecheck
  ```

  Expected: all tests pass.

---

### Task 6: Final verification and review

**Files:**
- All modified files.

- [ ] **Step 1: Run full verification suite**

  ```bash
  make test
  make typecheck
  make fmt
  make validate
  git diff --check
  bash -n scripts/setup-free-tier.sh
  shellcheck scripts/setup-free-tier.sh
  ```

- [ ] **Step 2: Re-run CodeRabbit review**

  ```bash
  coderabbit review --agent -t uncommitted
  ```

  Address any new critical or major findings.

- [ ] **Step 3: Summarize changes for the user**

  Report what was fixed, what tests now cover, and any remaining intentional behavior (e.g. Logpush mode still requires Loki secrets; proxy-only mode intentionally does not forward logs).
