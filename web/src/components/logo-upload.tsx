"use client";

import { useActionState, useEffect, useRef, useState } from "react";
import { ImageUp, X } from "lucide-react";
import type { LogoResult } from "@/app/actions/logos";
import {
  LOGO_ACCEPT,
  LOGO_FORMATS_LABEL,
  LOGO_MAX_BYTES,
  LOGO_MAX_KB,
  validateLogoDataUrl,
  type LogoKind,
} from "@/lib/logo-shared";
import { EntityLogo } from "@/components/entity-logo";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { useToast } from "@/components/ui/toast";

/**
 * Upload / preview / remove control for an organization, repository or user
 * picture. Reads the file into a data URL, checks it in the browser for quick
 * feedback and submits it to a server action that checks it again.
 *
 * The preview inlines the data URL — this is a single-entity settings form,
 * never a listing.
 */
export function LogoUploadCard({
  action,
  kind,
  name,
  fields,
  initial,
  eyebrow = "Picture",
  title,
  description,
  submitLabel = "Save picture",
  removeLabel = "Remove picture",
}: {
  action: (prev: LogoResult | null, formData: FormData) => Promise<LogoResult>;
  kind: LogoKind;
  /** Name behind the fallback monogram. */
  name: string;
  /** Hidden inputs identifying the entity, e.g. `{ organizationId }`. */
  fields: Record<string, string>;
  /** The picture in place, as a data URL, or null. */
  initial: string | null;
  eyebrow?: string;
  title: string;
  description?: string;
  submitLabel?: string;
  removeLabel?: string;
}) {
  const [state, submit, pending] = useActionState<LogoResult | null, FormData>(action, null);
  const [logo, setLogo] = useState(initial ?? "");
  const [error, setError] = useState<string | null>(null);
  const { toast } = useToast();
  const seen = useRef<LogoResult | null>(null);

  useEffect(() => {
    if (state === seen.current) return;
    seen.current = state;
    if (state?.saved) toast({ title: state.message ?? "Saved", tone: "success" });
  }, [state, toast]);

  function pick(file: File | null) {
    setError(null);
    if (!file) return;
    if (file.size > LOGO_MAX_BYTES) {
      setError(`The picture must be ${LOGO_MAX_KB} KB or smaller (this file is ${Math.ceil(file.size / 1024)} KB).`);
      return;
    }
    const reader = new FileReader();
    reader.onerror = () => setError("That file could not be read.");
    reader.onload = () => {
      const dataUrl = String(reader.result ?? "");
      const check = validateLogoDataUrl(dataUrl);
      if (!check.ok) setError(check.error);
      else setLogo(dataUrl);
    };
    reader.readAsDataURL(file);
  }

  const changed = logo !== (initial ?? "");

  return (
    <Card>
      <CardHeader eyebrow={eyebrow} title={title} description={description} />
      <CardBody>
        <form action={submit} className="space-y-3">
          {Object.entries(fields).map(([key, value]) => (
            <input key={key} type="hidden" name={key} value={value} />
          ))}
          <input type="hidden" name="logoDataUrl" value={logo} />
          <div className="flex flex-wrap items-center gap-3">
            <div className="flex size-16 shrink-0 items-center justify-center rounded-xl border border-line bg-card-2">
              {logo ? (
                // eslint-disable-next-line @next/next/no-img-element -- live preview of the file just picked
                <img
                  src={logo}
                  alt=""
                  className={`size-14 object-contain ${kind === "user" ? "rounded-full object-cover" : "rounded-lg"}`}
                />
              ) : (
                <EntityLogo kind={kind} name={name} size={48} />
              )}
            </div>
            <label className="inline-flex h-9 cursor-pointer items-center gap-2 rounded-lg border border-line-2 bg-card px-3 text-[13px] font-medium hover:bg-card-2">
              <ImageUp className="size-4" /> Upload {LOGO_FORMATS_LABEL}
              <input
                type="file"
                accept={LOGO_ACCEPT}
                className="sr-only"
                onChange={(e) => {
                  pick(e.target.files?.[0] ?? null);
                  e.target.value = "";
                }}
              />
            </label>
            {logo && (
              <Button type="button" variant="ghost" size="sm" onClick={() => setLogo("")}>
                <X className="size-3.5" /> {removeLabel}
              </Button>
            )}
          </div>
          <p className="text-xs text-ink-2">
            At most {LOGO_MAX_KB} KB. SVGs must not contain scripts.
          </p>
          {error && <p className="text-sm text-danger">{error}</p>}
          {state?.error && <p className="rounded-md bg-danger-soft px-3 py-2 text-sm text-danger">{state.error}</p>}
          <Button type="submit" disabled={pending || !!error || !changed}>
            {pending ? "Saving…" : submitLabel}
          </Button>
        </form>
      </CardBody>
    </Card>
  );
}
