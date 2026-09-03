package api

import (
	"errors"
	"fmt"
	"net/http"
	"strconv"

	"registryd/internal/storage"
	"registryd/internal/store"
	"registryd/internal/traffic"
)

// handleBlobGet serves GET/HEAD /v2/<name>/blobs/<digest>. Access control is
// enforced by the repo link: a blob is only served through repositories it
// belongs to, so shared (deduplicated) content never leaks across ACLs.
func (s *Server) handleBlobGet(w http.ResponseWriter, r *http.Request, rc *reqCtx, digest string) {
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
	size, err := s.store.LinkedBlobSize(r.Context(), repo.ID, digest)
	if errors.Is(err, store.ErrNotFound) {
		// Proxy-cache miss: fetch the layer from the upstream (see proxy.go).
		if px := s.proxyFor(r.Context(), rc.org); px != nil {
			if !s.ensureProxiedBlob(w, r, rc, px, repo, digest) {
				return
			}
			size, err = s.store.LinkedBlobSize(r.Context(), repo.ID, digest)
		}
	}
	if errors.Is(err, store.ErrNotFound) {
		writeError(w, http.StatusNotFound, CodeBlobUnknown, "blob unknown to repository")
		return
	} else if err != nil {
		writeInternal(w, r, err)
		return
	}

	w.Header().Set("Docker-Content-Digest", digest)
	w.Header().Set("Content-Type", "application/octet-stream")
	w.Header().Set("Accept-Ranges", "bytes")

	if r.Method == http.MethodHead {
		w.Header().Set("Content-Length", strconv.FormatInt(size, 10))
		w.WriteHeader(http.StatusOK)
		return
	}

	// Offload large transfers to the backend when it supports signed URLs.
	// The client repeats its Range header against that URL, which S3 and
	// the bunny CDN honour; the whole blob is accounted as redirected once.
	if url, err := s.driver.RedirectURL(r.Context(), digest); err == nil && url != "" {
		http.Redirect(w, r, url, http.StatusTemporaryRedirect)
		s.countTraffic(repo.ID, traffic.Delta{RedirectBytes: size, BlobPulls: 1})
		return
	}

	// Full body or a single byte range (206), see ranges.go.
	written, status, err := writeBlobContent(w, r, s.driver, digest, size)
	if errors.Is(err, storage.ErrNotFound) {
		writeError(w, http.StatusNotFound, CodeBlobUnknown, "blob content missing from storage")
		return
	} else if err != nil {
		writeInternal(w, r, err)
		return
	}
	if status == http.StatusOK || status == http.StatusPartialContent {
		s.countTraffic(repo.ID, traffic.Delta{PullBytes: written, BlobPulls: 1})
	}
}

// handleBlobDelete unlinks the blob from the repository; the content itself
// is removed once no repository references it anymore.
func (s *Server) handleBlobDelete(w http.ResponseWriter, r *http.Request, rc *reqCtx, digest string) {
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
	// Never pull a layer out from under manifests that still use it — layers
	// are shared; deleting the manifests (then GC) is the supported path.
	if refs, err := s.store.BlobManifestRefs(r.Context(), repo.ID, digest); err != nil {
		writeInternal(w, r, err)
		return
	} else if refs > 0 {
		writeError(w, http.StatusConflict, CodeDenied,
			fmt.Sprintf("blob is still referenced by %d manifest(s) in this repository; delete those first", refs))
		return
	}
	remaining, err := s.store.UnlinkBlob(r.Context(), repo.ID, digest)
	if errors.Is(err, store.ErrNotFound) {
		writeError(w, http.StatusNotFound, CodeBlobUnknown, "blob unknown to repository")
		return
	} else if err != nil {
		writeInternal(w, r, err)
		return
	}
	if remaining == 0 {
		if err := s.driver.Delete(r.Context(), digest); err != nil {
			writeInternal(w, r, err)
			return
		}
	}
	s.recordEvent(&store.Event{
		RepositoryID: repo.ID, Type: "delete",
		ActorType: rc.identity.ActorType(), ActorID: rc.identity.ActorID(),
		ManifestDigest: digest,
	})
	w.WriteHeader(http.StatusAccepted)
}
