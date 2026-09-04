package api

import (
	"crypto/subtle"
	"encoding/json"
	"log/slog"
	"net/http"
	"runtime"
	"strings"
	"time"

	"registryd/internal/version"
)

// internalAuthorized checks the shared webhook secret on internal routes.
func (s *Server) internalAuthorized(r *http.Request) bool {
	token, ok := strings.CutPrefix(r.Header.Get("Authorization"), "Bearer ")
	return s.cfg.WebhookSecret != "" && ok &&
		subtle.ConstantTimeCompare([]byte(token), []byte(s.cfg.WebhookSecret)) == 1
}

// handleHealthz is the liveness endpoint used by compose/k8s health checks.
func (s *Server) handleHealthz(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]string{"status": "ok", "storage": s.driver.Name()})
}

// internalAuthorized checks the bearer token on the internal surface (GC,
// status): it must equal the shared webhook secret, which must be configured.
func internalAuthorized(r *http.Request, secret string) bool {
	token, ok := strings.CutPrefix(r.Header.Get("Authorization"), "Bearer ")
	if secret == "" || !ok {
		return false
	}
	return subtle.ConstantTimeCompare([]byte(token), []byte(secret)) == 1
}

// StatusResponse is what /internal/v1/status returns to the web app's health
// page. Numbers are -1 when they could not be determined.
type StatusResponse struct {
	Status    string `json:"status"`
	Version   string `json:"version"`
	GoVersion string `json:"goVersion"`
	Storage   string `json:"storage"`
	// Staging is "local" (node-local files under StagingDir) or "shared"
	// (sessions in Postgres, chunks in the backend); StagingDir and the
	// free-space figure only apply to local staging.
	Staging          string `json:"staging"`
	StagingDir       string `json:"stagingDir"`
	StagingFreeBytes int64  `json:"stagingFreeBytes"`
	// UploadSessions counts in-flight shared upload sessions (-1 in local mode).
	UploadSessions       int64   `json:"uploadSessions"`
	BlobCount            int64   `json:"blobCount"`
	BlobBytes            int64   `json:"blobBytes"`
	StartedAt            string  `json:"startedAt"`
	UptimeSeconds        float64 `json:"uptimeSeconds"`
	PublicKeyFingerprint string  `json:"publicKeyFingerprint"`
	AuthDisabled         bool    `json:"authDisabled"`
	DatabaseError        string  `json:"databaseError,omitempty"`
}

// handleStatus reports build and runtime facts for the admin health page.
// Authenticated like GC with the shared webhook secret.
func (s *Server) handleStatus(w http.ResponseWriter, r *http.Request) {
	if !internalAuthorized(r, s.cfg.WebhookSecret) {
		writeError(w, http.StatusUnauthorized, CodeUnauthorized, "invalid status credential")
		return
	}
	resp := StatusResponse{
		Status:               "ok",
		Version:              version.Version,
		GoVersion:            runtime.Version(),
		Storage:              s.driver.Name(),
		Staging:              s.staging.Mode(),
		StagingDir:           s.cfg.StagingDir,
		StagingFreeBytes:     diskFreeBytes(s.cfg.StagingDir),
		UploadSessions:       -1,
		BlobCount:            -1,
		BlobBytes:            -1,
		StartedAt:            s.started.UTC().Format(time.RFC3339),
		UptimeSeconds:        time.Since(s.started).Seconds(),
		PublicKeyFingerprint: s.verifier.PublicKeyFingerprint(),
		AuthDisabled:         s.verifier.Disabled(),
	}
	if count, bytes, err := s.store.BlobStats(r.Context()); err != nil {
		resp.Status = "degraded"
		resp.DatabaseError = err.Error()
	} else {
		resp.BlobCount, resp.BlobBytes = count, bytes
	}
	if resp.Staging == "shared" {
		resp.StagingDir, resp.StagingFreeBytes = "", -1
		if n, err := s.store.UploadSessionCount(r.Context()); err == nil {
			resp.UploadSessions = n
		}
	}
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(resp)
}

// handleGC runs a garbage collection pass: drop blob links no manifest
// references, delete unreferenced blob rows, remove their content from the
// backend, and sweep stale upload sessions. Authenticated with the shared
// webhook secret; triggered from the web app's admin screen.
func (s *Server) handleGC(w http.ResponseWriter, r *http.Request) {
	if !internalAuthorized(r, s.cfg.WebhookSecret) {
		writeError(w, http.StatusUnauthorized, CodeUnauthorized, "invalid gc credential")
		return
	}

	grace := s.cfg.GCGracePeriod
	if v := r.URL.Query().Get("grace"); v != "" {
		if parsed, err := time.ParseDuration(v); err == nil && parsed >= 0 {
			grace = parsed
		}
	}

	res, err := s.store.CollectGarbage(r.Context(), grace)
	if err != nil {
		writeInternal(w, r, err)
		return
	}
	deleted := 0
	for _, digest := range res.OrphanedDigests {
		if err := s.driver.Delete(r.Context(), digest); err != nil {
			slog.Warn("gc: delete blob from storage failed", "digest", digest, "err", err)
			continue
		}
		deleted++
	}
	swept, err := s.staging.Sweep(r.Context())
	if err != nil {
		slog.Warn("gc: upload session sweep failed", "err", err)
	}
	res.SweptUploads = swept
	slog.Info("gc complete", "unlinked", res.UnlinkedBlobs, "deletedRows", res.DeletedBlobs,
		"deletedObjects", deleted, "sweptUploads", res.SweptUploads)

	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]any{
		"unlinkedBlobs":  res.UnlinkedBlobs,
		"deletedBlobs":   res.DeletedBlobs,
		"deletedObjects": deleted,
		"sweptUploads":   res.SweptUploads,
	})
}
