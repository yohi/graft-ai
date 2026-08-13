# Proxy-Only Free Tier Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the documented and runnable deployment path use only the AI Gateway proxy Worker on Cloudflare Free, without Workers Logpush or Tail Worker dependencies.

**Architecture:** Clients call `graft-ai-aig-proxy`, which authenticates with `X-Proxy-Secret`, forwards requests to AI Gateway, and returns the upstream response. Provider metrics and any other independently deployable Workers remain separate; no Logpush job or Tail Worker is deployed or applied.

**Tech Stack:** TypeScript Cloudflare Workers, Wrangler, Bash, Make, Terraform only for Grafana resources when explicitly needed.

## Global Constraints

- Do not run or require `terraform -chdir=terraform apply` for proxy-only mode.
- Do not deploy `wrangler.jsonc` Logpush receiver or `wrangler.tail.jsonc` Tail Worker.
- Never commit `.env`, `.dev.vars`, API tokens, RSA private keys, or proxy secrets.
- Keep Loki labels limited to `model`, `status_code`, `env`, and `gateway`.
- Run `make test`, `make typecheck`, and `make fmt` after TypeScript or configuration changes.

---

### Task 1: Remove Logpush-only deployment coupling

**Files:**
- Modify: `Makefile`
- Modify: `README.md` sections describing Free Tier setup and deployment
- Modify: `SPEC.md` mode/reliability notes if they present Logpush as required for the selected mode

**Interfaces:**
- Produces a proxy-only command path that never invokes Terraform Logpush apply or Tail Worker deployment.

- [ ] **Step 1: Add a regression check for the proxy-only command path**

  Add a shell-level assertion or documented command check that `make setup-free-tier` invokes the setup script and does not invoke `terraform -chdir=terraform apply`.

- [ ] **Step 2: Run the check and verify it fails against the current deployment coupling**

  Run the targeted check and confirm the current documentation/command path still exposes the Logpush/Tail Worker dependency.

- [ ] **Step 3: Make the smallest deployment-path change**

  Ensure the proxy-only target calls only the proxy deployment flow. Keep Grafana setup as an explicit, separate operation and do not silently create a Logpush job.

- [ ] **Step 4: Run the targeted check and verify it passes**

  Run the check again and confirm the proxy-only path contains no Logpush Terraform apply or Tail Worker deployment requirement.

- [ ] **Step 5: Run Markdown and Make validation**

  Run `make fmt` and the repository's Markdown validation if configured.

### Task 2: Verify proxy behavior through its real surface

**Files:**
- Inspect: `workers/src/proxy.ts`
- Inspect: `workers/wrangler.proxy.jsonc`
- Test: `workers/tests/proxy.test.ts`

**Interfaces:**
- Consumes: `PROXY_SECRET`, `CF_ACCOUNT_ID`, and `AI_GATEWAY_ID`.
- Produces: an independently deployable proxy Worker that forwards authenticated requests and rejects invalid credentials.

- [ ] **Step 1: Run focused proxy tests**

  Run `cd workers && npx vitest run tests/proxy.test.ts` and record the authentication and forwarding results.

- [ ] **Step 2: Run full application verification**

  Run `make test`, `make typecheck`, and `make fmt`.

- [ ] **Step 3: Deploy only the proxy Worker using configured local secrets**

  Use `npx wrangler deploy --config wrangler.proxy.jsonc` after confirming the local secret is not tracked.

- [ ] **Step 4: Exercise the deployed Worker**

  Send one request with the configured `X-Proxy-Secret` and one request with an invalid secret. Verify the valid request reaches the configured AI Gateway endpoint and the invalid request is rejected without exposing secrets.

### Task 3: Document operational limitations and final verification

**Files:**
- Modify: `README.md`
- Modify: `SPEC.md` if necessary

**Interfaces:**
- Produces: unambiguous operator documentation for Free-tier proxy-only mode.

- [ ] **Step 1: Document the observable data boundary**

  State that only requests sent through the proxy can be observed, while direct AI Gateway requests, historical Logpush records, and Tail Worker delivery are unavailable on the selected plan.

- [ ] **Step 2: Document the exact commands**

  Keep the proxy setup and deploy commands explicit, and mark Logpush/Tail Worker/Terraform apply commands as paid-plan-only and out of scope for this mode.

- [ ] **Step 3: Run final validation**

  Run `make test`, `make typecheck`, `make fmt`, and inspect `git diff --check`. Confirm `.env` and other secret files remain untracked and unchanged.

- [ ] **Step 4: Perform manual QA**

  Use the deployed proxy as a client would: verify a successful authenticated request and a rejected unauthenticated request. Stop only after both behaviors are observed.
