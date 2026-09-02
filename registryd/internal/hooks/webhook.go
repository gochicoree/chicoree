// Package hooks delivers push notifications to the web application, which
// uses them to kick off vulnerability scans and cache image config metadata.
package hooks

import (
	"bytes"
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"log/slog"
	"net/http"
	"time"
)

// Event is the payload POSTed to the web app.
type Event struct {
	Type       string `json:"type"` // "manifest.push" | "manifest.delete"
	Repository string `json:"repository"`
	Digest     string `json:"digest"`
	Tag        string `json:"tag,omitempty"`
	MediaType  string `json:"mediaType,omitempty"`
	Actor      string `json:"actor,omitempty"`
	OccurredAt string `json:"occurredAt"`
}

// Notifier posts signed events; deliveries are fire-and-forget with retries.
type Notifier struct {
	url    string
	secret []byte
	client *http.Client
}

// NewNotifier returns nil when no webhook URL is configured.
func NewNotifier(url, secret string) *Notifier {
	if url == "" {
		return nil
	}
	return &Notifier{url: url, secret: []byte(secret), client: &http.Client{Timeout: 15 * time.Second}}
}

// Notify delivers the event asynchronously with exponential backoff.
func (n *Notifier) Notify(e Event) {
	if n == nil {
		return
	}
	e.OccurredAt = time.Now().UTC().Format(time.RFC3339)
	body, err := json.Marshal(e)
	if err != nil {
		slog.Error("webhook marshal failed", "err", err)
		return
	}
	go func() {
		for attempt, delay := 0, time.Second; attempt < 4; attempt, delay = attempt+1, delay*3 {
			if attempt > 0 {
				time.Sleep(delay)
			}
			if n.deliver(body) {
				return
			}
		}
		slog.Warn("webhook delivery gave up", "type", e.Type, "repository", e.Repository, "digest", e.Digest)
	}()
}

func (n *Notifier) deliver(body []byte) bool {
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, n.url, bytes.NewReader(body))
	if err != nil {
		return false
	}
	req.Header.Set("Content-Type", "application/json")
	mac := hmac.New(sha256.New, n.secret)
	mac.Write(body)
	req.Header.Set("X-Chicoree-Signature", hex.EncodeToString(mac.Sum(nil)))
	resp, err := n.client.Do(req)
	if err != nil {
		slog.Debug("webhook delivery failed", "err", err)
		return false
	}
	defer resp.Body.Close()
	return resp.StatusCode >= 200 && resp.StatusCode < 300
}
