package upstream

import "testing"

func TestIsDockerHub(t *testing.T) {
	for url, want := range map[string]bool{
		"https://registry-1.docker.io": true,
		"https://index.docker.io/":     true,
		"https://docker.io":            true,
		"https://ghcr.io":              false,
		"https://quay.io":              false,
		"http://localhost:5010":        false,
		"":                             false,
	} {
		if got := IsDockerHub(url); got != want {
			t.Errorf("IsDockerHub(%q) = %v, want %v", url, got, want)
		}
	}
}

func TestNameMapping(t *testing.T) {
	cases := []struct {
		dockerHub          bool
		requested          string
		wantLocal, wantUps string
	}{
		{true, "nginx", "nginx", "library/nginx"},
		{true, "library/nginx", "nginx", "library/nginx"},
		{true, "bitnami/redis", "bitnami/redis", "bitnami/redis"},
		{true, "library/a/b", "library/a/b", "library/a/b"},
		{false, "library/nginx", "library/nginx", "library/nginx"},
		{false, "oras-project/oras", "oras-project/oras", "oras-project/oras"},
		{false, "org/team/app", "org/team/app", "org/team/app"},
	}
	for _, c := range cases {
		local := LocalName(c.dockerHub, c.requested)
		if local != c.wantLocal {
			t.Errorf("LocalName(%v, %q) = %q, want %q", c.dockerHub, c.requested, local, c.wantLocal)
		}
		if ups := UpstreamPath(c.dockerHub, local); ups != c.wantUps {
			t.Errorf("UpstreamPath(%v, %q) = %q, want %q", c.dockerHub, local, ups, c.wantUps)
		}
	}
}

func TestAllowed(t *testing.T) {
	cases := []struct {
		patterns, path string
		want           bool
	}{
		{"", "anything/goes", true},
		{"   ", "anything/goes", true},
		{"library/*", "library/nginx", true},
		{"library/*", "bitnami/redis", false},
		{"library/* bitnami/*", "bitnami/redis", true},
		{"library/*,bitnami/*", "bitnami/redis", true},
		{"org/*", "org/team/app", true},
		{"org/team/app", "org/team/app", true},
		{"org/team/app", "org/team/app2", false},
		{"library/ngin?", "library/nginx", true},
		{"library/nginx", "library/nginx-unprivileged", false},
		{"*", "x/y/z", true},
	}
	for _, c := range cases {
		if got := Allowed(c.patterns, c.path); got != c.want {
			t.Errorf("Allowed(%q, %q) = %v, want %v", c.patterns, c.path, got, c.want)
		}
	}
}

func TestParseChallenge(t *testing.T) {
	c := ParseChallenge(`Bearer realm="https://auth.docker.io/token",service="registry.docker.io",scope="repository:library/alpine:pull"`)
	if c.Scheme != "bearer" {
		t.Fatalf("scheme = %q", c.Scheme)
	}
	if c.Params["realm"] != "https://auth.docker.io/token" || c.Params["service"] != "registry.docker.io" ||
		c.Params["scope"] != "repository:library/alpine:pull" {
		t.Fatalf("params = %v", c.Params)
	}
	b := ParseChallenge(`Basic realm="Registry Realm"`)
	if b.Scheme != "basic" || b.Params["realm"] != "Registry Realm" {
		t.Fatalf("basic = %+v", b)
	}
	if ParseChallenge("").Scheme != "" || ParseChallenge("Digest x=y").Scheme != "" {
		t.Fatal("unknown schemes must yield an empty challenge")
	}
	// Unquoted values (some registries) and mixed case.
	u := ParseChallenge(`BEARER realm=http://x/token,service=svc`)
	if u.Scheme != "bearer" || u.Params["realm"] != "http://x/token" || u.Params["service"] != "svc" {
		t.Fatalf("unquoted = %+v", u)
	}
}
