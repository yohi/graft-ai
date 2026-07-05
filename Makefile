.PHONY: install fmt validate test typecheck plan apply dev deploy clean setup-free-tier setup-grafana

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

# Free Tier: full automated setup (Grafana Access Policy + Wrangler secrets + deploy)
setup-free-tier:
	bash scripts/setup.sh

# Free Tier: create/rotate Grafana Access Policy token via Terraform and re-register secrets
setup-grafana:
	bash scripts/tf-apply-grafana.sh

clean:
	rm -rf terraform/.terraform
