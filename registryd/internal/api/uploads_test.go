package api

import "testing"

func TestSplitMountSource(t *testing.T) {
	cases := []struct {
		from string
		org  string
		repo string
		ok   bool
	}{
		{"acme/alpine", "acme", "alpine", true},
		// Top-level names live in the library organization, as routeV2 resolves them.
		{"dubcall", LibraryOrg, "dubcall", true},
		{"my-app.v2", LibraryOrg, "my-app.v2", true},
		// Deeper paths (proxy caches) are not mountable sources.
		{"dockerhub/bitnami/redis", "", "", false},
		{"", "", "", false},
		{"Acme/Alpine", "", "", false},
		{"acme//alpine", "", "", false},
	}
	for _, c := range cases {
		org, repo, ok := splitMountSource(c.from)
		if ok != c.ok || org != c.org || repo != c.repo {
			t.Errorf("splitMountSource(%q) = (%q, %q, %v), want (%q, %q, %v)", c.from, org, repo, ok, c.org, c.repo, c.ok)
		}
	}
}
