package api

import (
	"crypto/subtle"
	"encoding/json"
	"log/slog"
	"net/http"
	"strings"
	"time"
)

// handleHealthz is the liveness endpoint used by compose/k8s health checks.
func (s *Server) handleHealthz(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]string{"status": "ok", "storage": s.driver.Name()})
}

// handleGC runs a garbage collection pass: drop blob links no manifest
// references, delete unreferenced blob rows, remove their content from the
// backend, and sweep stale upload sessions. Authenticated with the shared
// webhook secret; triggered from the web app's admin screen.
func (s *Server) handleGC(w http.ResponseWriter, r *http.Request) {
	authz := r.Header.Get("Authorization")
	token, ok := strings.CutPrefix(authz, "Bearer ")
	if s.cfg.WebhookSecret == "" || !ok ||
		subtle.ConstantTimeCompare([]byte(token), []byte(s.cfg.WebhookSecret)) != 1 {
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
	res.SweptUploads = s.staging.Sweep(s.cfg.UploadSessionTTL)
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
