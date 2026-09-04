.PHONY: install fmt validate test typecheck plan apply dev deploy deploy-ollama deploy-provider-metrics deploy-dashboards deploy-alert-rules otel-worker-infrastructure render-otel-worker-config deploy-otel-worker otel-worker-test otel-worker-validate otel-worker-smoke clean setup-free-tier setup-grafana otel-node-preflight otel-contracts otel-alloy-test otel-validate otel-smoke

OTEL_PAYLOAD_STORE ?= d1
OTEL_PAYLOAD_R2_DRAIN ?= false

install:
	cd workers && npm install
	cd workers && npx wrangler types

fmt:
	cd workers && npm run fmt
	cd workers && npx prettier --write "../deploy/otel/contracts/encoding.mjs" "../tests/otel-contracts.test.mjs" "../scripts/deploy-dashboards.mjs" "../scripts/deploy-alert-rules.mjs" "../tests/deploy-dashboards.test.mjs" "../tests/deploy-alert-rules.test.mjs" "../tests/otel-cloud-config.test.mjs" "../tests/deployment-contracts.test.mjs"
	$(MAKE) -C deploy/otel/alloy fmt
	terraform fmt -recursive

validate:
	terraform -chdir=terraform init -backend=false
	terraform -chdir=terraform validate

test:
	$(MAKE) otel-contracts
	$(MAKE) otel-alloy-test
	cd workers && npx vitest run
	$(MAKE) otel-worker-test
	node --test tests/parse-jsonc.test.mjs
	node scripts/verify-terraform-logpush-fields.mjs
	node --test tests/verify-terraform-logpush-fields.test.mjs
	node --test tests/deploy-dashboards.test.mjs
	node --test tests/deploy-alert-rules.test.mjs
	node --test tests/otel-cloud-config.test.mjs
	node --test tests/deployment-contracts.test.mjs
	node --test tests/sync-otel-github-secrets.test.mjs
	node --test tests/otel-worker-smoke.test.mjs
	$(MAKE) otel-validate
	node --test tests/otel-smoke-retry.test.mjs
	bash tests/setup-free-tier.test.sh
	bash tests/manage-cloudflare-logpush-job.test.sh
	bash tests/compose-smoke-cleanup.test.sh

otel-node-preflight:
	@node -e 'const major = Number(process.versions.node.split(".")[0]); if (major < 22) { console.error("Node.js >= 22 is required for OTel contract tests"); process.exit(1); }'

otel-contracts: otel-node-preflight
	node --test tests/otel-contracts.test.mjs

otel-alloy-test:
	$(MAKE) -C deploy/otel/alloy test

otel-validate: otel-node-preflight
	node scripts/verify-otel-config.mjs
	node --test tests/otel-dashboard.test.mjs
	docker compose -f deploy/otel/docker-compose.yml config >/dev/null

otel-smoke: otel-validate
	bash deploy/otel/tests/compose-smoke.test.sh

otel-worker-test:
	cd workers && npm run test:otel
	cd workers && npm run test:otel:r2
	cd workers && npm run test:otel:kv-r2-drain

otel-worker-validate:
	node scripts/verify-otel-worker-config.mjs
	node --test workers/tests/otel-worker-contracts.test.mjs
	cd workers && npm run validate:otel

otel-worker-smoke:
	node scripts/otel-worker-smoke.mjs

otel-worker-infrastructure:
	@set -eu; \
	case "$(OTEL_PAYLOAD_STORE)" in d1|kv|r2) ;; *) printf '%s\n' 'OTEL_PAYLOAD_STORE must be d1, kv, or r2.' >&2; exit 1 ;; esac; \
	case "$(OTEL_PAYLOAD_R2_DRAIN)" in true|false) ;; *) printf '%s\n' 'OTEL_PAYLOAD_R2_DRAIN must be exactly true or false.' >&2; exit 1 ;; esac; \
	if [ "$(OTEL_PAYLOAD_STORE)" = r2 ] && [ "$(OTEL_PAYLOAD_R2_DRAIN)" = true ]; then printf '%s\n' 'OTEL_PAYLOAD_R2_DRAIN=true is redundant when OTEL_PAYLOAD_STORE=r2.' >&2; exit 1; fi; \
	terraform -chdir=terraform init; \
	if [ "$(OTEL_PAYLOAD_STORE)" = r2 ] || [ "$(OTEL_PAYLOAD_R2_DRAIN)" = true ]; then \
		terraform -chdir=terraform apply -input=false -auto-approve \
			-target=cloudflare_queue.otel \
			-target=cloudflare_queue.otel_dlq \
			-target=cloudflare_workers_kv_namespace.otel_payloads \
			-target=cloudflare_d1_database.otel_payloads \
			-target=cloudflare_r2_bucket.otel \
			-target=cloudflare_r2_bucket_lifecycle.otel; \
	else \
		terraform -chdir=terraform apply -input=false -auto-approve \
			-target=cloudflare_queue.otel \
			-target=cloudflare_queue.otel_dlq \
			-target=cloudflare_workers_kv_namespace.otel_payloads \
			-target=cloudflare_d1_database.otel_payloads; \
	fi

render-otel-worker-config:
	@set -eu; \
	case "$(OTEL_PAYLOAD_STORE)" in d1|kv|r2) ;; *) printf '%s\n' 'OTEL_PAYLOAD_STORE must be d1, kv, or r2.' >&2; exit 1 ;; esac; \
	case "$(OTEL_PAYLOAD_R2_DRAIN)" in true|false) ;; *) printf '%s\n' 'OTEL_PAYLOAD_R2_DRAIN must be exactly true or false.' >&2; exit 1 ;; esac; \
	if [ "$(OTEL_PAYLOAD_STORE)" = r2 ] && [ "$(OTEL_PAYLOAD_R2_DRAIN)" = true ]; then printf '%s\n' 'OTEL_PAYLOAD_R2_DRAIN=true is redundant when OTEL_PAYLOAD_STORE=r2.' >&2; exit 1; fi; \
	namespace_id="$(OTEL_PAYLOAD_KV_NAMESPACE_ID)"; \
	if [ -z "$$namespace_id" ]; then namespace_id="$$(terraform -chdir=terraform output -raw otel_payload_kv_namespace_id 2>/dev/null || true)"; fi; \
	case "$$namespace_id" in \
	  "") printf '%s\n' 'Set OTEL_PAYLOAD_KV_NAMESPACE_ID before rendering the OTel Worker config.' >&2; exit 1 ;; \
	  *[!0-9a-fA-F]*) printf '%s\n' 'OTEL_PAYLOAD_KV_NAMESPACE_ID must be a 32-character hex string.' >&2; exit 1 ;; \
	esac; \
	if [ "$${#namespace_id}" -ne 32 ]; then printf '%s\n' 'OTEL_PAYLOAD_KV_NAMESPACE_ID must be a 32-character hex string.' >&2; exit 1; fi; \
	r2_flag=""; \
	if [ "$(OTEL_PAYLOAD_STORE)" = r2 ] || [ "$(OTEL_PAYLOAD_R2_DRAIN)" = true ]; then r2_flag="--include-r2-binding"; fi; \
	d1_flag=""; \
	if [ "$(OTEL_PAYLOAD_STORE)" = d1 ]; then \
	  d1_id="$(OTEL_PAYLOAD_D1_DATABASE_ID)"; \
	  if [ -z "$$d1_id" ]; then d1_id="$$(terraform -chdir=terraform output -raw otel_payload_d1_database_id 2>/dev/null || true)"; fi; \
	  case "$$d1_id" in \
	    "") printf '%s\n' 'Set OTEL_PAYLOAD_D1_DATABASE_ID before rendering the OTel Worker config in d1 mode.' >&2; exit 1 ;; \
	  esac; \
	  d1_flag="--d1-database-id $$d1_id"; \
	fi; \
	node scripts/render-otel-worker-config.mjs \
	  --payload-store "$(OTEL_PAYLOAD_STORE)" \
	  --kv-namespace-id "$$namespace_id" \
	  $$d1_flag \
	  --output workers/.wrangler/otel.generated.jsonc $$r2_flag

deploy-otel-worker: otel-worker-infrastructure
	cd workers && npx wrangler d1 migrations apply graft-ai-aig-otel-payloads-v1 --remote
	$(MAKE) render-otel-worker-config
	cd workers && npx wrangler deploy --config .wrangler/otel.generated.jsonc
typecheck:
	cd workers && npm run typecheck:ci

plan:
	terraform -chdir=terraform init
	terraform -chdir=terraform plan

apply:
	terraform -chdir=terraform init
	terraform -chdir=terraform apply

dev:
	cd workers && npx wrangler dev

deploy:
	scripts/verify-deployment-env.sh
	cd workers && npx wrangler deploy
	terraform -chdir=terraform init
	terraform -chdir=terraform apply

# Free Tier: proxy-only setup; no Tail Worker, Logpush, or Terraform apply.
setup-free-tier:
	bash scripts/setup-free-tier.sh

# Free Tier: create/rotate Grafana Access Policy token via Terraform and re-register secrets
setup-grafana:
	bash scripts/tf-apply-grafana.sh

clean:
	rm -rf terraform/.terraform

deploy-ollama:
	cd workers && npx wrangler deploy --config wrangler.ollama.jsonc

deploy-provider-metrics:
	cd workers && npx wrangler deploy --config wrangler.provider-metrics.jsonc

deploy-dashboards:
	node scripts/deploy-dashboards.mjs

deploy-alert-rules:
	node scripts/deploy-alert-rules.mjs


.PHONY: validate-grafana plan-grafana apply-grafana

validate-grafana:
	terraform -chdir=terraform/grafana init -backend=false
	terraform -chdir=terraform/grafana validate

plan-grafana:
	terraform -chdir=terraform/grafana init
	terraform -chdir=terraform/grafana plan

apply-grafana:
	terraform -chdir=terraform/grafana init
	terraform -chdir=terraform/grafana apply
