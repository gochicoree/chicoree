package config

import "testing"

func TestDeriveInternalAPIURL(t *testing.T) {
	for in, want := range map[string]string{
		"http://web:3000/api/internal/events":        "http://web:3000/api/internal",
		"http://localhost:3105/api/internal/events/": "http://localhost:3105/api/internal",
		"https://registry.example.com/x":             "https://registry.example.com",
		"http://web:3000":                            "http://web:3000",
		"":                                           "",
	} {
		if got := DeriveInternalAPIURL(in); got != want {
			t.Errorf("DeriveInternalAPIURL(%q) = %q, want %q", in, got, want)
		}
	}
}
