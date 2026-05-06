BINARY      := claude-analytic
PKG         := ./...
BIN_DIR     := bin
INSTALL_DIR ?= $(HOME)/bin

GOOS   ?= $(shell go env GOOS)
GOARCH ?= $(shell go env GOARCH)

VERSION ?= $(shell git describe --tags --always --dirty 2>/dev/null || echo dev)
# Go 1.22's internal linker doesn't emit LC_UUID on recent macOS, which
# dyld then rejects. -linkmode=external delegates to clang and the
# resulting binary needs an ad-hoc signature, which we apply post-build.
LDFLAGS := -X main.version=$(VERSION)
ifeq ($(GOOS),darwin)
LDFLAGS += -linkmode=external
endif

.PHONY: all build run once install clean fmt vet tidy release help

all: build

## build: compile binary into ./bin/
build:
	@mkdir -p $(BIN_DIR)
	go build -ldflags '$(LDFLAGS)' -o $(BIN_DIR)/$(BINARY) $(PKG)
	@if [ "$(GOOS)" = "darwin" ]; then codesign -f -s - $(BIN_DIR)/$(BINARY) >/dev/null; fi
	@echo "built $(BIN_DIR)/$(BINARY) ($(GOOS)/$(GOARCH), $(VERSION))"

## run: build and start the live dashboard
run: build
	$(BIN_DIR)/$(BINARY)

## once: build and render a single snapshot
once: build
	$(BIN_DIR)/$(BINARY) --once

## install: copy binary to $(INSTALL_DIR) (default: ~/bin)
install: build
	@mkdir -p $(INSTALL_DIR)
	install -m 0755 $(BIN_DIR)/$(BINARY) $(INSTALL_DIR)/$(BINARY)
	@echo "installed to $(INSTALL_DIR)/$(BINARY)"

## release: cross-compile darwin+linux, amd64+arm64 into ./bin/
release:
	@mkdir -p $(BIN_DIR)
	@for os in darwin linux; do \
		for arch in amd64 arm64; do \
			out=$(BIN_DIR)/$(BINARY)-$$os-$$arch; \
			echo "building $$out"; \
			GOOS=$$os GOARCH=$$arch go build -ldflags '$(LDFLAGS)' -o $$out $(PKG) || exit 1; \
		done; \
	done

## fmt: gofmt all sources
fmt:
	gofmt -s -w .

## vet: go vet
vet:
	go vet $(PKG)

## tidy: tidy go.mod
tidy:
	go mod tidy

## clean: remove build artifacts
clean:
	rm -rf $(BIN_DIR) $(BINARY)

## help: list targets
help:
	@grep -E '^## ' Makefile | sed 's/^## /  /'
