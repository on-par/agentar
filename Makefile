# Common tasks for agentar. Run `make help` to list them.

# Use the Node version from .nvmrc when nvm has it installed, so `make`
# works even if the shell's node/npm are wrapped by an nvm function.
NVM_NODE := $(lastword $(sort $(wildcard $(HOME)/.nvm/versions/node/v$(shell cat .nvmrc 2>/dev/null).*)))
ifneq ($(NVM_NODE),)
export PATH := $(NVM_NODE)/bin:$(PATH)
endif

PORT ?= 7777

.DEFAULT_GOAL := help
.PHONY: help install models models-all build start dev test typecheck check clean

help: ## Show this help
	@grep -E '^[a-zA-Z_-]+:.*?## ' $(MAKEFILE_LIST) | awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-12s\033[0m %s\n", $$1, $$2}'

node_modules/.package-lock.json: package.json package-lock.json
	npm install
	@touch $@

install: node_modules/.package-lock.json ## Install dependencies (only when package files change)

assets/models/mpfb.glb:
	npm run fetch:models

models: install assets/models/mpfb.glb ## Download the default avatar model

models-all: install ## Download all avatar models
	npm run fetch:models -- --all

build: install ## Build every workspace
	npm run build

start: models build ## Build and start the bridge, then open the avatar (PORT=7777)
	node packages/cli/dist/index.js start --port $(PORT)

dev: models ## Bridge in watch mode + Vite dev server on :5173
	npm run dev

test: install ## Run the Vitest suites
	npm test

typecheck: install ## Type-check every workspace
	npm run typecheck

check: typecheck test ## Type-check and run tests

clean: ## Remove build output
	rm -rf apps/*/dist packages/*/dist
	find apps packages -name '*.tsbuildinfo' -not -path '*/node_modules/*' -delete
