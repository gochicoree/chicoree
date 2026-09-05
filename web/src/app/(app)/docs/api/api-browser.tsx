"use client";

// Interactive API browser: every endpoint of the catalog with its
// parameters as a form, sent for real against this instance — with the
// browser session, or with a token pasted for the occasion (kept in memory
// only) — and the response shown with status, timing and headers. The curl
// line for the same call is one click away. Requests that change data ask
// before they go out.
import { useEffect, useMemo, useState } from "react";
import { clsx } from "clsx";
import { ChevronDown, ChevronRight, Loader2, Play, Search, Trash2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { Field, Input } from "@/components/ui/field";
import { Select } from "@/components/ui/select";
import { ConfirmModal } from "@/components/ui/modal";
import { CommandLine, CopyButton } from "@/components/ui/copy";
import { ACCESS_LABELS, API_GROUPS, type ApiEndpoint, type ApiGroup, type ApiMethod, type ApiParam } from "@/lib/api/catalog";

const METHOD_TONE: Record<ApiMethod, "info" | "ok" | "accent" | "danger"> = {
  GET: "info",
  POST: "ok",
  PUT: "accent",
  PATCH: "accent",
  DELETE: "danger",
};

const EXAMPLE_VALUES: Record<string, string> = {
  org: "library",
  repo: "",
  tag: "latest",
  digest: "",
  q: "",
  name: "",
};

function keyOf(e: ApiEndpoint): string {
  return `${e.method} ${e.path}`;
}

function anchorOf(e: ApiEndpoint): string {
  return `${e.method.toLowerCase()}-${e.path.replace(/[^a-z0-9]+/gi, "-").replace(/^-|-$/g, "") || "index"}`;
}

function fullPath(base: string, e: ApiEndpoint): string {
  return `${base}${e.path === "/" ? "" : e.path}`;
}

function paramKey(p: ApiParam): string {
  return `${p.in}:${p.name}`;
}

/** "public | private" → options; integer / boolean / date / string → input kinds. */
function control(p: ApiParam): { kind: "select"; options: string[] } | { kind: "boolean" } | { kind: "integer" } | { kind: "date" } | { kind: "text" } {
  if (p.type.includes("|")) return { kind: "select", options: p.type.split("|").map((s) => s.trim()) };
  if (p.type === "boolean") return { kind: "boolean" };
  if (p.type === "integer") return { kind: "integer" };
  if (p.type === "date") return { kind: "date" };
  return { kind: "text" };
}

function bodyValue(p: ApiParam, raw: string): unknown {
  const c = control(p);
  if (c.kind === "boolean") return raw === "true";
  if (c.kind === "integer") return Number(raw);
  return raw;
}

/** The request the form describes: URL, body and the curl line for it. */
function buildRequest(appUrl: string, base: string, e: ApiEndpoint, values: Record<string, string>) {
  let path = fullPath(base, e);
  const missing: string[] = [];
  for (const p of e.params ?? []) {
    const v = (values[paramKey(p)] ?? "").trim();
    if (p.in === "path") {
      if (!v) missing.push(p.name);
      path = path.replace(`{${p.name}}`, encodeURIComponent(v));
    } else if (p.required && !v) {
      missing.push(p.name);
    }
  }
  const query = new URLSearchParams();
  for (const p of e.params ?? []) {
    if (p.in !== "query") continue;
    const v = (values[paramKey(p)] ?? "").trim();
    if (v) query.set(p.name, v);
  }
  const body: Record<string, unknown> = {};
  for (const p of e.params ?? []) {
    if (p.in !== "body") continue;
    const v = (values[paramKey(p)] ?? "").trim();
    if (v) body[p.name] = bodyValue(p, v);
  }
  const url = `${path}${query.size ? `?${query}` : ""}`;
  const hasBody = Object.keys(body).length > 0;
  const curl = [
    "curl",
    e.method !== "GET" ? `-X ${e.method}` : "",
    e.access !== "public" ? '-H "Authorization: Bearer $TOKEN"' : "",
    hasBody ? `-H "Content-Type: application/json" -d '${JSON.stringify(body)}'` : "",
    `"${appUrl}${url}"`,
  ]
    .filter(Boolean)
    .join(" ");
  return { url, body: hasBody ? JSON.stringify(body) : null, curl, missing };
}

interface Outcome {
  status: number;
  statusText: string;
  ms: number;
  headers: [string, string][];
  body: string;
  pretty: string | null;
}

function ParamInput({ p, id, value, onChange }: { p: ApiParam; id: string; value: string; onChange: (v: string) => void }) {
  const c = control(p);
  if (c.kind === "select" || c.kind === "boolean") {
    const options = c.kind === "boolean" ? ["true", "false"] : c.options;
    return (
      <Select
        id={id}
        size="sm"
        value={value}
        onChange={onChange}
        placeholder={p.required ? "choose…" : "(default)"}
        options={[...(p.required ? [] : [{ value: "", label: "(default)" }]), ...options.map((o) => ({ value: o, label: o }))]}
      />
    );
  }
  return (
    <Input
      id={id}
      type={c.kind === "integer" ? "number" : c.kind === "date" ? "date" : "text"}
      value={value}
      placeholder={EXAMPLE_VALUES[p.name] ? `e.g. ${EXAMPLE_VALUES[p.name]}` : undefined}
      required={p.required}
      className="text-sm"
      onChange={(ev) => onChange(ev.target.value)}
    />
  );
}

function ParamGroup({
  title,
  params,
  values,
  setValue,
  prefix,
}: {
  title: string;
  params: ApiParam[];
  values: Record<string, string>;
  setValue: (k: string, v: string) => void;
  prefix: string;
}) {
  if (params.length === 0) return null;
  return (
    <div>
      <div className="eyebrow mb-2">{title}</div>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {params.map((p) => {
          const id = `${prefix}-${p.in}-${p.name}`;
          return (
            <Field key={id} label={`${p.name}${p.required || p.in === "path" ? " *" : ""}`} htmlFor={id} hint={p.description}>
              <ParamInput p={p} id={id} value={values[paramKey(p)] ?? ""} onChange={(v) => setValue(paramKey(p), v)} />
            </Field>
          );
        })}
      </div>
    </div>
  );
}

const PREVIEW_LINES = 80;

/** Pretty text that wraps and flows with the page; long bodies start folded with a "show all" toggle instead of an inner scrollbar. */
function BodyView({ text, copyLabel }: { text: string; copyLabel: string }) {
  const [all, setAll] = useState(false);
  const lines = text.split("\n");
  const folded = !all && lines.length > PREVIEW_LINES + 10;
  const shown = folded ? lines.slice(0, PREVIEW_LINES).join("\n") : text;
  return (
    <div className="relative">
      <div className="absolute right-2 top-2">
        <CopyButton value={text} label={copyLabel} />
      </div>
      <pre className="whitespace-pre-wrap rounded-lg border border-line bg-card-2 p-3 pr-10 font-mono text-xs leading-relaxed text-ink [overflow-wrap:anywhere]">
        {shown || "(empty)"}
      </pre>
      {(folded || all) && lines.length > PREVIEW_LINES + 10 && (
        <div className={clsx("flex justify-center", folded ? "-mt-3" : "mt-2")}>
          <Button type="button" variant="secondary" size="sm" onClick={() => setAll((v) => !v)}>
            {folded ? `Show all ${lines.length.toLocaleString("en-US")} lines` : "Show less"}
          </Button>
        </div>
      )}
    </div>
  );
}

function StatusBadge({ status }: { status: number }) {
  const tone = status >= 500 ? "danger" : status >= 400 ? "danger" : status >= 300 ? "accent" : "ok";
  return (
    <Badge tone={tone} className="font-mono">
      {status}
    </Badge>
  );
}

export function ApiBrowser({ endpoints, appUrl, base }: { endpoints: ApiEndpoint[]; appUrl: string; base: string }) {
  const [filter, setFilter] = useState("");
  const [selectedKey, setSelectedKey] = useState(() => keyOf(endpoints[0]));
  const [values, setValues] = useState<Record<string, string>>({});
  const [authMode, setAuthMode] = useState<"session" | "token">("session");
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [openGroups, setOpenGroups] = useState<ApiGroup[]>(() => [endpoints[0].group]);
  const [showExample, setShowExample] = useState(false);

  const selected = endpoints.find((e) => keyOf(e) === selectedKey) ?? endpoints[0];

  // Deep links: #get-orgs-org-repos selects the endpoint; selecting one updates the hash.
  useEffect(() => {
    const hash = window.location.hash.replace(/^#/, "");
    const match = hash && endpoints.find((e) => anchorOf(e) === hash);
    if (match) {
      setSelectedKey(keyOf(match));
      setOpenGroups((g) => (g.includes(match.group) ? g : [...g, match.group]));
    }
  }, [endpoints]);

  function toggleGroup(g: ApiGroup) {
    setOpenGroups((open) => (open.includes(g) ? open.filter((x) => x !== g) : [...open, g]));
  }

  function select(e: ApiEndpoint) {
    setSelectedKey(keyOf(e));
    setValues({});
    setOutcome(null);
    setFailure(null);
    setShowExample(false);
    window.history.replaceState(null, "", `#${anchorOf(e)}`);
  }

  const visible = useMemo(() => {
    const q = filter.trim().toLowerCase();
    return endpoints.filter((e) => !q || `${e.method} ${e.path} ${e.summary} ${e.group}`.toLowerCase().includes(q));
  }, [endpoints, filter]);

  const request = useMemo(() => buildRequest(appUrl, base, selected, values), [appUrl, base, selected, values]);
  const params = selected.params ?? [];
  const unsafe = selected.method !== "GET";

  async function send() {
    setBusy(true);
    setFailure(null);
    setOutcome(null);
    const started = performance.now();
    try {
      const headers: Record<string, string> = { Accept: "application/json" };
      if (authMode === "token" && token.trim()) headers.Authorization = `Bearer ${token.trim()}`;
      if (request.body) headers["Content-Type"] = "application/json";
      const res = await fetch(request.url, {
        method: selected.method,
        headers,
        body: request.body ?? undefined,
        // With a token the session cookie stays home, so the answer shows what the token alone can do.
        credentials: authMode === "token" ? "omit" : "same-origin",
        cache: "no-store",
      });
      const text = await res.text();
      let pretty: string | null = null;
      try {
        pretty = JSON.stringify(JSON.parse(text), null, 2);
      } catch {
        pretty = null;
      }
      setOutcome({
        status: res.status,
        statusText: res.statusText,
        ms: Math.round(performance.now() - started),
        headers: [...res.headers.entries()].filter(([k]) => /^(x-api-|content-type|cache-control|www-authenticate|content-length)/i.test(k)),
        body: text,
        pretty,
      });
    } catch (err) {
      setFailure(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  function trySend() {
    if (request.missing.length) {
      setFailure(`Fill in ${request.missing.map((m) => `"${m}"`).join(", ")} first.`);
      return;
    }
    if (unsafe) setConfirming(true);
    else void send();
  }

  const setValue = (k: string, v: string) => setValues((prev) => ({ ...prev, [k]: v }));

  return (
    <div className="grid grid-cols-1 gap-5 lg:grid-cols-[17rem_minmax(0,1fr)]">
      <Card className="lg:sticky lg:top-6 lg:max-h-[calc(100dvh-3rem)] lg:self-start lg:overflow-y-auto">
        <div className="border-b border-line p-3">
          <div className="relative">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-ink-3" />
            <Input
              aria-label="Filter endpoints"
              placeholder="Filter endpoints…"
              value={filter}
              onChange={(ev) => setFilter(ev.target.value)}
              className="pl-8 text-sm"
            />
          </div>
        </div>
        <nav aria-label="Endpoints" className="p-2">
          {API_GROUPS.filter((g) => visible.some((e) => e.group === g)).map((g) => {
            // A filter shows every match; otherwise only the opened groups unfold.
            const open = filter.trim() !== "" || openGroups.includes(g);
            const items = visible.filter((e) => e.group === g);
            return (
              <div key={g} className="mb-1">
                <button
                  type="button"
                  aria-expanded={open}
                  onClick={() => toggleGroup(g)}
                  className="eyebrow flex w-full cursor-pointer items-center justify-between rounded-lg px-2 py-1.5 transition-colors hover:bg-card-2 hover:text-ink"
                >
                  <span>
                    {g}
                    {!open && items.some((e) => keyOf(e) === selectedKey) && <span className="ml-1.5 text-accent">•</span>}
                  </span>
                  <span className="flex items-center gap-1.5 normal-case tracking-normal">
                    <span className="font-mono text-[10px] text-ink-3">{items.length}</span>
                    <ChevronDown className={clsx("size-3.5 text-ink-3 transition-transform", !open && "-rotate-90")} />
                  </span>
                </button>
                {open &&
                  items.map((e) => {
                    const active = keyOf(e) === selectedKey;
                    return (
                      <button
                        key={keyOf(e)}
                        type="button"
                        data-endpoint={keyOf(e)}
                        title={`${e.method} ${e.path} — ${e.summary}`}
                        onClick={() => select(e)}
                        className={clsx(
                          "flex w-full cursor-pointer items-center gap-2 rounded-lg px-2 py-1.5 text-left text-[13px] transition-colors",
                          active ? "bg-card-2 text-ink" : "text-ink-2 hover:bg-card-2 hover:text-ink",
                        )}
                      >
                        <Badge tone={METHOD_TONE[e.method]} className="w-14 justify-center font-mono text-[10px]">
                          {e.method}
                        </Badge>
                        <span className="min-w-0 flex-1 truncate font-mono text-xs">{e.path}</span>
                        {active && <ChevronRight className="size-3.5 shrink-0 text-ink-3" />}
                      </button>
                    );
                  })}
              </div>
            );
          })}
          {visible.length === 0 && <p className="px-2 py-4 text-sm text-ink-3">Nothing matches.</p>}
        </nav>
      </Card>

      <div className="min-w-0 space-y-5">
        <Card>
          <CardHeader
            eyebrow={selected.group}
            title={selected.summary}
            description={selected.description}
            action={
              <div className="flex flex-wrap gap-1.5">
                <Badge tone="neutral" title={ACCESS_LABELS[selected.access]}>
                  {ACCESS_LABELS[selected.access].split(" (")[0]}
                </Badge>
                {selected.deprecated && (
                  <Badge tone="danger" title={selected.deprecated.note ?? selected.deprecated.replacement}>
                    deprecated since {selected.deprecated.since}
                    {selected.deprecated.sunset ? `, sunset ${selected.deprecated.sunset}` : ""}
                  </Badge>
                )}
                {selected.write && <Badge tone="accent">read &amp; write token</Badge>}
                {selected.serviceAccounts && <Badge tone="neutral">service accounts</Badge>}
                {selected.paginated && <Badge tone="neutral">paginated</Badge>}
                <Badge tone="neutral" className="font-mono">
                  since {selected.since}
                </Badge>
              </div>
            }
          />
          <CardBody className="space-y-5">
            <div className="flex items-center gap-2 rounded-lg border border-line bg-card-2 px-3 py-2 font-mono text-[13px]">
              <Badge tone={METHOD_TONE[selected.method]} className="font-mono">
                {selected.method}
              </Badge>
              <code className="min-w-0 flex-1 break-all text-ink">{fullPath(base, selected)}</code>
              <CopyButton value={`${appUrl}${fullPath(base, selected)}`} label="Copy URL" />
            </div>

            <ParamGroup title="Path" params={params.filter((p) => p.in === "path")} values={values} setValue={setValue} prefix="p" />
            <ParamGroup title="Query" params={params.filter((p) => p.in === "query")} values={values} setValue={setValue} prefix="q" />
            <ParamGroup title="Body (JSON)" params={params.filter((p) => p.in === "body")} values={values} setValue={setValue} prefix="b" />

            <div className="grid gap-3 sm:grid-cols-[auto_minmax(0,1fr)_auto] sm:items-end">
              <Field label="Send as" htmlFor="api-auth-mode">
                <Select
                  id="api-auth-mode"
                  size="sm"
                  value={authMode}
                  onChange={(v) => setAuthMode(v === "token" ? "token" : "session")}
                  options={[
                    { value: "session", label: "Me (this session)", description: "Your browser session, as in the app" },
                    { value: "token", label: "A token", description: "Only the token; the session stays out" },
                  ]}
                />
              </Field>
              {authMode === "token" ? (
                <Field label="Token" htmlFor="api-token" hint="Kept in memory for this page only.">
                  <Input id="api-token" type="password" autoComplete="off" placeholder="chc_pat_… or chc_sa_…" value={token} onChange={(ev) => setToken(ev.target.value)} className="font-mono text-sm" />
                </Field>
              ) : (
                <div className="text-xs text-ink-3 sm:pb-2.5">Anonymous calls: sign out, or send as a token and leave it empty.</div>
              )}
              <Button type="button" onClick={trySend} disabled={busy} variant={selected.method === "DELETE" ? "danger" : "primary"} className="sm:mb-px">
                {busy ? <Loader2 className="size-4 animate-spin" /> : selected.method === "DELETE" ? <Trash2 className="size-4" /> : <Play className="size-4" />}
                {busy ? "Sending…" : "Send"}
              </Button>
            </div>

            <div>
              <div className="eyebrow mb-2">curl</div>
              <CommandLine command={request.curl} />
            </div>
          </CardBody>
        </Card>

        {(outcome || failure) && (
          <Card>
            <CardHeader
              eyebrow="Response"
              title={outcome ? `${outcome.status} ${outcome.statusText}`.trim() : "Request failed"}
              description={outcome ? `${outcome.ms} ms · ${outcome.body.length.toLocaleString("en-US")} bytes` : undefined}
              action={outcome ? <StatusBadge status={outcome.status} /> : <Badge tone="danger">error</Badge>}
            />
            <CardBody className="space-y-3">
              {failure && <p className="text-sm text-danger">{failure}</p>}
              {outcome && (
                <>
                  <details className="text-xs text-ink-2">
                    <summary className="cursor-pointer select-none">Headers</summary>
                    <dl className="mt-2 grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1 font-mono">
                      {outcome.headers.map(([k, v]) => (
                        <div key={k} className="contents">
                          <dt className="text-ink-3">{k}</dt>
                          <dd className="break-all">{v}</dd>
                        </div>
                      ))}
                    </dl>
                  </details>
                  <BodyView text={outcome.pretty ?? outcome.body} copyLabel="Copy response" />
                </>
              )}
            </CardBody>
          </Card>
        )}

        {selected.example !== undefined && (
          <Card>
            <CardHeader
              eyebrow="Documented"
              title={`Example response (${selected.status ?? 200})`}
              action={
                <Button type="button" variant="ghost" size="sm" aria-expanded={showExample} onClick={() => setShowExample((v) => !v)}>
                  {showExample ? "Hide" : "Show"}
                </Button>
              }
            />
            {showExample && (
              <CardBody>
                <BodyView text={JSON.stringify(selected.example, null, 2)} copyLabel="Copy example" />
              </CardBody>
            )}
          </Card>
        )}
      </div>

      <ConfirmModal
        open={confirming}
        onClose={() => setConfirming(false)}
        onConfirm={() => {
          setConfirming(false);
          void send();
        }}
        title={`Send ${selected.method} ${fullPath(base, selected)}?`}
        description="This is a real request against this registry: it changes data exactly like the app would."
        confirmLabel={`Send ${selected.method}`}
        tone={selected.method === "DELETE" ? "danger" : "primary"}
        busy={busy}
      />
    </div>
  );
}
