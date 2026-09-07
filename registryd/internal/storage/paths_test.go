package storage

import "testing"

func TestDigestFromPath(t *testing.T) {
	const hex = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
	digest := "sha256:" + hex
	if got, ok := DigestFromPath(BlobPath(digest)); !ok || got != digest {
		t.Fatalf("round trip = %q, %v", got, ok)
	}
	for _, bad := range []string{
		"blobs/sha256/01/.put-123456",   // filesystem temp file
		"blobs/sha256/ab/" + hex,        // directory does not match the hex
		"blobs/sha256/01/01ZZ",          // not hex
		"_uploads/session/0-nonce",      // staging chunk
		"blobs/sha256/" + hex,           // missing fan-out directory
		"blobs/sha256/01/" + hex + "/x", // too deep
		"",
	} {
		if got, ok := DigestFromPath(bad); ok {
			t.Errorf("DigestFromPath(%q) = %q, want !ok", bad, got)
		}
	}
}

func TestPrefixedEnvOptions(t *testing.T) {
	t.Setenv("TARGET_S3_BUCKET", "new-bucket")
	t.Setenv("TARGET_STORAGE_S3_REGION", "eu-central-1")
	t.Setenv("S3_BUCKET", "old-bucket")
	o := NewPrefixedEnvOptions("TARGET_", "s3")
	if v, _ := o.Lookup("BUCKET"); v != "new-bucket" {
		t.Fatalf("BUCKET = %q", v)
	}
	if v, _ := o.Lookup("REGION"); v != "eu-central-1" {
		t.Fatalf("REGION = %q", v)
	}
	if _, ok := o.Lookup("ENDPOINT"); ok {
		t.Fatal("ENDPOINT must not resolve")
	}
	layered := LayeredOptions{NewPrefixedEnvOptions("SOURCE_", "s3"), NewEnvOptions("s3")}
	if v, _ := layered.Lookup("BUCKET"); v != "old-bucket" {
		t.Fatalf("layered BUCKET = %q, want the unprefixed fallback", v)
	}
	t.Setenv("SOURCE_S3_BUCKET", "source-bucket")
	if v, _ := layered.Lookup("BUCKET"); v != "source-bucket" {
		t.Fatalf("layered BUCKET = %q, want the prefixed value", v)
	}
}
