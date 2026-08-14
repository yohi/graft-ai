# Proxy-Only Deploy Workflow Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close PR #31 and replace its Logpush/Tail-Worker-centric deploy workflow with a proxy-only mode production CD that deploys only the Proxy Worker, Ollama Worker, and Provider Metrics Worker from `master`.

**Architecture:** Use GitHub Actions. Trigger on `master` push and `workflow_dispatch`. Each deployable Worker has its own job. Proxy-only mode intentionally does NOT deploy the Logpush receiver Worker, Tail Worker, Terraform Logpush job, or Terraform Grafana workspace resources. Grafana metrics and alert resources are managed separately and are not part of this Worker-only CD workflow.

**Tech Stack:** GitHub Actions YAML, Bash, Wrangler CLI, Terraform CLI.

## Global Constraints

- Do not commit secrets or credentials.
- All shell scripts must pass `bash -n` and `shellcheck`.
- Deployment workflow changes must be validated by YAML syntax check (e.g. `actionlint` if available, or GitHub's own validation by pushing to a branch).
- `make test`, `make typecheck`, `make fmt`, and `make validate` must pass before any PR handoff.
- Proxy-only mode does not deploy or reference `wrangler.tail.jsonc` in production CD.

---

### Task 1: Close PR #31 and document the rationale

**Files:**
- GitHub operation: PR #31 on `yohi/graft-ai`

**Interfaces:**
- Consumes: Current PR #31 description and the new proxy-only direction.
- Produces: PR #31 closed with a comment explaining why and linking to the replacement plan.

- [ ] **Step 1: Close PR #31 with a comment**

  Use the GitHub API to close PR #31. Add a comment like:

  > Closing this PR because the project direction has shifted to proxy-only mode, which removes the Tail Worker, Logpush receiver, and Grafana Loki secret updates from the production path. A replacement CD workflow tailored to proxy-only mode will be opened as a follow-up PR.

  Command:

  ```bash
  gh pr close 31 --comment "Closing this PR because the project direction has shifted to proxy-only mode. A replacement CD workflow will be opened as a follow-up PR."
  ```

---

### Task 2: Remove stale CI helper scripts from PR #31

**Files:**
- Delete: `scripts/ci-update-wrangler-secrets.sh`
- Delete: `scripts/ci-verify-deployment.sh`
- Modify: `README.md` to remove the CI/CD section added by PR #31

**Interfaces:**
- Consumes: PR #31's added scripts.
- Produces: A clean working tree without the Logpush/Tail-Worker CD helpers.

- [ ] **Step 1: Delete the two CI helper scripts**

  ```bash
  rm scripts/ci-update-wrangler-secrets.sh scripts/ci-verify-deployment.sh
  ```

- [ ] **Step 2: Remove the CI/CD section added by PR #31 from README.md**

  The section starts around the "Quick Commands" block. Remove only the PR #31 "CI/CD" section while keeping the surrounding Free Tier and Logpush sections.

- [ ] **Step 3: Verify no stale script references remain**

  ```bash
  grep -R "ci-update-wrangler-secrets\|ci-verify-deployment" --include="*.yml" --include="*.yaml" --include="*.md" --include="*.sh" .
  ```

  Expected: no matches.

---

### Task 3: Create the proxy-only deploy workflow

**Files:**
- Create: `.github/workflows/deploy.yml`

**Interfaces:**
- Consumes: GitHub Secrets (`CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`) and any Wrangler secrets already registered for the deployed Workers.
- Produces: A deploy workflow that deploys only proxy-only mode Workers.

- [ ] **Step 1: Write the deploy workflow**

  The workflow must contain these jobs:

  | Job | Responsibility |
  | --- | -------------- |
  | `deploy-proxy-worker` | Deploy `graft-ai-aig-proxy` via `wrangler.proxy.jsonc` |
  | `deploy-ollama-worker` | Deploy `graft-ai-ollama-cloud` via `wrangler.ollama.jsonc` |
  | `deploy-provider-metrics-worker` | Deploy `graft-ai-provider-metrics` via `wrangler.provider-metrics.jsonc` |

  Use the Wrangler action pinned to the v3 release commit shown below. Each job runs only on `refs/heads/master` and targets the `production` environment. No Terraform job is included: this workflow has no Terraform credentials, Terraform working directory, or Terraform dependency graph, and a Terraform failure cannot partially block Worker deployment. Terraform Logpush and Grafana resources remain explicit, separately invoked operations.

  ```yaml
  name: Deploy

  on:
    push:
      branches: [master]
    workflow_dispatch:

  jobs:
    deploy-proxy-worker:
      name: Deploy Proxy Worker
      runs-on: ubuntu-latest
      if: github.ref == 'refs/heads/master'
      environment: production
      steps:
        - uses: actions/checkout@11d5960a326750d5838078e36cf38b85af677262 # v4
        - uses: actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020 # v4
          with:
            node-version: 22
            cache: npm
            cache-dependency-path: workers/package-lock.json
        - working-directory: workers
          run: npm ci --ignore-scripts
        - uses: cloudflare/wrangler-action@9acf94ace14e7dc412b076f2c5c20b8ce93c79cd # v3
          with:
            apiToken: ${{ secrets.CLOUDFLARE_API_TOKEN }}
            accountId: ${{ secrets.CLOUDFLARE_ACCOUNT_ID }}
            workingDirectory: workers
            command: deploy --config wrangler.proxy.jsonc

    deploy-ollama-worker:
      name: Deploy Ollama Cloud Worker
      runs-on: ubuntu-latest
      if: github.ref == 'refs/heads/master'
      environment: production
      steps:
        - uses: actions/checkout@11d5960a326750d5838078e36cf38b85af677262 # v4
        - uses: actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020 # v4
          with:
            node-version: 22
            cache: npm
            cache-dependency-path: workers/package-lock.json
        - working-directory: workers
          run: npm ci --ignore-scripts
        - uses: cloudflare/wrangler-action@9acf94ace14e7dc412b076f2c5c20b8ce93c79cd # v3
          with:
            apiToken: ${{ secrets.CLOUDFLARE_API_TOKEN }}
            accountId: ${{ secrets.CLOUDFLARE_ACCOUNT_ID }}
            workingDirectory: workers
            command: deploy --config wrangler.ollama.jsonc

    deploy-provider-metrics-worker:
      name: Deploy Provider Metrics Worker
      runs-on: ubuntu-latest
      if: github.ref == 'refs/heads/master'
      environment: production
      steps:
        - uses: actions/checkout@11d5960a326750d5838078e36cf38b85af677262 # v4
        - uses: actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020 # v4
          with:
            node-version: 22
            cache: npm
            cache-dependency-path: workers/package-lock.json
        - working-directory: workers
          run: npm ci --ignore-scripts
        - uses: cloudflare/wrangler-action@9acf94ace14e7dc412b076f2c5c20b8ce93c79cd # v3
          with:
            apiToken: ${{ secrets.CLOUDFLARE_API_TOKEN }}
            accountId: ${{ secrets.CLOUDFLARE_ACCOUNT_ID }}
            workingDirectory: workers
            command: deploy --config wrangler.provider-metrics.jsonc
  ```

- [ ] **Step 2: Validate YAML syntax**

  If `actionlint` is available:

  ```bash
  actionlint .github/workflows/deploy.yml
  ```

  Confirm each pinned commit in the GitHub repository history resolves to the intended release before handoff: checkout `11d5960a326750d5838078e36cf38b85af677262` (`v4`), setup-node `49933ea5288caeca8642d1e84afbd3f7d6820020` (`v4`), and wrangler-action `9acf94ace14e7dc412b076f2c5c20b8ce93c79cd` (`v3`).

If `actionlint` is unavailable, push the file to a branch and confirm GitHub shows no workflow syntax errors.

---

### Task 4: Update README with the new proxy-only CD section

**Files:**
- Modify: `README.md`

**Interfaces:**
- Consumes: The new `deploy.yml` shape.
- Produces: README text that matches the new workflow.

- [ ] **Step 1: Add a concise CI/CD section**

  After the "Quick Commands" block, add:

  ```markdown
  ## CI/CD

  GitHub Actions workflows drive continuous integration and deployment:

  - `.github/workflows/ci.yml` runs on every Pull Request and non-`master` push:
    - TypeScript type check, Vitest run, Prettier check
    - Terraform fmt/validate for the Cloudflare workspace
  - `.github/workflows/deploy.yml` runs on `master` push and `workflow_dispatch`:
    - Deploys the Proxy Worker, Ollama Cloud Worker, and Provider Metrics Worker via Wrangler
    - Uses the `production` GitHub environment

  Required repository secrets: `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`.
  Provider Metrics and Ollama Cloud Workers need their own secrets registered via Wrangler before the first deploy.

  Configure the GitHub `production` environment with **Required reviewers** and restrict deployment branches to `master` before enabling `deploy.yml`.
  ```

---

### Task 5: Verify everything passes

**Files:**
- All changed files.

- [ ] **Step 1: Run the local verification suite**

  ```bash
  make test
  make typecheck
  make fmt
  make validate
  git diff --check
  actionlint .github/workflows/deploy.yml
  ```

- [ ] **Step 2: Push to a new branch and open a replacement PR**

  ```bash
  git checkout -b feature/proxy-only-deploy-workflow
  git add -A
  git commit -m "ci: proxy-only mode production deploy workflow"
  git push -u origin feature/proxy-only-deploy-workflow
  gh pr create --base feature/ci-workflow --title "ci: proxy-only deploy workflow" --body "..."
  ```

---

### Task 6: Final review and handoff

- [ ] **Step 1: Confirm PR #31 is closed**
- [ ] **Step 2: Confirm the replacement PR is open and clean**
- [ ] **Step 3: Summarize for the user**
