# Observability — README and ARCHITECTURE additions

Fold the sections below into the main docs after merge.

---

## (a) README-ready sections

### Monitoring (additions to the existing section)

**Two scrape targets, one token.** Besides the web app's `/api/metrics`
(state computed from the database), `registryd` serves its own process
metrics at `GET /metrics` (also `/internal/v1/metrics`): request counts and
latency per route, bytes moved, rate-limit rejections, proxy-cache hits and
upstream requests, staging disk space and the Go runtime. Both endpoints
accept the same bearer token — the one *Administration → Metrics* shows.
Enabling the endpoint there enables both; the registry picks the change up
within 30 seconds, no restart needed. Until then it answers 404; a wrong or
missing token gets 401.

The Metrics page prints a ready-made `prometheus.yml` block with both jobs.
The equivalent by hand, with the token in a file:

```yaml
scrape_configs:
  - job_name: chicoree
    metrics_path: /api/metrics
    authorization:
      credentials_file: /etc/prometheus/metrics-token
    static_configs: [{ targets: ["web:3000"] }]
  - job_name: chicoree-registryd
    metrics_path: /metrics
    authorization:
      credentials_file: /etc/prometheus/metrics-token
    static_configs: [{ targets: ["registryd:5000"] }]
```

`deploy/prometheus/prometheus.example.yml` is that file, plus a 60 s scrape
interval and `deploy/prometheus/alerts.yml`. Keep the job names — the
dashboard and the alert rules refer to `chicoree` and `chicoree-registryd`.

For instances configured without the admin panel, `METRICS_ENABLED=true`
and `METRICS_TOKEN` on the web app and the same `METRICS_TOKEN` on
`registryd` do the same job.

**registryd metrics.** All names start with `chicoree_registryd_`:

| Metric | Labels | Meaning |
| --- | --- | --- |
| `http_requests_total` | `method`, `route`, `status` | requests by route template (`manifest`, `blob`, `upload`, `tags`, `referrers`, `catalog`, `base`, `internal`, `metrics`, `other`) — never repository names |
| `http_request_duration_seconds` | `route` | latency histogram |
| `http_in_flight` | | requests being served right now |
| `upload_bytes_total` | | bytes received for committed uploads and manifest pushes |
| `blob_bytes_served_total` | `mode` = `stream` / `redirect` | blob bytes streamed by the registry, or handed to S3 / the CDN through a redirect |
| `rate_limited_total` | `subject` = `anonymous` / `authenticated` | pulls refused with 429 |
| `proxy_upstream_requests_total` | `kind` = `manifest` / `blob`, `result` = `ok`, `not_found`, `unauthorized`, `denied`, `rate_limited`, `error` | requests the pull-through proxy made upstream |
| `proxy_cache_hits_total`, `proxy_cache_misses_total` | `kind` | proxied requests served locally vs. fetched |
| `staging_free_bytes` | | free space on the filesystem holding `STORAGE_STAGING_DIR` (−1 when unknown) |
| `storage_driver_info` | `driver` | always 1 |
| `build_info` | `version`, `go` | always 1 |

plus the standard `go_*` and `process_*` series. Counters live in the
process: with several `registryd` replicas scrape each one (Prometheus sums
them), and a restart resets them — the web app's `chicoree_*` totals are the
durable numbers.

**Alert rules and dashboard.** `deploy/prometheus/alerts.yml` ships 18
rules (`severity: critical` or `warning`): web scrape failing, registry down,
Clair unreachable with scans waiting, scans failing, scan backlog growing or
stale, webhook deliveries failing, a job's last run failed, mirror sync
failed, proxy upstream failing, no successful GC in 7 days, >5 % 429s, >5 %
5xx, slow manifests (p95 > 2 s), egress spike (3× the 6-hour average and
> 10 MiB/s), proxy upstream error ratio > 20 %, staging disk below 5 GiB and
an organization above 90 % of its storage limit. Thresholds are starting
points; edit them in place.

`deploy/grafana/chicoree.json` is a Grafana 11+ dashboard (import it under
*Dashboards → New → Import*, pick your Prometheus when asked) with rows for
Overview (up, version, storage physical vs logical, dedup savings, counts,
pulls today), Traffic (egress / ingress rate, top repositories by egress,
requests by route and status class, p50 / p95 latency, 429s), Content (pulls
and pushes per day, largest repositories), Security (findings by severity,
scan status, blocked images), Operations (last job outcome, webhook, mirror
and proxy failures, staging space, GC age, proxy cache) and Runtime (memory,
goroutines, in-flight, CPU, file descriptors).

**Running the stack next to Chicorée.** `docker-compose.observability.yml`
adds Prometheus and Grafana (dashboard and datasource provisioned) under the
`observability` profile, published on loopback only:

```sh
echo '<token from Administration → Metrics>' > secrets/metrics-token
docker compose -f docker-compose.yml -f docker-compose.observability.yml \
  --profile observability up -d
```

Prometheus answers at `http://localhost:9090`, Grafana at
`http://localhost:3001` (`admin` / `admin`; set `GRAFANA_ADMIN_PASSWORD`
and optionally `GRAFANA_ADMIN_USER`, `PROMETHEUS_RETENTION` (default `30d`)
and `METRICS_TOKEN_FILE` in `.env`). The dashboard lives in the *Chicorée*
folder; it is read from the file, so *Save as* a copy before customising.
Alerts fire inside Prometheus — point it at an Alertmanager
(`alerting:` block in `prometheus.example.yml`) to get notified.

### Environment variables (additions)

| Variable | Service | Default | Meaning |
| --- | --- | --- | --- |
| `METRICS_TOKEN` | registryd | empty | bearer token for `GET /metrics` when the admin panel's Metrics section is not used; the panel's token works regardless |
| `GRAFANA_ADMIN_USER`, `GRAFANA_ADMIN_PASSWORD` | observability overlay | `admin` / `admin` | Grafana login |
| `PROMETHEUS_RETENTION` | observability overlay | `30d` | TSDB retention |
| `METRICS_TOKEN_FILE` | observability overlay | `./secrets/metrics-token` | file mounted as Prometheus' `credentials_file` |

---

## (b) ARCHITECTURE-ready notes

### registryd metrics endpoint (`internal/metrics`, `internal/api/metrics.go`)

- `internal/metrics` owns a private `prometheus.Registry` (Go and process
  collectors plus the `chicoree_registryd_*` series). `Metrics` is nil-safe:
  every method is a no-op on a nil receiver, so `Server{}` literals in tests
  need no setup. `RouteTemplate(path)` maps request paths to the bounded
  route vocabulary by scanning for the last marker segment (`manifests`,
  `blobs`, `tags`, `referrers`), so nested proxy names and a repository
  literally called `manifests` classify correctly; unknown verbs collapse to
  `OTHER`.
- Instrumentation points: `logMiddleware` (request counter, latency
  histogram, in-flight gauge — it already had the status recorder),
  `countTraffic` (upload bytes = every `PushBytes` delta), `handleBlobGet`
  (bytes served by mode; a linked blob in a proxy organization counts as a
  blob cache hit), `enforcePullLimit` (429s by subject), and the proxy:
  `noteUpstream(kind, err)` after every `GetManifest` / `HeadManifest` /
  `OpenBlob`, `CacheHit` for a local manifest (exists, fresh, revalidated by
  HEAD, or served stale after an upstream failure) and for blob content
  linked by dedup, `CacheMiss` when the manifest or blob came from upstream.
  Series that alerts rely on are pre-created so a fresh process exposes 0.
- The endpoint (`GET /metrics`, `GET /internal/v1/metrics`) is gated by
  `metricsGate`: the `instance_settings` row `metrics` (`{enabled,
  tokenHash}`) polled every 30 s by `RunMetricsReload` — the same pattern as
  the rate limits — and `METRICS_TOKEN` from the environment. The row's
  `token` is encrypted with the web app's `AUTH_SECRET`-derived key, which
  registryd does not have, so `saveMetricsSettings` also stores
  `tokenHash = sha256(effective token)` in the clear; registryd compares
  `sha256(bearer)` against it in constant time. Either credential is accepted
  while configured; 404 when neither is, 401 otherwise. A row saved before
  `tokenHash` existed counts as disabled until the section is saved again.
- `chicoree_registryd_staging_free_bytes` is a `GaugeFunc` over
  `diskFreeBytes(StagingDir)`, evaluated per scrape.

### Web metrics additions (`lib/metrics.ts`)

`addOperationalMetrics` runs a second `Promise.all` of aggregate queries and
appends: `chicoree_job_last_run_status{job,status}` (one-hot from
`DISTINCT ON (job)` over `job_runs`), `chicoree_job_last_success_timestamp_seconds{job}`
(0 when never), `chicoree_vulnerability_scan_pending_oldest_seconds`,
`chicoree_webhooks_failing` (enabled webhooks with `last_error` or
`last_status >= 400`), `chicoree_webhook_deliveries_recent{status}` (last
hour), `chicoree_mirror_last_status{status}` (enabled mirrors, `never` for
unrun), `chicoree_proxy_organizations{enabled}` and
`chicoree_proxy_organizations_failing` (`last_error` set),
`chicoree_organization_storage_{bytes,limit_bytes,ratio}{organization}`
(only organizations with a limit; `bytes` uses the same distinct-blob sum as
registryd's quota check), `chicoree_events_today{type}`,
`chicoree_traffic_today_bytes{direction}`, `chicoree_audit_events_total`
and `chicoree_rate_limit_config_info{anonymous,authenticated,source}`. Like
the rest of the exposition everything is computed at scrape time.

### Files

- `deploy/prometheus/prometheus.example.yml`, `deploy/prometheus/alerts.yml`
  (validated with `promtool check config` / `check rules`).
- `deploy/grafana/chicoree.json` (uid `chicoree-registry`, schemaVersion 41,
  `__inputs` + a `DS_PROMETHEUS` datasource variable so it imports through
  the UI and provisions from file; `web_job` / `registryd_job` variables
  resolve the scrape job names), `deploy/grafana/provisioning/{datasources,dashboards}/*.yml`.
- `docker-compose.observability.yml` (profile `observability`,
  `prom/prometheus:v3.14.0`, `grafana/grafana:13.2.1`, loopback ports
  9090 / 3001).
