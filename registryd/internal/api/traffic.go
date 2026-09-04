package api

import "registryd/internal/traffic"

// UseTraffic enables egress/ingress accounting through the counter, which
// aggregates in memory and flushes to repository_traffic on its own clock.
func (s *Server) UseTraffic(c *traffic.Counter) { s.traffic = c }

// countTraffic records a request's bytes against the repository. A nil
// counter (accounting disabled) makes this a no-op.
func (s *Server) countTraffic(repoID string, d traffic.Delta) {
	s.metrics.AddUploadBytes(d.PushBytes)
	if s.traffic == nil {
		return
	}
	s.traffic.Add(repoID, d)
}
