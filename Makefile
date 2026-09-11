REGISTRY      ?= quay.io/aipcc
IMAGE         ?= haropz
VERSION       ?= 0.1.0
TAG           ?= $(VERSION)
BASE_IMAGE    ?= quay.io/aipcc/base-images/agentic/pi:0.85.1-1789053384
BUILDER_IMAGE ?= registry.access.redhat.com/hi/nodejs:26-builder@sha256:b9a4e0ec353dd30a89fc4c18775ac284b1fce6d5e19c2af6d0030be28e46eaf4
# Temporary tmux provider — remove once tmux >= 3.3 is in the base image's rpms.lock.yaml
TMUX_IMAGE    ?= quay.io/centos/centos:stream9
TMUX_VERSION  ?= 3.5a

FULL_IMAGE  = $(REGISTRY)/$(IMAGE):$(TAG)
LATEST      = $(REGISTRY)/$(IMAGE):latest

ENGINE ?= podman

# container-structure-test binary (https://github.com/GoogleContainerTools/container-structure-test)
CST ?= container-structure-test

.PHONY: all build push test smoke lint clean help

all: build test ## Build image and run structure tests

build: ## Build the OCI image
	$(ENGINE) build \
		--build-arg BASE_IMAGE=$(BASE_IMAGE) \
		--build-arg BUILDER_IMAGE=$(BUILDER_IMAGE) \
		--build-arg TMUX_IMAGE=$(TMUX_IMAGE) \
		--build-arg TMUX_VERSION=$(TMUX_VERSION) \
		--build-arg VERSION=$(VERSION) \
		--label "org.opencontainers.image.version=$(VERSION)" \
		--label "org.opencontainers.image.source=$(shell git remote get-url origin 2>/dev/null || echo unknown)" \
		--label "org.opencontainers.image.revision=$(shell git rev-parse --short HEAD 2>/dev/null || echo unknown)" \
		-t $(FULL_IMAGE) \
		-t $(LATEST) \
		-f Containerfile \
		.
	@echo "Built $(FULL_IMAGE)"

push: build ## Push image to registry
	$(ENGINE) push $(FULL_IMAGE)
	$(ENGINE) push $(LATEST)
	@echo "Pushed $(FULL_IMAGE) and $(LATEST)"

test: ## Run container structure tests (requires container-structure-test)
	$(CST) test \
		--image $(FULL_IMAGE) \
		--config tests/structure-test.yaml

smoke: ## Run runtime smoke tests (requires ANTHROPIC_API_KEY)
	@[[ -n "$$ANTHROPIC_API_KEY" ]] || { echo "ERROR: ANTHROPIC_API_KEY not set"; exit 1; }
	bash tests/smoke_test.sh $(FULL_IMAGE)

lint: ## Lint the Containerfile with hadolint (if available)
	@command -v hadolint >/dev/null 2>&1 \
		&& hadolint Containerfile \
		|| echo "hadolint not found — skipping lint"

clean: ## Remove locally built image tags
	$(ENGINE) rmi -f $(FULL_IMAGE) $(LATEST) 2>/dev/null || true

help: ## Show this help
	@grep -E '^[a-zA-Z_-]+:.*##' $(MAKEFILE_LIST) \
		| awk 'BEGIN {FS = ":.*##"}; {printf "  %-12s %s\n", $$1, $$2}'
