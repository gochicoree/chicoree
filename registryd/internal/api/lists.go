package api

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strconv"
	"time"

	"registryd/internal/manifest"
	"registryd/internal/store"
)

func contextWithTimeout() (context.Context, context.CancelFunc) {
	return context.WithTimeout(context.Background(), 5*time.Second)
}

// paginationParams parses ?n= and ?last= with a sane default and cap.
func paginationParams(r *http.Request) (n int, last string) {
	n = 100
	if v := r.URL.Query().Get("n"); v != "" {
		if parsed, err := strconv.Atoi(v); err == nil && parsed > 0 && parsed <= 1000 {
			n = parsed
		}
	}
	return n, r.URL.Query().Get("last")
}

// handleTagsList implements GET /v2/<name>/tags/list.
func (s *Server) handleTagsList(w http.ResponseWriter, r *http.Request, rc *reqCtx) {
	repo, err := s.store.GetRepository(r.Context(), rc.org, rc.repo)
	if errors.Is(err, store.ErrNotFound) {
		writeError(w, http.StatusNotFound, CodeNameUnknown, "repository not found")
		return
	} else if err != nil {
		writeInternal(w, r, err)
		return
	}
	n, last := paginationParams(r)
	tags, err := s.store.ListTags(r.Context(), repo.ID, n, last)
	if err != nil {
		writeInternal(w, r, err)
		return
	}
	if len(tags) == n {
		w.Header().Set("Link", fmt.Sprintf(`</v2/%s/tags/list?n=%d&last=%s>; rel="next"`, rc.name, n, tags[len(tags)-1]))
	}
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]any{"name": rc.name, "tags": tags})
}

// handleReferrers implements the OCI referrers API: manifests whose subject
// is the given digest, returned as an image index.
func (s *Server) handleReferrers(w http.ResponseWriter, r *http.Request, rc *reqCtx, digest string) {
	if !isDigest(digest) {
		writeError(w, http.StatusBadRequest, CodeDigestInvalid, "invalid digest")
		return
	}
	repo, err := s.store.GetRepository(r.Context(), rc.org, rc.repo)
	if errors.Is(err, store.ErrNotFound) {
		writeError(w, http.StatusNotFound, CodeNameUnknown, "repository not found")
		return
	} else if err != nil {
		writeInternal(w, r, err)
		return
	}
	filter := r.URL.Query().Get("artifactType")
	refs, err := s.store.ListReferrers(r.Context(), repo.ID, digest, filter)
	if err != nil {
		writeInternal(w, r, err)
		return
	}
	descriptors := make([]manifest.Descriptor, 0, len(refs))
	for _, ref := range refs {
		descriptors = append(descriptors, manifest.Descriptor{
			MediaType:    ref.MediaType,
			Digest:       ref.Digest,
			Size:         ref.Size,
			ArtifactType: ref.ArtifactType,
		})
	}
	if filter != "" {
		w.Header().Set("OCI-Filters-Applied", "artifactType")
	}
	w.Header().Set("Content-Type", manifest.MediaTypeOCIIndex)
	_ = json.NewEncoder(w).Encode(map[string]any{
		"schemaVersion": 2,
		"mediaType":     manifest.MediaTypeOCIIndex,
		"manifests":     descriptors,
	})
}

// handleCatalog implements GET /v2/_catalog, restricted to tokens holding the
// registry:catalog:* grant (admins and the web app itself).
func (s *Server) handleCatalog(w http.ResponseWriter, r *http.Request) {
	identity, err := s.verifier.Identify(r)
	if err != nil || identity == nil {
		s.verifier.Challenge(w, "registry:catalog:*")
		writeError(w, http.StatusUnauthorized, CodeUnauthorized, "authentication required")
		return
	}
	if !s.verifier.Disabled() && !identity.Can("registry", "catalog", "*") {
		writeError(w, http.StatusForbidden, CodeDenied, "catalog access denied")
		return
	}
	n, last := paginationParams(r)
	repos, err := s.store.Catalog(r.Context(), n, last)
	if err != nil {
		writeInternal(w, r, err)
		return
	}
	if len(repos) == n {
		w.Header().Set("Link", fmt.Sprintf(`</v2/_catalog?n=%d&last=%s>; rel="next"`, n, repos[len(repos)-1]))
	}
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]any{"repositories": repos})
}
