"use client";

import { useActionState, useEffect, useRef, useState } from "react";
import { Gauge, RotateCcw } from "lucide-react";
import { resetSection, saveRateLimitSettings, type SettingsResult } from "@/app/actions/instance-settings";
import type { RateLimitSettings, SettingsSource } from "@/lib/instance-settings";
import { describeRateLimit, parseRateLimit } from "@/lib/rate-limit-shared";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Field, Input, Textarea } from "@/components/ui/field";
import { useToast } from "@/components/ui/toast";

function useResultToast(state: SettingsResult | null) {
  const { toast } = useToast();
  const last = useRef(state);
  useEffect(() => {
    if (state === last.current) return;
    last.current = state;
    if (state?.message && !state.error) toast({ title: state.message });
  }, [state, toast]);
}

function SourceBadge({ source }: { source: SettingsSource }) {
  if (source === "database") return <Badge tone="ok">saved in admin settings</Badge>;
  if (source === "environment") return <Badge tone="info">from environment</Badge>;
  return <Badge>no limits</Badge>;
}

function ResetButton() {
  const [state, action, pending] = useActionState<SettingsResult | null, FormData>(resetSection, null);
  useResultToast(state);
  return (
    <form action={action}>
      <input type="hidden" name="section" value="ratelimit" />
      <Button type="submit" variant="ghost" size="sm" disabled={pending}>
        <RotateCcw className="size-3.5" /> Use environment values
      </Button>
    </form>
  );
}

/** Live reading of a limit field: the sentence the value means, or the problem. */
function LimitHint({ value, noun = "pulls" }: { value: string; noun?: string }) {
  const parsed = parseRateLimit(value);
  if (parsed.error) return <span className="text-danger">{parsed.error}</span>;
  return <span>{describeRateLimit(parsed.limit, noun)}</span>;
}

export function RateLimitForm({ values, source }: { values: RateLimitSettings; source: SettingsSource }) {
  const [state, save, saving] = useActionState<SettingsResult | null, FormData>(saveRateLimitSettings, null);
  useResultToast(state);
  const [anonymous, setAnonymous] = useState(values.anonymous);
  const [authenticated, setAuthenticated] = useState(values.authenticated);
  const [apiAnonymous, setApiAnonymous] = useState(values.apiAnonymous);
  const [apiAuthenticated, setApiAuthenticated] = useState(values.apiAuthenticated);

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader
          eyebrow="Registry"
          title="Pull rate limits"
          description="Caps how many image pulls a client may make in a window. Docker Hub semantics: every manifest request (GET or HEAD) counts; blob downloads never do."
          action={
            <div className="flex flex-wrap items-center gap-2">
              <SourceBadge source={source} />
              {source === "database" && <ResetButton />}
            </div>
          }
        />
        <CardBody>
          <form action={save} className="grid gap-4 sm:grid-cols-2">
            <Field label="Anonymous clients" htmlFor="rl-anonymous">
              <Input
                id="rl-anonymous"
                name="anonymous"
                value={anonymous}
                onChange={(e) => setAnonymous(e.target.value)}
                placeholder="100/6h"
                className="font-mono"
                autoComplete="off"
              />
              <p className="mt-1.5 text-xs text-ink-2">
                Per client IP address · <LimitHint value={anonymous} />
              </p>
            </Field>
            <Field label="Authenticated clients" htmlFor="rl-authenticated">
              <Input
                id="rl-authenticated"
                name="authenticated"
                value={authenticated}
                onChange={(e) => setAuthenticated(e.target.value)}
                placeholder="200/6h"
                className="font-mono"
                autoComplete="off"
              />
              <p className="mt-1.5 text-xs text-ink-2">
                Per user or service account · <LimitHint value={authenticated} />
              </p>
            </Field>
            <div className="sm:col-span-2">
              <Field
                label="Trusted proxies"
                htmlFor="rl-proxies"
                hint="CIDRs or addresses of reverse proxies in front of the registry. Only when the connection comes from one of them is the last X-Forwarded-For hop used as the client address; otherwise the connecting address counts."
              >
                <Textarea
                  id="rl-proxies"
                  name="trustedProxies"
                  defaultValue={values.trustedProxies}
                  rows={3}
                  className="min-h-20 font-mono text-[13px]"
                  placeholder={"10.0.0.0/8\n172.16.0.0/12"}
                />
              </Field>
            </div>
            <fieldset className="sm:col-span-2">
              <legend className="mb-2 text-[13px] font-medium text-ink">REST API requests</legend>
              <div className="grid gap-4 sm:grid-cols-2">
                <Field label="Without credentials" htmlFor="rl-api-anonymous">
                  <Input id="rl-api-anonymous" name="apiAnonymous" value={apiAnonymous} onChange={(e) => setApiAnonymous(e.target.value)} placeholder="120/1m" className="font-mono" autoComplete="off" />
                  <p className="mt-1.5 text-xs text-ink-2">
                    Per client IP address · <LimitHint value={apiAnonymous} noun="requests" />
                  </p>
                </Field>
                <Field label="With a token or session" htmlFor="rl-api-authenticated">
                  <Input id="rl-api-authenticated" name="apiAuthenticated" value={apiAuthenticated} onChange={(e) => setApiAuthenticated(e.target.value)} placeholder="1200/1m" className="font-mono" autoComplete="off" />
                  <p className="mt-1.5 text-xs text-ink-2">
                    Per user, service account or CI identity · <LimitHint value={apiAuthenticated} noun="requests" />
                  </p>
                </Field>
              </div>
            </fieldset>
            <div className="flex flex-wrap items-center gap-3 sm:col-span-2">
              <Button type="submit" disabled={saving}>
                <Gauge className="size-4" /> Save rate limits
              </Button>
              {state?.error && <span className="text-sm text-danger">{state.error}</span>}
            </div>
          </form>
        </CardBody>
      </Card>

      <Card>
        <CardHeader eyebrow="How it works" title="What clients see" />
        <CardBody>
          <div className="grid gap-x-6 gap-y-3 text-sm text-ink-2 sm:grid-cols-2">
            <p>
              Limits are written as <span className="font-mono text-[13px] text-ink">&lt;count&gt;/&lt;window&gt;</span> with a
              window in seconds, minutes, hours or days — <span className="font-mono text-[13px] text-ink">100/6h</span>,{" "}
              <span className="font-mono text-[13px] text-ink">3/1m</span>. Leave a field empty for no limit.
            </p>
            <p>
              Each client&apos;s window starts with its first pull and restarts once it has elapsed. Counters live in memory,
              so <strong className="font-medium text-ink">every registry replica enforces the limit separately</strong>.
            </p>
            <p>
              Limited responses carry <span className="font-mono text-[13px] text-ink">RateLimit-Limit</span>,{" "}
              <span className="font-mono text-[13px] text-ink">RateLimit-Remaining</span> and{" "}
              <span className="font-mono text-[13px] text-ink">RateLimit-Reset</span> (seconds); over the limit the registry
              answers <span className="font-mono text-[13px] text-ink">429 TOOMANYREQUESTS</span> with{" "}
              <span className="font-mono text-[13px] text-ink">Retry-After</span>.
            </p>
            <p>
              The REST API has its own counters, shared by every web replica through the database: a client over its
              limit gets <span className="font-mono text-[13px] text-ink">429 rate_limited</span> with{" "}
              <span className="font-mono text-[13px] text-ink">Retry-After</span>, and every answer carries{" "}
              <span className="font-mono text-[13px] text-ink">X-RateLimit-Limit</span>,{" "}
              <span className="font-mono text-[13px] text-ink">X-RateLimit-Remaining</span> and{" "}
              <span className="font-mono text-[13px] text-ink">X-RateLimit-Reset</span>. Defaults come from{" "}
              <span className="font-mono text-[13px] text-ink">RATE_LIMIT_API_ANONYMOUS</span> and{" "}
              <span className="font-mono text-[13px] text-ink">RATE_LIMIT_API_AUTHENTICATED</span>.
            </p>
            <p>
              Instance administrators, the web app&apos;s own reads, mirrors and proxy caches are never limited. The
              environment variables <span className="font-mono text-[13px] text-ink">RATE_LIMIT_ANONYMOUS</span>,{" "}
              <span className="font-mono text-[13px] text-ink">RATE_LIMIT_AUTHENTICATED</span> and{" "}
              <span className="font-mono text-[13px] text-ink">RATE_LIMIT_TRUSTED_PROXIES</span> are the defaults while this
              section is unsaved.
            </p>
          </div>
        </CardBody>
      </Card>
    </div>
  );
}
