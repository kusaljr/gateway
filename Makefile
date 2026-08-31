PREFIX ?= /usr/local
BIN ?= bin/kusal
CLI := ./packages/cli
WEB := ./packages/web

.PHONY: build build-cli build-web install dev dev-web dev-cli vet tidy clean help

help:
	@echo "kusal monorepo"
	@echo "  make build        - build CLI (bin/kusal) + web (packages/web/dist)"
	@echo "  make build-cli    - go build CLI only"
	@echo "  make build-web    - npm build web only"
	@echo "  make install      - install bin/kusal to /usr/local/bin"
	@echo "  make dev          - run web dev server"
	@echo "  make dev-cli      - go run CLI"
	@echo "  make vet          - go vet"
	@echo "  make tidy         - go mod tidy"
	@echo "  make clean        - remove bins"

build: build-cli build-web
	@echo "✓ build complete: bin/kusal + packages/web/dist"

build-cli:
	@mkdir -p bin
	go build -o $(BIN) $(CLI)
	@echo "✓ CLI -> $(BIN)"

build-web:
	npm --prefix $(WEB) run build
	@echo "✓ web -> $(WEB)/dist"

install: build-cli
	install -m 755 $(BIN) $(PREFIX)/bin/kusal
	@echo "✓ installed to $(PREFIX)/bin/kusal"

dev:
	npm --prefix $(WEB) run dev

dev-cli:
	go run $(CLI) --help

dev-web:
	npm --prefix $(WEB) run dev

vet:
	go vet ./packages/cli/...

tidy:
	cd packages/cli && go mod tidy

clean:
	rm -rf bin packages/cli/kusal packages/web/dist
