package api

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strconv"

	"registryd/internal/hooks"
	"registryd/internal/manifest"
	"registryd/internal/store"
	"registryd/internal/traffic"
)

// maxManifestBytes caps manifest payloads (the spec recommends 4 MiB).
const maxManifestBytes = 4 << 20

// resolveManifestRef turns a tag-or-digest reference into a digest.
func (s *Server) resolveManifestRef(r *http.Request, repoID, ref string) (string, error) {
	if isDigest(ref) {
		return ref, nil
	}
	if !tagRe.MatchString(ref) {
		return "", errTagInvalid
	}
	return s.store.ResolveTag(r.Context(), repoID, ref)
}

var errTagInvalid = errors.New("invalid tag")

// handleManifestGet serves GET/HEAD /v2/<name>/manifests/<ref>.
func (s *Server) handleManifestGet(w http.ResponseWriter, r *http.Request, rc *reqCtx, ref string) {
	// Manifest requests are what counts as a pull, so this is where the pull
	// rate limit applies (before any database work; see ratelimit.go).
	if !s.enforcePullLimit(w, r, rc) {
		return
	}
	// Proxy-cache organizations fill the local copy from the upstream first
	// (see proxy.go); everything below then serves it like any other image.
	px := s.proxyFor(r.Context(), rc.org)
	if px != nil && !s.ensureProxiedManifest(w, r, rc, px, ref) {
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

	digest, err := s.resolveManifestRef(r, repo.ID, ref)
	if errors.Is(err, errTagInvalid) {
		writeError(w, http.StatusBadRequest, CodeTagInvalid, "invalid tag name")
		return
	} else if errors.Is(err, store.ErrNotFound) {
		writeError(w, http.StatusNotFound, CodeManifestUnknown, "manifest unknown")
		return
	} else if err != nil {
		writeInternal(w, r, err)
		return
	}

	m, err := s.store.GetManifest(r.Context(), repo.ID, digest)
	if errors.Is(err, store.ErrNotFound) {
		writeError(w, http.StatusNotFound, CodeManifestUnknown, "manifest unknown")
		return
	} else if err != nil {
		writeInternal(w, r, err)
		return
	}

	// The web app derives manifest_blocks from scan results and the pull
	// policy; its own service reads (config caching, moving tags) bypass it.
	if rc.identity.Subject != "user:system" {
		reason, blocked, err := s.store.ManifestBlock(r.Context(), repo.ID, digest)
		if err != nil {
			writeInternal(w, r, err)
			return
		}
		if blocked {
			writeError(w, http.StatusForbidden, CodeDenied, "pull blocked by vulnerability policy: "+reason)
			return
		}
	}

	w.Header().Set("Content-Type", m.MediaType)
	w.Header().Set("Docker-Content-Digest", m.Digest)
	w.Header().Set("Content-Length", strconv.FormatInt(m.Size, 10))
	w.WriteHeader(http.StatusOK)
	var written int
	if r.Method != http.MethodHead {
		written, _ = w.Write(m.Payload)
	}
	s.countTraffic(repo.ID, traffic.Delta{PullBytes: int64(written), ManifestPulls: 1})

	// A pull is any manifest request, GET or HEAD — clients with warm caches
	// only HEAD to revalidate, and that still counts as image usage (the same
	// semantics Docker Hub uses).
	repoID := repo.ID
	s.recordEvent(&store.Event{
		RepositoryID: repoID, Type: "pull",
		ActorType: rc.identity.ActorType(), ActorID: rc.identity.ActorID(),
		ManifestDigest: digest, Tag: tagOrEmpty(ref),
	})
	go func() {
		ctx, cancel := contextWithTimeout()
		defer cancel()
		_ = s.store.IncrementPullCount(ctx, repoID)
	}()
	if px != nil && !isDigest(ref) {
		s.noteProxyPull(repoID, ref)
	}
}

func tagOrEmpty(ref string) string {
	if isDigest(ref) {
		return ""
	}
	return ref
}

// handleManifestPut stores a manifest after validating that every referenced
// blob or child manifest is already present in the repository.
func (s *Server) handleManifestPut(w http.ResponseWriter, r *http.Request, rc *reqCtx, ref string) {
	payload, err := io.ReadAll(http.MaxBytesReader(w, r.Body, maxManifestBytes))
	if err != nil {
		writeError(w, http.StatusBadRequest, CodeManifestInvalid, "manifest too large or unreadable")
		return
	}
	sum := sha256.Sum256(payload)
	digest := "sha256:" + hex.EncodeToString(sum[:])

	isTag := !isDigest(ref)
	if isTag && !tagRe.MatchString(ref) {
		writeError(w, http.StatusBadRequest, CodeTagInvalid, "invalid tag name")
		return
	}
	if !isTag && ref != digest {
		writeError(w, http.StatusBadRequest, CodeDigestInvalid,
			fmt.Sprintf("provided digest %s does not match content digest %s", ref, digest))
		return
	}

	parsed, err := manifest.Parse(r.Header.Get("Content-Type"), payload)
	if err != nil {
		writeError(w, http.StatusBadRequest, CodeManifestInvalid, err.Error())
		return
	}

	// Blobs must already be in the repository, so it exists by now; a manifest
	// alone (no layers) can still create it — apply the same rules as blobs.
	repo, err := s.resolveRepoForWrite(w, r, rc, digest, 0)
	if err != nil {
		return
	}

	// Immutable tags (tag_rules) may not be re-pointed; refuse before
	// anything is written. UpsertTagGuarded repeats the check under a row
	// lock so concurrent pushes cannot race past it.
	if isTag {
		if err := s.store.CheckTagImmutable(r.Context(), repo, ref, digest); err != nil {
			writeStoreError(w, r, err)
			return
		}
	}

	// Existence checks for everything the manifest references.
	if parsed.Config != nil {
		if _, err := s.store.LinkedBlobSize(r.Context(), repo.ID, parsed.Config.Digest); err != nil {
			writeError(w, http.StatusBadRequest, CodeManifestBlobUnknown,
				fmt.Sprintf("config blob %s not found in repository", parsed.Config.Digest))
			return
		}
	}
	for _, l := range parsed.Layers {
		if manifest.IsForeignLayer(l.MediaType) {
			continue
		}
		if _, err := s.store.LinkedBlobSize(r.Context(), repo.ID, l.Digest); err != nil {
			writeError(w, http.StatusBadRequest, CodeManifestBlobUnknown,
				fmt.Sprintf("layer blob %s not found in repository", l.Digest))
			return
		}
	}
	for _, c := range parsed.Children {
		ok, err := s.store.ManifestExists(r.Context(), repo.ID, c.Digest)
		if err != nil {
			writeInternal(w, r, err)
			return
		}
		if !ok {
			writeError(w, http.StatusBadRequest, CodeManifestBlobUnknown,
				fmt.Sprintf("child manifest %s not found in repository", c.Digest))
			return
		}
	}

	row := &store.Manifest{
		RepositoryID: repo.ID,
		Digest:       digest,
		MediaType:    parsed.MediaType,
		ArtifactType: parsed.ArtifactType,
		Size:         int64(len(payload)),
		Payload:      payload,
		PushedBy:     rc.identity.Subject,
	}
	if parsed.Config != nil {
		row.ConfigDigest = parsed.Config.Digest
	}
	if parsed.Subject != nil {
		row.SubjectDigest = parsed.Subject.Digest
	}
	if err := s.store.UpsertManifest(r.Context(), row, parsed.References()); err != nil {
		writeInternal(w, r, err)
		return
	}

	tag := ""
	if isTag {
		tag = ref
		if err := s.store.UpsertTagGuarded(r.Context(), repo, tag, digest); err != nil {
			writeStoreError(w, r, err)
			return
		}
	}
	_ = s.store.TouchRepository(r.Context(), repo.ID)
	s.countTraffic(repo.ID, traffic.Delta{PushBytes: int64(len(payload))})
	s.recordEvent(&store.Event{
		RepositoryID: repo.ID, Type: "push",
		ActorType: rc.identity.ActorType(), ActorID: rc.identity.ActorID(),
		ManifestDigest: digest, Tag: tag,
	})
	s.notifier.Notify(hooks.Event{
		Type: "manifest.push", Repository: rc.name, Digest: digest, Tag: tag,
		MediaType: parsed.MediaType, Actor: rc.identity.Subject,
	})

	w.Header().Set("Location", "/v2/"+rc.name+"/manifests/"+digest)
	w.Header().Set("Docker-Content-Digest", digest)
	if parsed.Subject != nil {
		w.Header().Set("OCI-Subject", parsed.Subject.Digest)
	}
	w.WriteHeader(http.StatusCreated)
}

// handleManifestDelete removes a tag (when ref is a tag) or the manifest
// itself (when ref is a digest).
func (s *Server) handleManifestDelete(w http.ResponseWriter, r *http.Request, rc *reqCtx, ref string) {
	repo, err := s.store.GetRepository(r.Context(), rc.org, rc.repo)
	if errors.Is(err, store.ErrNotFound) {
		writeError(w, http.StatusNotFound, CodeNameUnknown, "repository not found")
		return
	} else if err != nil {
		writeInternal(w, r, err)
		return
	}

	if !isDigest(ref) {
		if !tagRe.MatchString(ref) {
			writeError(w, http.StatusBadRequest, CodeTagInvalid, "invalid tag name")
			return
		}
		// Protected tags (tag_rules) cannot be removed.
		if err := s.store.CheckTagDeletable(r.Context(), repo, ref); err != nil {
			writeStoreError(w, r, err)
			return
		}
		// Resolve the digest first so the web app learns which image the tag
		// named (the row is gone after the delete).
		digest, _ := s.store.ResolveTag(r.Context(), repo.ID, ref)
		err := s.store.DeleteTag(r.Context(), repo.ID, ref)
		if errors.Is(err, store.ErrNotFound) {
			writeError(w, http.StatusNotFound, CodeManifestUnknown, "tag unknown")
			return
		} else if err != nil {
			writeInternal(w, r, err)
			return
		}
		s.recordEvent(&store.Event{
			RepositoryID: repo.ID, Type: "delete",
			ActorType: rc.identity.ActorType(), ActorID: rc.identity.ActorID(), Tag: ref,
		})
		s.notifier.Notify(hooks.Event{
			Type: "manifest.delete", Repository: rc.name, Digest: digest, Tag: ref, Actor: rc.identity.Subject,
		})
		w.WriteHeader(http.StatusAccepted)
		return
	}

	// A manifest named by a protected tag cannot be removed by digest either
	// (the tag rows would cascade away with it).
	if err := s.store.CheckManifestDeletable(r.Context(), repo, ref); err != nil {
		writeStoreError(w, r, err)
		return
	}
	// Tags are removed by cascade; collect them before the delete for the event.
	tagNames, _ := s.store.TagsForManifest(r.Context(), repo.ID, ref)
	err = s.store.DeleteManifest(r.Context(), repo.ID, ref)
	if errors.Is(err, store.ErrNotFound) {
		writeError(w, http.StatusNotFound, CodeManifestUnknown, "manifest unknown")
		return
	} else if err != nil {
		writeInternal(w, r, err)
		return
	}
	s.recordEvent(&store.Event{
		RepositoryID: repo.ID, Type: "delete",
		ActorType: rc.identity.ActorType(), ActorID: rc.identity.ActorID(), ManifestDigest: ref,
	})
	s.notifier.Notify(hooks.Event{
		Type: "manifest.delete", Repository: rc.name, Digest: ref, Tags: tagNames, Actor: rc.identity.Subject,
	})
	w.WriteHeader(http.StatusAccepted)
}
