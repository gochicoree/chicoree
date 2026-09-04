package api

import (
	"testing"

	"registryd/internal/store"
)

func TestBlockApplies(t *testing.T) {
	vuln := &store.ManifestBlockRow{Reason: "2 critical findings; policy blocks critical findings"}
	sig := &store.ManifestBlockRow{Reason: "no signature from a trusted key (signature policy)", PushersExempt: true}
	cases := []struct {
		name    string
		block   *store.ManifestBlockRow
		canPush bool
		want    bool
	}{
		{"no block", nil, false, false},
		{"no block, pusher", nil, true, false},
		{"vulnerability block, puller", vuln, false, true},
		{"vulnerability block, pusher", vuln, true, true},
		{"signature block, puller", sig, false, true},
		{"signature block, pusher may read (to sign)", sig, true, false},
	}
	for _, c := range cases {
		if got := blockApplies(c.block, c.canPush); got != c.want {
			t.Errorf("%s: blockApplies = %v, want %v", c.name, got, c.want)
		}
	}
}
