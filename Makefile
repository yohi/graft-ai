.PHONY: install fmt validate test typecheck plan apply dev deploy deploy-ollama deploy-provider-metrics clean setup-free-tier setup-grafana

install:
	cd workers && npm install
	cd workers && npx wrangler types

fmt:
	cd workers && npm run fmt
	terraform fmt -recursive

validate:
	terraform -chdir=terraform init -backend=false
	terraform -chdir=terraform validate

test:
	cd workers && npx vitest run
	node --test tests/parse-jsonc.test.mjs
	node scripts/verify-terraform-logpush-fields.mjs
	node --test tests/verify-terraform-logpush-fields.test.mjs
	bash tests/setup-free-tier.test.sh
	bash tests/manage-cloudflare-logpush-job.test.sh

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
