PREFIX ?= /usr/local
BIN = kusal

build:
	go build -o $(BIN) .

install: build
	install -m 755 $(BIN) $(PREFIX)/bin/$(BIN)
	@echo "✓ installed to $(PREFIX)/bin/$(BIN)"
	@echo "  run: kusal connect"

clean:
	rm -f $(BIN)

tidy:
	go mod tidy
