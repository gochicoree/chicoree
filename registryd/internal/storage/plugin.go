package storage

import (
	"context"
	"fmt"
	"os"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
)

// Options is how a plugin reads its configuration. The core resolves keys
// against the environment: for plugin "s3" the key "BUCKET" is looked up as
// S3_BUCKET (and STORAGE_S3_BUCKET as an alternative spelling).
type Options interface {
	Lookup(key string) (string, bool)
}

// OptionDoc documents one configuration key of a plugin (used by the
// `registryd plugins` command and the README).
type OptionDoc struct {
	Key         string
	Description string
	Default     string
	Required    bool
}

// Factory constructs a driver from its options.
type Factory func(ctx context.Context, opts Options) (Driver, error)

// Plugin describes a storage backend.
type Plugin struct {
	Name        string
	Description string
	Options     []OptionDoc
	New         Factory
}

var (
	pluginsMu sync.RWMutex
	plugins   = map[string]*Plugin{}
)

// Register makes a plugin selectable by name. Called from a plugin package's
// init(); registering the same name twice is a programming error.
func Register(p *Plugin) {
	if p == nil || p.Name == "" || p.New == nil {
		panic("storage: Register called with an incomplete plugin")
	}
	pluginsMu.Lock()
	defer pluginsMu.Unlock()
	if _, dup := plugins[p.Name]; dup {
		panic("storage: plugin registered twice: " + p.Name)
	}
	plugins[p.Name] = p
}

// Plugins lists registered plugins sorted by name.
func Plugins() []*Plugin {
	pluginsMu.RLock()
	defer pluginsMu.RUnlock()
	out := make([]*Plugin, 0, len(plugins))
	for _, p := range plugins {
		out = append(out, p)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Name < out[j].Name })
	return out
}

// Lookup returns a plugin by name.
func Lookup(name string) (*Plugin, bool) {
	pluginsMu.RLock()
	defer pluginsMu.RUnlock()
	p, ok := plugins[name]
	return p, ok
}

// Open instantiates the named driver after validating required options.
func Open(ctx context.Context, name string, opts Options) (Driver, error) {
	p, ok := Lookup(name)
	if !ok {
		names := make([]string, 0)
		for _, q := range Plugins() {
			names = append(names, q.Name)
		}
		return nil, fmt.Errorf("unknown storage driver %q (available: %s)", name, strings.Join(names, ", "))
	}
	for _, o := range p.Options {
		if o.Required {
			if v, ok := opts.Lookup(o.Key); !ok || v == "" {
				return nil, fmt.Errorf("storage driver %q requires option %s", name, EnvName(name, o.Key))
			}
		}
	}
	return p.New(ctx, opts)
}

// EnvName is the canonical environment variable for a plugin option.
func EnvName(plugin, key string) string {
	return strings.ToUpper(strings.ReplaceAll(plugin, "-", "_")) + "_" + strings.ToUpper(key)
}

// envOptions resolves plugin options from the process environment.
type envOptions struct {
	plugin string
}

// NewEnvOptions returns Options backed by environment variables for the
// given plugin name.
func NewEnvOptions(plugin string) Options { return envOptions{plugin: plugin} }

func (e envOptions) Lookup(key string) (string, bool) {
	canonical := EnvName(e.plugin, key)
	if v, ok := os.LookupEnv(canonical); ok {
		return v, true
	}
	if v, ok := os.LookupEnv("STORAGE_" + canonical); ok {
		return v, true
	}
	return "", false
}

// MapOptions is an Options backed by a map — handy for tests and embedding.
type MapOptions map[string]string

func (m MapOptions) Lookup(key string) (string, bool) {
	v, ok := m[strings.ToUpper(key)]
	return v, ok
}

// --- typed helpers plugins can use ---

func Get(o Options, key, def string) string {
	if v, ok := o.Lookup(key); ok && v != "" {
		return v
	}
	return def
}

func GetBool(o Options, key string, def bool) bool {
	v, ok := o.Lookup(key)
	if !ok || v == "" {
		return def
	}
	b, err := strconv.ParseBool(v)
	if err != nil {
		return def
	}
	return b
}

func GetDuration(o Options, key string, def time.Duration) time.Duration {
	v, ok := o.Lookup(key)
	if !ok || v == "" {
		return def
	}
	d, err := time.ParseDuration(v)
	if err != nil {
		return def
	}
	return d
}
