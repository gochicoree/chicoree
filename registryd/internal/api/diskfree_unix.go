//go:build unix

package api

import "syscall"

// diskFreeBytes reports the bytes available to unprivileged writers on the
// filesystem holding path, or -1 when it cannot be determined.
func diskFreeBytes(path string) int64 {
	var st syscall.Statfs_t
	if err := syscall.Statfs(path, &st); err != nil {
		return -1
	}
	return int64(st.Bavail) * int64(st.Bsize) //nolint:unconvert // field widths differ per platform
}
