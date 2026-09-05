package store

import (
	"context"
	"encoding/json"
	"time"
)

// OutboxEvent is one row of registry_event_outbox: a manifest push or delete
// the web app has to act on (scans, signature checks, webhooks, quota
// warnings). registryd inserts the row right after the change is committed
// and still POSTs the event to the web app as before; the row is the
// fallback the web app's scheduler drains when that POST never arrived
// (web app down, registryd restarted mid-retry) — see lib/registry-events.ts.
type OutboxEvent struct {
	Type       string
	Repository string
	Digest     string
	Tag        string
	Tags       []string
	MediaType  string
	Actor      string
	OccurredAt time.Time
}

// EnqueueEvent records the event and returns its row id. The web app marks
// the row delivered once it has processed the event.
func (s *Store) EnqueueEvent(ctx context.Context, e OutboxEvent) (int64, error) {
	tags, err := json.Marshal(e.Tags)
	if err != nil {
		return 0, err
	}
	if e.Tags == nil {
		tags = []byte("[]")
	}
	if e.OccurredAt.IsZero() {
		e.OccurredAt = time.Now().UTC()
	}
	var id int64
	err = s.pool.QueryRow(ctx, `
		INSERT INTO registry_event_outbox (type, repository, digest, tag, tags, media_type, actor, occurred_at)
		VALUES ($1, $2, NULLIF($3, ''), NULLIF($4, ''), $5::jsonb, NULLIF($6, ''), NULLIF($7, ''), $8)
		RETURNING id`,
		e.Type, e.Repository, e.Digest, e.Tag, string(tags), e.MediaType, e.Actor, e.OccurredAt).Scan(&id)
	return id, err
}
