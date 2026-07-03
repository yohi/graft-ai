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
	cd workers && npm run typecheck:ci

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
