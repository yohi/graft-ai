.PHONY: install fmt validate test typecheck plan apply dev deploy clean

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

clean:
	rm -rf terraform/.terraform
