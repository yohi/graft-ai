.PHONY: install fmt validate test typecheck plan apply dev deploy deploy-ollama deploy-provider-metrics deploy-dashboards deploy-alert-rules deploy-otel-worker otel-worker-test otel-worker-validate otel-worker-smoke clean setup-free-tier setup-grafana otel-node-preflight otel-contracts otel-alloy-test otel-validate otel-smoke

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

otel-worker-validate:
	node scripts/verify-otel-worker-config.mjs
	node --test workers/tests/otel-worker-contracts.test.mjs
	cd workers && npm run validate:otel

otel-worker-smoke:
	node scripts/otel-worker-smoke.mjs

deploy-otel-worker:
	cd workers && npx wrangler deploy --config wrangler.otel.jsonc
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
