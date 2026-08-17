.PHONY: fmt test vet build

fmt:
	gofmt -w cmd internal

test:
	go test -race -shuffle=on -count=1 ./...

vet:
	go vet ./...

build:
	CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -trimpath -ldflags="-s -w" -o bin/alloy-otel ./cmd/alloy-otel
