package api

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"strconv"
	"strings"
	"time"

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
	if err := s.staging.Create(r.Context(), id, rc.org, rc.repo); err != nil {
		writeInternal(w, r, err)
		return
	}

	if digest := q.Get("digest"); digest != "" {
		// Monolithic: the entire blob is the request body, staged as one chunk.
		if _, err := s.staging.Append(r.Context(), id, 0, http.MaxBytesReader(w, r.Body, maxBlobBytes)); err != nil {
			s.discardUpload(id)
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

// checkSession loads the upload session and verifies it belongs to the
// repository in the URL. Returns nil after writing the error response.
func (s *Server) checkSession(w http.ResponseWriter, r *http.Request, rc *reqCtx, id string) *storage.UploadSession {
	sess, err := s.staging.Get(r.Context(), id)
	if errors.Is(err, storage.ErrUploadNotFound) {
		writeError(w, http.StatusNotFound, CodeBlobUploadUnknown, "upload session not found")
		return nil
	} else if err != nil {
		writeInternal(w, r, err)
		return nil
	}
	if sess.Org != rc.org || sess.Repo != rc.repo {
		writeError(w, http.StatusNotFound, CodeBlobUploadUnknown, "upload session belongs to a different repository")
		return nil
	}
	return sess
}

// discardUpload drops a session and its staged content once the request is
// done with it. It runs on its own context so a client that hung up still
// gets cleaned up; anything it misses is swept by GC.
func (s *Server) discardUpload(id string) {
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	if err := s.staging.Remove(ctx, id); err != nil {
		slog.Warn("upload: discard session failed (gc will retry)", "id", id, "err", err)
	}
}

// appendChunk stages a request body at the session's current offset and
// answers the range errors the spec defines when it does not fit; it returns
// the new offset and false once a response has been written.
func (s *Server) appendChunk(w http.ResponseWriter, r *http.Request, rc *reqCtx, id string, expected int64) (int64, bool) {
	size, err := s.staging.Append(r.Context(), id, expected, http.MaxBytesReader(w, r.Body, maxBlobBytes))
	switch {
	case errors.Is(err, storage.ErrUploadNotFound):
		writeError(w, http.StatusNotFound, CodeBlobUploadUnknown, "upload session not found")
		return 0, false
	case errors.Is(err, storage.ErrOffsetMismatch):
		// Another request appended first (two replicas, or a retried
		// chunk): report where the upload stands so the client resumes.
		setUploadHeaders(w, rc.name, id, size)
		writeError(w, http.StatusRequestedRangeNotSatisfiable, CodeRangeInvalid,
			fmt.Sprintf("upload advanced concurrently; resume from offset %d", size))
		return 0, false
	case err != nil:
		writeInternal(w, r, err)
		return 0, false
	}
	return size, true
}

// handleUploadPatch appends a chunk. Content-Range, when present, must line
// up with the bytes staged so far.
func (s *Server) handleUploadPatch(w http.ResponseWriter, r *http.Request, rc *reqCtx, id string) {
	sess := s.checkSession(w, r, rc, id)
	if sess == nil {
		return
	}
	if cr := r.Header.Get("Content-Range"); cr != "" {
		start, _, ok := parseContentRange(cr)
		if !ok {
			writeError(w, http.StatusBadRequest, CodeRangeInvalid, "malformed Content-Range")
			return
		}
		if start != sess.Offset {
			setUploadHeaders(w, rc.name, id, sess.Offset)
			writeError(w, http.StatusRequestedRangeNotSatisfiable, CodeRangeInvalid,
				fmt.Sprintf("chunk start %d does not match staged size %d", start, sess.Offset))
			return
		}
	}
	size, ok := s.appendChunk(w, r, rc, id, sess.Offset)
	if !ok {
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
	sess := s.checkSession(w, r, rc, id)
	if sess == nil {
		return
	}
	// A PUT without a body (the common docker/containerd shape) stages no
	// empty chunk; one with a body appends it like a final PATCH.
	if r.ContentLength != 0 {
		if _, ok := s.appendChunk(w, r, rc, id, sess.Offset); !ok {
			return
		}
	}
	s.commitUpload(w, r, rc, id, r.URL.Query().Get("digest"))
}

// commitUpload verifies the staged content against the client's digest and
// stores it. The bytes are hashed while they stream into the driver (one
// pass, whichever staging mode is in use); the driver publishes the blob
// only once the reader has finished cleanly, so a mismatch never leaves
// content behind. When the blob already exists the content is still hashed:
// a wrong digest must never link content the client did not send.
func (s *Server) commitUpload(w http.ResponseWriter, r *http.Request, rc *reqCtx, id, expected string) {
	expected = strings.ToLower(strings.TrimSpace(expected))
	if !strings.HasPrefix(expected, "sha256:") || !isDigest(expected) {
		writeError(w, http.StatusBadRequest, CodeDigestInvalid, "a sha256 digest query parameter is required")
		return
	}
	ctx := r.Context()
	sess, err := s.staging.Get(ctx, id)
	if errors.Is(err, storage.ErrUploadNotFound) {
		writeError(w, http.StatusNotFound, CodeBlobUploadUnknown, "upload session not found")
		return
	} else if err != nil {
		writeInternal(w, r, err)
		return
	}
	size := sess.Offset

	_, err = s.driver.Stat(ctx, expected)
	exists := err == nil
	if err != nil && !errors.Is(err, storage.ErrNotFound) {
		writeInternal(w, r, err)
		return
	}
	if exists {
		actual, n, err := storage.StagedDigest(ctx, s.staging, id)
		if err != nil {
			writeInternal(w, r, err)
			return
		}
		if actual != expected || n != size {
			s.discardUpload(id)
			writeError(w, http.StatusBadRequest, CodeDigestInvalid,
				fmt.Sprintf("digest mismatch: client sent %s, content is %s", expected, actual))
			return
		}
	}

	// Resolve (or, on first push, create) the repository — but only after every
	// quota check passes, so a denied push leaves nothing behind.
	repo, err := s.resolveRepoForWrite(w, r, rc, expected, size)
	if err != nil {
		s.discardUpload(id)
		return
	}

	if !exists {
		content, _, err := s.staging.Open(ctx, id)
		if err != nil {
			writeInternal(w, r, err)
			return
		}
		verifier := storage.NewVerifyingReader(content, expected)
		err = s.driver.Put(ctx, expected, verifier, size)
		content.Close()
		if errors.Is(err, storage.ErrDigestMismatch) {
			s.discardUpload(id)
			writeError(w, http.StatusBadRequest, CodeDigestInvalid, err.Error())
			return
		} else if err != nil {
			writeInternal(w, r, err)
			return
		}
	}

	if err := s.store.UpsertBlob(ctx, repo.ID, expected, size, ""); err != nil {
		writeInternal(w, r, err)
		return
	}
	s.discardUpload(id)
	// Ingress is counted once per successful upload: the bytes the client
	// sent across every PATCH/PUT of this session (mounts send nothing).
	s.countTraffic(repo.ID, traffic.Delta{PushBytes: size})

	w.Header().Set("Location", blobLocation(rc.name, expected))
	w.Header().Set("Docker-Content-Digest", expected)
	w.Header().Set("Content-Length", "0")
	w.WriteHeader(http.StatusCreated)
}

// handleUploadStatus reports staged progress for resumable uploads.
func (s *Server) handleUploadStatus(w http.ResponseWriter, r *http.Request, rc *reqCtx, id string) {
	sess := s.checkSession(w, r, rc, id)
	if sess == nil {
		return
	}
	setUploadHeaders(w, rc.name, id, sess.Offset)
	w.WriteHeader(http.StatusNoContent)
}

// handleUploadCancel aborts an upload session.
func (s *Server) handleUploadCancel(w http.ResponseWriter, r *http.Request, rc *reqCtx, id string) {
	if s.checkSession(w, r, rc, id) == nil {
		return
	}
	if err := s.staging.Remove(r.Context(), id); err != nil {
		writeInternal(w, r, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// resolveRepoForWrite returns the target repository for a blob write,
// enforcing repository-count and storage quotas first. When it returns an
// error the response has already been written.
var errRepositoryMoved = errors.New("repository moved")

func (s *Server) resolveRepoForWrite(w http.ResponseWriter, r *http.Request, rc *reqCtx, digest string, size int64) (*store.Repository, error) {
	repo, err := s.repoLookup.GetRepository(r.Context(), rc.org, rc.repo)
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
		// A former name of a renamed or transferred repository is never
		// re-created by a push: the old reference is read-only.
		if s.writeMovedIfRedirected(w, r, rc) {
			return nil, errRepositoryMoved
		}
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
