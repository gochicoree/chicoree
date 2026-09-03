// Package version carries the build version reported by /internal/v1/status.
// Set at build time with
//
//	go build -ldflags "-X registryd/internal/version.Version=v1.2.3"
package version

// Version is "dev" for local builds; the Dockerfile sets it from VERSION.
var Version = "dev"
