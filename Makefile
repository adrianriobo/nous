REGISTRY    ?= ghcr.io/adrianriobo
IMAGE       ?= nous
VERSION     ?= 0.1.0
TAG         ?= $(VERSION)

FULL_IMAGE  = $(REGISTRY)/$(IMAGE):$(TAG)
LATEST      = $(REGISTRY)/$(IMAGE):latest

# OCE image family. The RHOAI profile pins images by digest from this namespace.
# Override OCE_REGISTRY to publish elsewhere.
OCE_REGISTRY ?= quay.io/aipcc/base-images/agentic
OCE_IMAGE   ?= nous-oce
OCE_FULL_IMAGE = $(OCE_REGISTRY)/$(OCE_IMAGE):$(TAG)

ENGINE ?= podman
CST    ?= container-structure-test

.PHONY: all build push test smoke integration lint clean help \
        build-oce push-oce test-oce smoke-oce

all: build test ## Build image and run structure tests

build: ## Build the OCI image
	$(ENGINE) build \
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

build-oce: ## Build the nous-oce image on the OpenClaw Enterprise runtime
	$(ENGINE) build \
		--target nous-oce \
		--build-arg VERSION=$(VERSION) \
		--label "org.opencontainers.image.version=$(VERSION)" \
		--label "org.opencontainers.image.source=$(shell git remote get-url origin 2>/dev/null || echo unknown)" \
		--label "org.opencontainers.image.revision=$(shell git rev-parse --short HEAD 2>/dev/null || echo unknown)" \
		-t $(OCE_FULL_IMAGE) \
		-f Containerfile \
		.
	@echo "Built $(OCE_FULL_IMAGE)"

push-oce: build-oce ## Push the nous-oce image
	$(ENGINE) push $(OCE_FULL_IMAGE)

test: ## Run container structure tests
	$(CST) test --image $(FULL_IMAGE) --config tests/structure-test.yaml

test-oce: ## Run the nous-oce structure tests
	$(CST) test --image $(OCE_FULL_IMAGE) --config tests/structure-test-oce.yaml

smoke-oce: ## Start the nous-oce gateway as UID 1000 and check /readyz
	ENGINE=$(ENGINE) bash tests/smoke_oce.sh $(OCE_FULL_IMAGE)

smoke: ## Run runtime smoke tests (requires ENMAAS_API_KEY + ENMAAS_BASE_URL)
	@[[ -n "$$ENMAAS_API_KEY" ]] || { echo "ERROR: ENMAAS_API_KEY not set"; exit 1; }
	@[[ -n "$$ENMAAS_BASE_URL" ]] || { echo "ERROR: ENMAAS_BASE_URL not set"; exit 1; }
	bash tests/smoke_test.sh $(FULL_IMAGE)

integration: build ## Run integration tests against mock EnMaaS server (no real creds needed)
	@node tests/mock-enmaas-server.mjs & MOCK_PID=$$!; \
	sleep 1; \
	echo 'say hello' | \
	  $(ENGINE) run --rm -i --network=host \
	    --env ENMAAS_API_KEY=test-key \
	    --env ENMAAS_BASE_URL=http://127.0.0.1:4010/v1 \
	    $(FULL_IMAGE) \
	    -- pi --print -; \
	kill $$MOCK_PID 2>/dev/null || true

lint: ## Lint the Containerfile with hadolint
	@command -v hadolint >/dev/null 2>&1 \
		&& hadolint Containerfile \
		|| echo "hadolint not found — skipping"

clean: ## Remove locally built image tags
	$(ENGINE) rmi -f $(FULL_IMAGE) $(LATEST) 2>/dev/null || true

help: ## Show this help
	@grep -E '^[a-zA-Z_-]+:.*##' $(MAKEFILE_LIST) \
		| awk 'BEGIN {FS = ":.*##"}; {printf "  %-12s %s\n", $$1, $$2}'
