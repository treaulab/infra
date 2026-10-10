.PHONY: bootstrap plan deploy
bootstrap:
	./scripts/bootstrap.sh
plan:
	cd tofu && tofu init && tofu plan -var-file=envs/prod.tfvars
deploy:
	./scripts/deploy.sh prod
