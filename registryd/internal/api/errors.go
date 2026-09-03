package api

import (
	"encoding/json"
	"log/slog"
	"net/http"

	"registryd/internal/store"
)

// OCI distribution error codes, per the distribution spec.
const (
	CodeBlobUnknown         = "BLOB_UNKNOWN"
	CodeBlobUploadInvalid   = "BLOB_UPLOAD_INVALID"
	CodeBlobUploadUnknown   = "BLOB_UPLOAD_UNKNOWN"
	CodeDigestInvalid       = "DIGEST_INVALID"
	CodeManifestBlobUnknown = "MANIFEST_BLOB_UNKNOWN"
	CodeManifestInvalid     = "MANIFEST_INVALID"
	CodeManifestUnknown     = "MANIFEST_UNKNOWN"
	CodeNameInvalid         = "NAME_INVALID"
	CodeNameUnknown         = "NAME_UNKNOWN"
	CodeSizeInvalid         = "SIZE_INVALID"
	CodeUnauthorized        = "UNAUTHORIZED"
	CodeDenied              = "DENIED"
	CodeUnsupported         = "UNSUPPORTED"
	CodeTooManyRequests     = "TOOMANYREQUESTS"
	CodeRangeInvalid        = "RANGE_INVALID"
	CodeTagInvalid          = "TAG_INVALID"
	CodeInternal            = "INTERNAL_ERROR"
)

type ociError struct {
	Code    string `json:"code"`
	Message string `json:"message"`
	Detail  any    `json:"detail,omitempty"`
}

type ociErrors struct {
	Errors []ociError `json:"errors"`
}

// writeError emits a spec-compliant error body with the given HTTP status.
func writeError(w http.ResponseWriter, status int, code, message string) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(ociErrors{Errors: []ociError{{Code: code, Message: message}}})
}

// writeStoreError maps quota violations and tag-rule violations (immutable
// or protected tags) to 403 DENIED with the reason and everything else to an
// opaque 500.
func writeStoreError(w http.ResponseWriter, r *http.Request, err error) {
	if store.IsQuotaError(err) || store.IsPolicyError(err) {
		writeError(w, http.StatusForbidden, CodeDenied, err.Error())
		return
	}
	writeInternal(w, r, err)
}

// writeInternal logs the underlying error and returns an opaque 500.
func writeInternal(w http.ResponseWriter, r *http.Request, err error) {
	slog.Error("internal error", "method", r.Method, "path", r.URL.Path, "err", err)
	writeError(w, http.StatusInternalServerError, CodeInternal, "internal server error")
}
