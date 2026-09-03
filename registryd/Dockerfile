FROM golang:1.26-alpine AS build
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY . .
# VERSION shows up in /internal/v1/status and the admin health page.
ARG VERSION=dev
RUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w -X registryd/internal/version.Version=${VERSION}" -o /out/registryd ./cmd/registryd

FROM alpine:3.22
RUN apk add --no-cache ca-certificates && adduser -D -u 10001 registry
COPY --from=build /out/registryd /usr/local/bin/registryd
RUN mkdir -p /var/lib/registry && chown registry:registry /var/lib/registry
USER registry
EXPOSE 5000
ENTRYPOINT ["registryd"]
