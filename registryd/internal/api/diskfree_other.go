//go:build !unix

package api

// diskFreeBytes is unavailable on this platform.
func diskFreeBytes(string) int64 { return -1 }
