REGISTRY    ?= quay.io/aipcc
IMAGE       ?= haropz
VERSION     ?= 0.1.0
TAG         ?= $(VERSION)
BASE_IMAGE  ?= quay.io/aipcc/base-images/agentic/pi:0.85.1-1789053384

FULL_IMAGE  = $(REGISTRY)/$(IMAGE):$(TAG)
LATEST      = $(REGISTRY)/$(IMAGE):latest

ENGINE ?= podman
CST    ?= container-structure-test

.PHONY: all build push test smoke integration lint clean help

all: build test ## Build image and run structure tests

build: ## Build the OCI image
	$(ENGINE) build \
		--build-arg BASE_IMAGE=$(BASE_IMAGE) \
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

test: ## Run container structure tests
	$(CST) test --image $(FULL_IMAGE) --config tests/structure-test.yaml

smoke: ## Run runtime smoke tests (requires ANTHROPIC_API_KEY)
	@[[ -n "$$ANTHROPIC_API_KEY" ]] || { echo "ERROR: ANTHROPIC_API_KEY not set"; exit 1; }
	bash tests/smoke_test.sh $(FULL_IMAGE)

integration: build ## Run integration tests against mock Vertex server (no real creds needed)
	@HOST_IP=$$(ip route get 1.1.1.1 | grep -oP 'src \K\S+'); \
	node tests/mock-vertex-server.mjs & MOCK_PID=$$!; \
	sleep 1; \
	echo "say hello" | \
	  openshell sandbox create \
	    --from $(FULL_IMAGE) \
	    --policy ./security/haropz-policy-integration-test.yaml \
	    --env ANTHROPIC_VERTEX_PROJECT_ID=test-project \
	    --env CLOUD_ML_REGION=us-east5 \
	    --env "VERTEX_API_BASE_URL=http://$$HOST_IP:4010" \
	    --no-keep \
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
