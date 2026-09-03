// Package upstream talks to foreign OCI registries on behalf of proxy-cache
// organizations: it negotiates Bearer/Basic authentication, fetches manifests
// and blobs, maps repository names between the local and the upstream form,
// and deduplicates concurrent downloads of the same content.
package upstream

import (
	"net/url"
	"regexp"
	"strings"
)

// IsDockerHub reports whether the upstream URL points at Docker Hub, whose
// top-level images live under the implicit "library/" namespace.
func IsDockerHub(upstreamURL string) bool {
	u, err := url.Parse(strings.TrimSpace(upstreamURL))
	if err != nil {
		return false
	}
	switch strings.ToLower(u.Hostname()) {
	case "registry-1.docker.io", "index.docker.io", "docker.io", "registry.hub.docker.com", "hub.docker.com":
		return true
	}
	return false
}

// LocalName canonicalizes the repository path a client asked for into the
// name stored locally. Docker Hub library images are kept in their short
// form, so both <proxy>/nginx and <proxy>/library/nginx resolve to the same
// local repository "nginx" — the way people type them.
func LocalName(dockerHub bool, requested string) string {
	if dockerHub {
		if rest, ok := strings.CutPrefix(requested, "library/"); ok && rest != "" && !strings.Contains(rest, "/") {
			return rest
		}
	}
	return requested
}

// UpstreamPath maps a local repository name to the path on the upstream
// registry: single-component names on Docker Hub become library/<name>.
func UpstreamPath(dockerHub bool, local string) string {
	if dockerHub && !strings.Contains(local, "/") {
		return "library/" + local
	}
	return local
}

// Allowed reports whether an upstream path passes the proxy's allow-list —
// space- or comma-separated globs where * matches anything (including
// slashes) and ? matches one character. An empty list allows everything.
func Allowed(patterns, upstreamPath string) bool {
	fields := strings.FieldsFunc(patterns, func(r rune) bool { return r == ' ' || r == ',' || r == '\n' || r == '\t' })
	if len(fields) == 0 {
		return true
	}
	for _, p := range fields {
		if globToRegexp(p).MatchString(upstreamPath) {
			return true
		}
	}
	return false
}

func globToRegexp(glob string) *regexp.Regexp {
	var b strings.Builder
	b.WriteString("^")
	for _, r := range glob {
		switch r {
		case '*':
			b.WriteString(".*")
		case '?':
			b.WriteString(".")
		default:
			b.WriteString(regexp.QuoteMeta(string(r)))
		}
	}
	b.WriteString("$")
	return regexp.MustCompile(b.String())
}

// Challenge is a parsed WWW-Authenticate header.
type Challenge struct {
	Scheme string // "bearer" or "basic" (lower-case)
	Params map[string]string
}

// ParseChallenge parses `Bearer realm="…",service="…",scope="…"` (or a
// Basic challenge). Unknown or empty headers yield an empty scheme.
func ParseChallenge(header string) Challenge {
	header = strings.TrimSpace(header)
	scheme, rest, _ := strings.Cut(header, " ")
	c := Challenge{Scheme: strings.ToLower(scheme), Params: map[string]string{}}
	if c.Scheme != "bearer" && c.Scheme != "basic" {
		return Challenge{}
	}
	for _, m := range challengeParamRe.FindAllStringSubmatch(rest, -1) {
		key := strings.ToLower(m[1])
		val := m[2]
		if val == "" {
			val = m[3]
		}
		c.Params[key] = val
	}
	return c
}

var challengeParamRe = regexp.MustCompile(`(\w+)=(?:"([^"]*)"|([^\s,]+))`)
