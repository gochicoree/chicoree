package storage

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"hash"
	"io"
)

// ErrDigestMismatch is returned by a VerifyingReader whose content did not
// hash to the expected digest. Drivers propagate it out of Put untouched.
var ErrDigestMismatch = errors.New("digest mismatch")

// VerifyingReader hashes everything read through it and, at EOF, compares
// the result with the expected sha256 digest: a mismatch turns the final
// io.EOF into an error wrapping ErrDigestMismatch. Passing one to Driver.Put
// lets a blob be hashed and stored in a single pass while the driver's
// write-then-publish discipline keeps unverified content invisible.
type VerifyingReader struct {
	r        io.Reader
	h        hash.Hash
	expected string
	n        int64
	done     bool
	err      error
}

// NewVerifyingReader wraps r; expected is a "sha256:<hex>" digest.
func NewVerifyingReader(r io.Reader, expected string) *VerifyingReader {
	return &VerifyingReader{r: r, h: sha256.New(), expected: expected}
}

func (v *VerifyingReader) Read(p []byte) (int, error) {
	if v.done {
		return 0, v.err
	}
	n, err := v.r.Read(p)
	if n > 0 {
		v.h.Write(p[:n])
		v.n += int64(n)
	}
	if err == io.EOF {
		v.done = true
		v.err = io.EOF
		if actual := v.Digest(); actual != v.expected {
			v.err = fmt.Errorf("%w: client sent %s, content is %s", ErrDigestMismatch, v.expected, actual)
		}
		return n, v.err
	}
	return n, err
}

// Digest returns the digest of the bytes read so far.
func (v *VerifyingReader) Digest() string {
	return "sha256:" + hex.EncodeToString(v.h.Sum(nil))
}

// Size returns the number of bytes read so far.
func (v *VerifyingReader) Size() int64 { return v.n }

// DigestOf hashes a stream to its end and returns digest and size.
func DigestOf(r io.Reader) (string, int64, error) {
	h := sha256.New()
	n, err := io.Copy(h, r)
	if err != nil {
		return "", 0, err
	}
	return "sha256:" + hex.EncodeToString(h.Sum(nil)), n, nil
}
