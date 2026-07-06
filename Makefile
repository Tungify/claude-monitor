BINARY       := claude-monitor
PKG          := ./cmd/claude-monitor
MENUBAR_DIR  := macos/menubar
ALL_PKGS     := ./...
BIN_DIR      := bin
WEB_DIR      := web
MCP_SERVERS  := mcp-servers/clickup
INSTALL_DIR  ?= $(HOME)/bin
# macOS menu-bar app bundle. Space in the name is intentional (Finder name);
# every recipe reference is quoted.
APP_DIR      := $(BIN_DIR)/Claude Monitor.app

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

.PHONY: all build build-go build-web build-mcp menubar menubar-install run once install clean fmt vet tidy release help

all: build

## build: compile Go binary, build the Next.js web orchestrator, and the local MCP servers
build: build-go build-web build-mcp

## build-mcp: build every in-tree local MCP server (Node TypeScript projects)
build-mcp:
	@for d in $(MCP_SERVERS); do \
		echo "building $$d"; \
		(cd $$d && npm install --silent && npm run build --silent) || exit 1; \
	done
	@echo "built local MCP servers"

## build-go: compile the Go binary into ./bin/
build-go:
	@mkdir -p $(BIN_DIR)
	go build -ldflags '$(LDFLAGS)' -o $(BIN_DIR)/$(BINARY) $(PKG)
	@if [ "$(GOOS)" = "darwin" ]; then codesign -f -s - $(BIN_DIR)/$(BINARY) >/dev/null; fi
	@echo "built $(BIN_DIR)/$(BINARY) ($(GOOS)/$(GOARCH), $(VERSION))"

## build-web: install web deps + run `next build` so claude-monitor can spawn it
build-web:
	@command -v pnpm >/dev/null 2>&1 || { echo "pnpm not found; install with: npm i -g pnpm"; exit 1; }
	@cd $(WEB_DIR) && pnpm install --frozen-lockfile
	@cd $(WEB_DIR) && pnpm exec next build
	@echo "built $(WEB_DIR)/.next"

## menubar: build the native SwiftUI menu-bar app -> "bin/Claude Monitor.app" (macOS only)
menubar:
	@if [ "$(GOOS)" != "darwin" ]; then echo "menubar is macOS-only (GOOS=$(GOOS))"; exit 1; fi
	@command -v swift >/dev/null 2>&1 || { echo "swift not found; install Xcode Command Line Tools: xcode-select --install"; exit 1; }
	@rm -rf "$(APP_DIR)"
	@mkdir -p "$(APP_DIR)/Contents/MacOS"
	swift build --package-path $(MENUBAR_DIR) -c release
	cp "$(MENUBAR_DIR)/.build/release/claude-menubar" "$(APP_DIR)/Contents/MacOS/claude-menubar"
	go build -ldflags '$(LDFLAGS)' -o "$(APP_DIR)/Contents/MacOS/claude-monitor" $(PKG)
	@printf '%s\n' \
		'<?xml version="1.0" encoding="UTF-8"?>' \
		'<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">' \
		'<plist version="1.0"><dict>' \
		'	<key>CFBundleName</key><string>Claude Monitor</string>' \
		'	<key>CFBundleDisplayName</key><string>Claude Monitor</string>' \
		'	<key>CFBundleIdentifier</key><string>com.claude-monitor.menubar</string>' \
		'	<key>CFBundleExecutable</key><string>claude-menubar</string>' \
		'	<key>CFBundlePackageType</key><string>APPL</string>' \
		'	<key>CFBundleShortVersionString</key><string>$(VERSION)</string>' \
		'	<key>CFBundleVersion</key><string>$(VERSION)</string>' \
		'	<key>LSMinimumSystemVersion</key><string>14.0</string>' \
		'	<key>LSUIElement</key><true/>' \
		'	<key>NSHighResolutionCapable</key><true/>' \
		'</dict></plist>' > "$(APP_DIR)/Contents/Info.plist"
	@codesign -f -s - "$(APP_DIR)" >/dev/null
	@echo "built \"$(APP_DIR)\""
	@echo "  open it now:   open \"$(APP_DIR)\""
	@echo "  install it:    make menubar-install   (copies to /Applications)"
	@echo "  auto-start:    enable \"Open at Login\" from the menu-bar dropdown"

## menubar-install: build the app bundle and copy it into /Applications
menubar-install: menubar
	@rm -rf "/Applications/Claude Monitor.app"
	@cp -R "$(APP_DIR)" "/Applications/Claude Monitor.app"
	@echo "installed \"/Applications/Claude Monitor.app\" — launch it from Spotlight or /Applications"

## run: build everything and start claude-monitor (daemon + web)
run: build
	$(BIN_DIR)/$(BINARY)

## install: copy binary AND web build to $(INSTALL_DIR) (default: ~/bin)
install: build
	@mkdir -p $(INSTALL_DIR)
	install -m 0755 $(BIN_DIR)/$(BINARY) $(INSTALL_DIR)/$(BINARY)
	@echo "installed to $(INSTALL_DIR)/$(BINARY)"
	@echo "note: web build stays at $(CURDIR)/$(WEB_DIR); claude-monitor finds it via the binary's location."
	@echo "      to relocate, set CLAUDE_MONITOR_WEB_DIR or run from a layout where the binary's parent has a web/ sibling."

## fmt: gofmt all sources
fmt:
	gofmt -s -w .

## vet: go vet
vet:
	go vet $(ALL_PKGS)

## tidy: tidy go.mod
tidy:
	go mod tidy

## clean: remove Go build artifacts (web build kept — `cd web && pnpm clean` for that)
clean:
	rm -rf $(BIN_DIR) $(BINARY)

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

## help: list targets
help:
	@grep -E '^## ' Makefile | sed 's/^## /  /'
