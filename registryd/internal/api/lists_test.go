package api

import (
	"encoding/json"
	"testing"

	"registryd/internal/store"
)

func TestReferrerDescriptorsCarryAnnotations(t *testing.T) {
	refs := []store.Referrer{
		{
			Digest: "sha256:aaa", MediaType: "application/vnd.oci.image.manifest.v1+json", Size: 878,
			ArtifactType: "application/vnd.dev.sigstore.bundle.v0.3+json",
			Annotations: map[string]string{
				"dev.sigstore.bundle.content":       "dsse-envelope",
				"dev.sigstore.bundle.predicateType": "https://sigstore.dev/cosign/sign/v1",
			},
		},
		{Digest: "sha256:bbb", MediaType: "application/vnd.oci.image.manifest.v1+json", Size: 10},
	}
	out := referrerDescriptors(refs)
	if len(out) != 2 {
		t.Fatalf("got %d descriptors, want 2", len(out))
	}
	if out[0].Annotations["dev.sigstore.bundle.content"] != "dsse-envelope" {
		t.Errorf("annotations not carried: %v", out[0].Annotations)
	}
	if out[0].ArtifactType != refs[0].ArtifactType {
		t.Errorf("artifactType = %q", out[0].ArtifactType)
	}
	// Referrers without annotations must serialize without an annotations key.
	b, err := json.Marshal(out[1])
	if err != nil {
		t.Fatal(err)
	}
	if string(b) != `{"mediaType":"application/vnd.oci.image.manifest.v1+json","digest":"sha256:bbb","size":10}` {
		t.Errorf("unexpected descriptor JSON: %s", b)
	}
}

func TestParseAnnotations(t *testing.T) {
	if got := store.ParseAnnotations(nil); got != nil {
		t.Errorf("nil input → %v", got)
	}
	if got := store.ParseAnnotations([]byte(`null`)); got != nil {
		t.Errorf("null → %v", got)
	}
	if got := store.ParseAnnotations([]byte(`{"a":1}`)); got != nil {
		t.Errorf("non-string values should be ignored, got %v", got)
	}
	got := store.ParseAnnotations([]byte(`{"org.opencontainers.image.created":"2026-09-03T20:22:33Z"}`))
	if got["org.opencontainers.image.created"] != "2026-09-03T20:22:33Z" {
		t.Errorf("got %v", got)
	}
}
