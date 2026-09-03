package api

import (
	"errors"
	"fmt"
	"net/http"
	"strconv"
	"strings"

	"github.com/google/uuid"

	"registryd/internal/storage"
	"registryd/internal/store"
	"registryd/internal/traffic"
)

func uploadLocation(name, id string) string {
	return "/v2/" + name + "/blobs/uploads/" + id
}

func blobLocation(name, digest string) string {
	return "/v2/" + name + "/blobs/" + digest
}

func setUploadHeaders(w http.ResponseWriter, name, id string, size int64) {
	w.Header().Set("Location", uploadLocation(name, id))
	w.Header().Set("Docker-Upload-UUID", id)
	end := size - 1
	if end < 0 {
		end = 0
	}
	w.Header().Set("Range", fmt.Sprintf("0-%d", end))
}

// handleUploadStart implements POST /v2/<name>/blobs/uploads/ with three
// modes: cross-repo mount (?mount=&from=), monolithic push (?digest=), and
// session start (no params).
func (s *Server) handleUploadStart(w http.ResponseWriter, r *http.Request, rc *reqCtx) {
	q := r.URL.Query()

	if mount, from := q.Get("mount"), q.Get("from"); mount != "" && from != "" {
		if s.tryMount(w, r, rc, mount, from) {
			return
		}
		// Fall through to a regular session; the client uploads the blob.
	}

	id := uuid.NewString()
	if err := s.staging.Create(id, rc.name); err != nil {
		writeInternal(w, r, err)
		return
	}

	if digest := q.Get("digest"); digest != "" {
		// Monolithic: the entire blob is the request body.
		if _, err := s.staging.Append(id, http.MaxBytesReader(w, r.Body, maxBlobBytes)); err != nil {
			s.staging.Remove(id)
			writeInternal(w, r, err)
			return
		}
		s.commitUpload(w, r, rc, id, digest)
		return
	}

	w.Header().Set("Content-Length", "0")
	setUploadHeaders(w, rc.name, id, 0)
	w.WriteHeader(http.StatusAccepted)
}

// tryMount links an existing blob from another repository the caller can pull
// from. Returns true when the mount succeeded (response written).
func (s *Server) tryMount(w http.ResponseWriter, r *http.Request, rc *reqCtx, digest, from string) bool {
	if !isDigest(digest) || !nameRe.MatchString(from) || strings.Count(from, "/") != 1 {
		return false
	}
	if !s.verifier.Disabled() && !rc.identity.Can("repository", from, "pull") {
		return false
	}
	fromRepo, err := s.store.GetRepository(r.Context(), strings.Split(from, "/")[0], strings.Split(from, "/")[1])
	if err != nil {
		return false
	}
	size, err := s.store.LinkedBlobSize(r.Context(), fromRepo.ID, digest)
	if err != nil {
		return false
	}
	repo, err := s.resolveRepoForWrite(w, r, rc, digest, size)
	if err != nil {
		// Quota / unknown-org responses are already written; the client must
		// not fall back to a regular upload that would fail the same way.
		return true
	}
	if err := s.store.LinkBlob(r.Context(), repo.ID, digest); err != nil {
		return false
	}
	w.Header().Set("Location", blobLocation(rc.name, digest))
	w.Header().Set("Docker-Content-Digest", digest)
	w.Header().Set("Content-Length", "0")
	w.WriteHeader(http.StatusCreated)
	return true
}

// maxBlobBytes caps a single upload request body (100 GiB — effectively
// unbounded, but protects against runaway streams).
const maxBlobBytes = 100 << 30

// checkSession verifies the upload belongs to the repository in the URL.
func (s *Server) checkSession(w http.ResponseWriter, r *http.Request, rc *reqCtx, id string) bool {
	repo, err := s.staging.Repository(id)
	if errors.Is(err, storage.ErrUploadNotFound) {
		writeError(w, http.StatusNotFound, CodeBlobUploadUnknown, "upload session not found")
		return false
	} else if err != nil {
		writeInternal(w, r, err)
		return false
	}
	if repo != rc.name {
		writeError(w, http.StatusNotFound, CodeBlobUploadUnknown, "upload session belongs to a different repository")
		return false
	}
	return true
}

// handleUploadPatch appends a chunk. Content-Range, when present, must line
// up with the bytes staged so far.
func (s *Server) handleUploadPatch(w http.ResponseWriter, r *http.Request, rc *reqCtx, id string) {
	if !s.checkSession(w, r, rc, id) {
		return
	}
	if cr := r.Header.Get("Content-Range"); cr != "" {
		start, _, ok := parseContentRange(cr)
		if !ok {
			writeError(w, http.StatusBadRequest, CodeRangeInvalid, "malformed Content-Range")
			return
		}
		current, err := s.staging.Size(id)
		if err != nil {
			writeInternal(w, r, err)
			return
		}
		if start != current {
			setUploadHeaders(w, rc.name, id, current)
			writeError(w, http.StatusRequestedRangeNotSatisfiable, CodeRangeInvalid,
				fmt.Sprintf("chunk start %d does not match staged size %d", start, current))
			return
		}
	}
	size, err := s.staging.Append(id, http.MaxBytesReader(w, r.Body, maxBlobBytes))
	if errors.Is(err, storage.ErrUploadNotFound) {
		writeError(w, http.StatusNotFound, CodeBlobUploadUnknown, "upload session not found")
		return
	} else if err != nil {
		writeInternal(w, r, err)
		return
	}
	w.Header().Set("Content-Length", "0")
	setUploadHeaders(w, rc.name, id, size)
	w.WriteHeader(http.StatusAccepted)
}

// parseContentRange accepts "start-end" (registry convention, no unit).
func parseContentRange(v string) (start, end int64, ok bool) {
	v = strings.TrimPrefix(strings.TrimSpace(v), "bytes ")
	if i := strings.IndexByte(v, '/'); i >= 0 {
		v = v[:i]
	}
	a, b, found := strings.Cut(v, "-")
	if !found {
		return 0, 0, false
	}
	var err error
	if start, err = strconv.ParseInt(a, 10, 64); err != nil {
		return 0, 0, false
	}
	if end, err = strconv.ParseInt(b, 10, 64); err != nil {
		return 0, 0, false
	}
	return start, end, start >= 0 && end >= start-1
}

// handleUploadCommit implements PUT ...?digest=<d>: append any final body,
// verify the digest, and hand the content to the storage driver.
func (s *Server) handleUploadCommit(w http.ResponseWriter, r *http.Request, rc *reqCtx, id string) {
	if !s.checkSession(w, r, rc, id) {
		return
	}
	if _, err := s.staging.Append(id, http.MaxBytesReader(w, r.Body, maxBlobBytes)); err != nil {
		writeInternal(w, r, err)
		return
	}
	s.commitUpload(w, r, rc, id, r.URL.Query().Get("digest"))
}

func (s *Server) commitUpload(w http.ResponseWriter, r *http.Request, rc *reqCtx, id, expected string) {
	expected = strings.ToLower(strings.TrimSpace(expected))
	if !strings.HasPrefix(expected, "sha256:") || !isDigest(expected) {
		writeError(w, http.StatusBadRequest, CodeDigestInvalid, "a sha256 digest query parameter is required")
		return
	}
	actual, size, err := s.staging.Digest(id)
	if err != nil {
		writeInternal(w, r, err)
		return
	}
	if actual != expected {
		s.staging.Remove(id)
		writeError(w, http.StatusBadRequest, CodeDigestInvalid,
			fmt.Sprintf("digest mismatch: client sent %s, content is %s", expected, actual))
		return
	}

	// Resolve (or, on first push, create) the repository — but only after every
	// quota check passes, so a denied push leaves nothing behind.
	repo, err := s.resolveRepoForWrite(w, r, rc, actual, size)
	if err != nil {
		s.staging.Remove(id)
		return
	}

	// Skip the backend write when the content already exists (dedup).
	if _, err := s.driver.Stat(r.Context(), actual); errors.Is(err, storage.ErrNotFound) {
		content, err := s.staging.Open(id)
		if err != nil {
			writeInternal(w, r, err)
			return
		}
		err = s.driver.Put(r.Context(), actual, content, size)
		content.Close()
		if err != nil {
			writeInternal(w, r, err)
			return
		}
	} else if err != nil {
		writeInternal(w, r, err)
		return
	}

	if err := s.store.UpsertBlob(r.Context(), repo.ID, actual, size, ""); err != nil {
		writeInternal(w, r, err)
		return
	}
	s.staging.Remove(id)
	// Ingress is counted once per successful upload: the bytes the client
	// sent across every PATCH/PUT of this session (mounts send nothing).
	s.countTraffic(repo.ID, traffic.Delta{PushBytes: size})

	w.Header().Set("Location", blobLocation(rc.name, actual))
	w.Header().Set("Docker-Content-Digest", actual)
	w.Header().Set("Content-Length", "0")
	w.WriteHeader(http.StatusCreated)
}

// handleUploadStatus reports staged progress for resumable uploads.
func (s *Server) handleUploadStatus(w http.ResponseWriter, r *http.Request, rc *reqCtx, id string) {
	if !s.checkSession(w, r, rc, id) {
		return
	}
	size, err := s.staging.Size(id)
	if err != nil {
		writeInternal(w, r, err)
		return
	}
	setUploadHeaders(w, rc.name, id, size)
	w.WriteHeader(http.StatusNoContent)
}

// handleUploadCancel aborts an upload session.
func (s *Server) handleUploadCancel(w http.ResponseWriter, r *http.Request, rc *reqCtx, id string) {
	if !s.checkSession(w, r, rc, id) {
		return
	}
	s.staging.Remove(id)
	w.WriteHeader(http.StatusNoContent)
}

// resolveRepoForWrite returns the target repository for a blob write,
// enforcing repository-count and storage quotas first. When it returns an
// error the response has already been written.
func (s *Server) resolveRepoForWrite(w http.ResponseWriter, r *http.Request, rc *reqCtx, digest string, size int64) (*store.Repository, error) {
	repo, err := s.store.GetRepository(r.Context(), rc.org, rc.repo)
	switch {
	case err == nil:
		// Existing repo: only genuinely new content counts against storage.
		has, err := s.store.OrgHasBlob(r.Context(), repo.OrgID, digest)
		if err != nil {
			writeInternal(w, r, err)
			return nil, err
		}
		if !has {
			if err := s.store.CheckStorageQuota(r.Context(), repo.OrgID, size); err != nil {
				writeStoreError(w, r, err)
				return nil, err
			}
		}
		return repo, nil
	case errors.Is(err, store.ErrNotFound):
		orgID, err := s.store.OrgIDBySlug(r.Context(), rc.org)
		if errors.Is(err, store.ErrNotFound) {
			writeError(w, http.StatusNotFound, CodeNameUnknown,
				fmt.Sprintf("organization %q does not exist; create it in the web UI first", rc.org))
			return nil, err
		} else if err != nil {
			writeInternal(w, r, err)
			return nil, err
		}
		visibility, err := s.store.DefaultVisibility(r.Context(), orgID, rc.identity.ActorType(), rc.identity.ActorID())
		if err != nil {
			writeInternal(w, r, err)
			return nil, err
		}
		if err := s.store.CheckRepositoryQuota(r.Context(), orgID, visibility); err != nil {
			writeStoreError(w, r, err)
			return nil, err
		}
		if has, err := s.store.OrgHasBlob(r.Context(), orgID, digest); err != nil {
			writeInternal(w, r, err)
			return nil, err
		} else if !has {
			if err := s.store.CheckStorageQuota(r.Context(), orgID, size); err != nil {
				writeStoreError(w, r, err)
				return nil, err
			}
		}
		repo, err = s.store.EnsureRepository(r.Context(), rc.org, rc.repo, visibility)
		if err != nil {
			writeStoreError(w, r, err)
			return nil, err
		}
		return repo, nil
	default:
		writeInternal(w, r, err)
		return nil, err
	}
}
