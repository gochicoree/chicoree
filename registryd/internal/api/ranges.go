package api

import (
	"fmt"
	"io"
	"net/http"
	"strconv"
	"strings"

	"registryd/internal/storage"
)

// rangeStatus classifies a request's Range header against a blob.
type rangeStatus int

const (
	rangeNone          rangeStatus = iota // absent, ignorable or multi-range: serve the whole blob (200)
	rangeOK                               // one satisfiable range: 206
	rangeUnsatisfiable                    // syntactically fine but outside the blob: 416
)

// parseRange interprets a Range header (RFC 9110 §14) for a blob of size
// bytes. Only a single "bytes=" range is honoured; unknown units, malformed
// specs and multi-range requests are ignored (the response is then a normal
// 200, which the RFC allows). A range that lies entirely past the end — or
// any range on an empty blob — is unsatisfiable.
func parseRange(header string, size int64) (offset, length int64, status rangeStatus) {
	header = strings.TrimSpace(header)
	if header == "" {
		return 0, 0, rangeNone
	}
	unit, spec, ok := strings.Cut(header, "=")
	if !ok || !strings.EqualFold(strings.TrimSpace(unit), "bytes") {
		return 0, 0, rangeNone
	}
	spec = strings.TrimSpace(spec)
	if spec == "" || strings.Contains(spec, ",") {
		return 0, 0, rangeNone
	}
	first, last, ok := strings.Cut(spec, "-")
	if !ok {
		return 0, 0, rangeNone
	}
	first, last = strings.TrimSpace(first), strings.TrimSpace(last)

	if first == "" {
		// suffix-range: the last N bytes
		if last == "" {
			return 0, 0, rangeNone
		}
		n, err := strconv.ParseInt(last, 10, 64)
		if err != nil {
			return 0, 0, rangeNone
		}
		if n <= 0 || size <= 0 {
			return 0, 0, rangeUnsatisfiable
		}
		if n > size {
			n = size
		}
		return size - n, n, rangeOK
	}

	start, err := strconv.ParseInt(first, 10, 64)
	if err != nil || start < 0 {
		return 0, 0, rangeNone
	}
	end := size - 1
	if last != "" {
		end, err = strconv.ParseInt(last, 10, 64)
		if err != nil {
			return 0, 0, rangeNone
		}
		if end < start {
			return 0, 0, rangeNone
		}
		if end > size-1 {
			end = size - 1
		}
	}
	if start >= size {
		return 0, 0, rangeUnsatisfiable
	}
	return start, end - start + 1, rangeOK
}

// writeBlobContent streams a blob to the client, honouring a single-range
// Range header, and reports how many body bytes were written together with
// the status used. Storage errors are returned untouched (the caller maps
// storage.ErrNotFound); when err is nil the response has been written.
func writeBlobContent(w http.ResponseWriter, r *http.Request, driver storage.Driver, digest string, size int64) (written int64, status int, err error) {
	w.Header().Set("Accept-Ranges", "bytes")
	offset, length, rs := parseRange(r.Header.Get("Range"), size)
	switch rs {
	case rangeUnsatisfiable:
		w.Header().Set("Content-Range", fmt.Sprintf("bytes */%d", size))
		writeError(w, http.StatusRequestedRangeNotSatisfiable, CodeRangeInvalid,
			fmt.Sprintf("requested range not satisfiable for a blob of %d bytes", size))
		return 0, http.StatusRequestedRangeNotSatisfiable, nil
	case rangeOK:
		body, err := storage.OpenRange(r.Context(), driver, digest, offset, length)
		if err != nil {
			return 0, 0, err
		}
		defer body.Close()
		w.Header().Set("Content-Range", fmt.Sprintf("bytes %d-%d/%d", offset, offset+length-1, size))
		w.Header().Set("Content-Length", strconv.FormatInt(length, 10))
		w.WriteHeader(http.StatusPartialContent)
		n, _ := io.Copy(w, body)
		return n, http.StatusPartialContent, nil
	default:
		body, actualSize, err := driver.Get(r.Context(), digest)
		if err != nil {
			return 0, 0, err
		}
		defer body.Close()
		w.Header().Set("Content-Length", strconv.FormatInt(actualSize, 10))
		w.WriteHeader(http.StatusOK)
		n, _ := io.Copy(w, body)
		return n, http.StatusOK, nil
	}
}
