// registryd is Chicorée's OCI distribution registry: a small, spec-compliant
// image registry that stores blob content in pluggable backends (filesystem,
// S3) and all metadata in Postgres, with authorization delegated to the web
// application's token service.
package main

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"registryd/internal/api"
	"registryd/internal/auth"
	"registryd/internal/config"
	"registryd/internal/hooks"
	"registryd/internal/storage"
	"registryd/internal/store"
	"registryd/internal/traffic"

	// Storage plugins register themselves on import. Add new backends here.
	_ "registryd/internal/storage/bunny"
	_ "registryd/internal/storage/filesystem"
	_ "registryd/internal/storage/s3"
)

func main() {
	if len(os.Args) > 1 && os.Args[1] == "plugins" {
		printPlugins()
		return
	}
	cfg, err := config.Load()
	if err != nil {
		slog.Error("configuration error", "err", err)
		os.Exit(1)
	}

	var handler slog.Handler = slog.NewTextHandler(os.Stdout, nil)
	if cfg.LogFormat == "json" {
		handler = slog.NewJSONHandler(os.Stdout, nil)
	}
	slog.SetDefault(slog.New(handler))

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	st, err := store.New(ctx, cfg.DatabaseURL)
	if err != nil {
		slog.Error("database connection failed", "err", err)
		os.Exit(1)
	}
	defer st.Close()
	if err := st.WaitForSchema(ctx, 2*time.Minute); err != nil {
		slog.Error("database schema not ready", "err", err)
		os.Exit(1)
	}

	driver, err := storage.Open(ctx, cfg.StorageDriver, storage.NewEnvOptions(cfg.StorageDriver))
	if err != nil {
		slog.Error("storage driver init failed", "driver", cfg.StorageDriver, "err", err)
		os.Exit(1)
	}

	// Upload staging: node-local files (default) or, for several replicas
	// behind one load balancer, sessions in Postgres with chunks in the
	// storage backend.
	hostname, _ := os.Hostname()
	staging, err := storage.OpenStaging(cfg.StorageStaging, cfg.StagingDir, driver, st, hostname, cfg.UploadSessionTTL)
	if err != nil {
		slog.Error("staging init failed", "mode", cfg.StorageStaging, "err", err)
		os.Exit(1)
	}

	verifier, err := auth.NewVerifier(cfg.JWTPublicKey, cfg.TokenRealm, cfg.TokenService, cfg.TokenIssuer, cfg.AuthDisabled)
	if err != nil {
		slog.Error("token verifier init failed", "err", err)
		os.Exit(1)
	}
	if cfg.AuthDisabled {
		slog.Warn("AUTH_DISABLED is set: every request is treated as an administrator; never use this in production")
	}

	notifier := hooks.NewNotifier(cfg.WebhookURL, cfg.WebhookSecret)
	server := api.NewServer(cfg, st, driver, staging, verifier, notifier)

	// Egress/ingress accounting: aggregated in memory, flushed to
	// repository_traffic every 10s and once more on shutdown.
	counter := traffic.New(st.UpsertTraffic)
	server.UseTraffic(counter)
	trafficDone := make(chan struct{})
	go func() {
		defer close(trafficDone)
		counter.Run(ctx, 10*time.Second)
	}()

	// Pull rate limits: the admin panel's settings row, else the environment;
	// re-read every 30s so changes apply without a restart.
	if err := server.EnableRateLimiting(ctx); err != nil {
		slog.Error("rate limit configuration invalid", "err", err)
		os.Exit(1)
	}
	go server.RunRateLimitReload(ctx, 30*time.Second)

	httpServer := &http.Server{
		Addr:              cfg.ListenAddr,
		Handler:           server.Handler(),
		ReadHeaderTimeout: 10 * time.Second,
		// No global write timeout: blob transfers can be long-lived.
	}

	go func() {
		<-ctx.Done()
		shutdownCtx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
		defer cancel()
		_ = httpServer.Shutdown(shutdownCtx)
	}()

	// Periodically sweep abandoned upload sessions.
	go func() {
		ticker := time.NewTicker(time.Hour)
		defer ticker.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
				n, err := staging.Sweep(ctx)
				if err != nil {
					slog.Warn("upload session sweep failed", "err", err)
				}
				if n > 0 {
					slog.Info("swept stale upload sessions", "count", n)
				}
			}
		}
	}()

	slog.Info("registryd listening", "addr", cfg.ListenAddr, "storage", driver.Name(), "staging", staging.Mode(), "authDisabled", cfg.AuthDisabled)
	if err := httpServer.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
		slog.Error("http server failed", "err", err)
		os.Exit(1)
	}
	// Let the traffic counter write its last batch before the process ends.
	stop()
	<-trafficDone
	slog.Info("registryd stopped")
}

// printPlugins documents the available storage backends and their options.
func printPlugins() {
	for _, p := range storage.Plugins() {
		fmt.Printf("%s — %s\n", p.Name, p.Description)
		for _, o := range p.Options {
			req := ""
			if o.Required {
				req = " (required)"
			}
			def := ""
			if o.Default != "" {
				def = " [default: " + o.Default + "]"
			}
			fmt.Printf("  %-28s %s%s%s\n", storage.EnvName(p.Name, o.Key), o.Description, def, req)
		}
		fmt.Println()
	}
}
