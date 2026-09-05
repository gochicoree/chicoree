"use client";

import { useActionState, useState, type CSSProperties } from "react";
import { ImageUp, Plus, Trash2, X } from "lucide-react";
import { saveBrandingSettings } from "@/app/actions/admin-platform";
import type { SettingsResult } from "@/app/actions/instance-settings";
import type { SettingsSource } from "@/lib/instance-settings";
import {
  ANNOUNCEMENT_LEVELS,
  ANNOUNCEMENT_MAX_CHARS,
  announcementHash,
  FOOTER_LINKS_MAX,
  INSTANCE_NAME_MAX,
  isHexColor,
  LOGO_MAX_BYTES,
  TAGLINE_MAX,
  validateLogoDataUrl,
  type AnnouncementLevel,
  type BrandingSettings,
  type FooterLink,
} from "@/lib/branding-shared";
import { BrandMark } from "@/components/brand";
import { AnnouncementBar } from "@/components/shell/announcement-bar";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Field, Input, Textarea } from "@/components/ui/field";
import { Select } from "@/components/ui/select";
import { Feedback, HeaderAction, useResultToast } from "../auth/forms";

export function BrandingForm({ branding, source }: { branding: BrandingSettings; source: SettingsSource }) {
  const [state, save, saving] = useActionState<SettingsResult | null, FormData>(saveBrandingSettings, null);
  useResultToast(state);

  const [name, setName] = useState(branding.instanceName);
  const [tagline, setTagline] = useState(branding.tagline);
  const [logo, setLogo] = useState(branding.logoDataUrl);
  const [logoError, setLogoError] = useState<string | null>(null);
  const [accent, setAccent] = useState(branding.accentColor);
  const [links, setLinks] = useState<FooterLink[]>(branding.footerLinks);
  const [annEnabled, setAnnEnabled] = useState(branding.announcement.enabled);
  const [annLevel, setAnnLevel] = useState<AnnouncementLevel>(branding.announcement.level);
  const [annText, setAnnText] = useState(branding.announcement.text);
  const [annDismissible, setAnnDismissible] = useState(branding.announcement.dismissible);

  const previewStyle = accent && isHexColor(accent) ? ({ "--brand": accent } as CSSProperties) : undefined;

  function pickLogo(file: File | null) {
    setLogoError(null);
    if (!file) return;
    if (file.size > LOGO_MAX_BYTES) {
      setLogoError(`The logo must be ${LOGO_MAX_BYTES / 1024} KB or smaller (this file is ${Math.ceil(file.size / 1024)} KB).`);
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = String(reader.result ?? "");
      const check = validateLogoDataUrl(dataUrl);
      if (!check.ok) setLogoError(check.error);
      else setLogo(dataUrl);
    };
    reader.readAsDataURL(file);
  }

  function updateLink(i: number, patch: Partial<FooterLink>) {
    setLinks((list) => list.map((l, idx) => (idx === i ? { ...l, ...patch } : l)));
  }

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader eyebrow="Preview" title="How it looks" description="Updates as you type; nothing is applied until you save." />
        <CardBody className="space-y-3" >
          <div style={previewStyle} className="overflow-hidden rounded-lg border border-line">
            {annEnabled && annText && (
              <AnnouncementBar
                level={annLevel}
                text={annText}
                dismissible={annLevel !== "danger" && annDismissible}
                hash={announcementHash({ level: annLevel, text: annText })}
                preview
              />
            )}
            <div className="flex items-center gap-2.5 bg-card px-4 py-3">
              <BrandMark logoDataUrl={logo || undefined} className="size-6" />
              <span className="font-display text-lg font-bold tracking-tight">{name || "Chicorée"}</span>
              {tagline && <span className="hidden text-sm text-ink-2 sm:inline">· {tagline}</span>}
            </div>
            <div className="flex flex-wrap items-center gap-x-4 gap-y-1 border-t border-line bg-paper px-4 py-2 text-xs text-ink-3">
              <span>
                <span className="font-medium text-ink-2">{name || "Chicorée"}</span>
                {tagline && <span> · {tagline}</span>}
              </span>
              <span className="flex flex-wrap gap-x-3 sm:ml-auto">
                {links.filter((l) => l.label).map((l, i) => (
                  <span key={i} className="underline-offset-2 hover:underline">{l.label}</span>
                ))}
              </span>
            </div>
          </div>
        </CardBody>
      </Card>

      <Card>
        <CardHeader
          eyebrow="Identity"
          title="Branding"
          description="Shown in the sidebar, on the sign-in pages, in page titles and in emails."
          action={<HeaderAction section="branding" source={source} />}
        />
        <CardBody>
          <form action={save} className="grid gap-4 sm:grid-cols-2">
            <input type="hidden" name="logoDataUrl" value={logo} />
            <Field label="Instance name" htmlFor="brand-name" hint={`Up to ${INSTANCE_NAME_MAX} characters; INSTANCE_NAME is the environment default.`}>
              <Input id="brand-name" name="instanceName" value={name} maxLength={INSTANCE_NAME_MAX} onChange={(e) => setName(e.target.value)} required />
            </Field>
            <Field label="Tagline" htmlFor="brand-tagline" hint={`Up to ${TAGLINE_MAX} characters; shown under the sign-in card and in the footer.`}>
              <Input id="brand-tagline" name="tagline" value={tagline} maxLength={TAGLINE_MAX} onChange={(e) => setTagline(e.target.value)} />
            </Field>

            <div>
              <div className="mb-1.5 block text-[13px] font-medium text-ink">Logo</div>
              <div className="flex flex-wrap items-center gap-3">
                <div className="flex size-12 items-center justify-center rounded-lg border border-line bg-card-2" style={previewStyle}>
                  <BrandMark logoDataUrl={logo || undefined} className="size-8" />
                </div>
                <label className="inline-flex h-9 cursor-pointer items-center gap-2 rounded-lg border border-line-2 bg-card px-3 text-[13px] font-medium hover:bg-card-2">
                  <ImageUp className="size-4" /> Upload PNG or SVG
                  <input
                    type="file"
                    accept="image/png,image/svg+xml"
                    className="sr-only"
                    onChange={(e) => {
                      pickLogo(e.target.files?.[0] ?? null);
                      e.target.value = "";
                    }}
                  />
                </label>
                {logo && (
                  <Button type="button" variant="ghost" size="sm" onClick={() => setLogo("")}>
                    <X className="size-3.5" /> Use the default mark
                  </Button>
                )}
              </div>
              <p className="mt-1.5 text-xs text-ink-2">At most {LOGO_MAX_BYTES / 1024} KB; stored inline and served with every page. SVGs must not contain scripts.</p>
              {logoError && <p className="mt-1 text-xs text-danger">{logoError}</p>}
            </div>

            <Field label="Accent colour" htmlFor="brand-accent" hint="Hex value applied to the brand mark and brand tints; leave empty for chicory blue.">
              <div className="flex items-center gap-2">
                <input
                  type="color"
                  aria-label="Pick accent colour"
                  value={isHexColor(accent) ? accent : "#3d68c7"}
                  onChange={(e) => setAccent(e.target.value)}
                  className="size-9 shrink-0 cursor-pointer rounded-md border border-line-2 bg-card p-0.5"
                />
                <Input
                  id="brand-accent"
                  name="accentColor"
                  value={accent}
                  onChange={(e) => setAccent(e.target.value.trim())}
                  placeholder="#3d68c7"
                  className="font-mono"
                  pattern="#[0-9a-fA-F]{6}"
                />
                {accent && (
                  <Button type="button" variant="ghost" size="sm" onClick={() => setAccent("")}>
                    Reset
                  </Button>
                )}
              </div>
            </Field>

            <div className="sm:col-span-2">
              <div className="mb-1.5 flex items-center justify-between">
                <span className="text-[13px] font-medium text-ink">Footer links</span>
                <span className="text-xs text-ink-3">{links.length}/{FOOTER_LINKS_MAX}</span>
              </div>
              <div className="space-y-2">
                {links.map((l, i) => (
                  <div key={i} className="flex flex-wrap items-center gap-2">
                    <Input
                      name="footerLabel"
                      value={l.label}
                      onChange={(e) => updateLink(i, { label: e.target.value })}
                      placeholder="Label"
                      maxLength={40}
                      className="min-w-32 flex-1"
                      aria-label={`Link ${i + 1} label`}
                    />
                    <Input
                      name="footerUrl"
                      value={l.url}
                      onChange={(e) => updateLink(i, { url: e.target.value })}
                      placeholder="https://… or /path"
                      className="min-w-48 flex-[2] font-mono"
                      aria-label={`Link ${i + 1} URL`}
                    />
                    <button
                      type="button"
                      onClick={() => setLinks((list) => list.filter((_, idx) => idx !== i))}
                      aria-label="Remove link"
                      className="flex size-9 items-center justify-center rounded-md text-ink-3 hover:bg-card-2 hover:text-danger cursor-pointer"
                    >
                      <Trash2 className="size-4" />
                    </button>
                  </div>
                ))}
                {links.length < FOOTER_LINKS_MAX && (
                  <Button type="button" variant="secondary" size="sm" onClick={() => setLinks((list) => [...list, { label: "", url: "" }])}>
                    <Plus className="size-3.5" /> Add link
                  </Button>
                )}
              </div>
            </div>

            <div className="border-t border-line pt-4 sm:col-span-2">
              <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
                <div>
                  <div className="text-[13px] font-medium text-ink">Announcement</div>
                  <div className="text-xs text-ink-2">A banner at the top of every page. Readers can hide info and warning banners; danger banners stay.</div>
                </div>
                <label className="flex items-center gap-2 text-sm text-ink-2">
                  <input
                    type="checkbox"
                    name="announcementEnabled"
                    checked={annEnabled}
                    onChange={(e) => setAnnEnabled(e.target.checked)}
                    className="size-4 accent-[var(--action)]"
                  />
                  Show announcement
                </label>
              </div>
              <div className="grid gap-4 sm:grid-cols-[12rem_1fr]">
                <Field label="Level" htmlFor="ann-level">
                  <Select
                    id="ann-level"
                    name="announcementLevel"
                    value={annLevel}
                    onChange={(v) => setAnnLevel(v as AnnouncementLevel)}
                    options={ANNOUNCEMENT_LEVELS}
                  />
                  <label className="mt-3 flex items-start gap-2 text-sm text-ink-2">
                    <input
                      type="checkbox"
                      name="announcementDismissible"
                      checked={annDismissible}
                      onChange={(e) => setAnnDismissible(e.target.checked)}
                      className="mt-0.5 size-4 accent-[var(--action)]"
                    />
                    <span>
                      Readers may dismiss it
                      <span className="block text-xs text-ink-3">Ignored for danger banners.</span>
                    </span>
                  </label>
                </Field>
                <Field label="Text" htmlFor="ann-text" hint={`${annText.length}/${ANNOUNCEMENT_MAX_CHARS} characters, plain text.`}>
                  <Textarea
                    id="ann-text"
                    name="announcementText"
                    value={annText}
                    maxLength={ANNOUNCEMENT_MAX_CHARS}
                    rows={3}
                    onChange={(e) => setAnnText(e.target.value)}
                    placeholder="Maintenance on Saturday 02:00–03:00 UTC: pushes will be rejected for about an hour."
                  />
                </Field>
              </div>
            </div>

            <div className="flex flex-wrap items-center gap-3 sm:col-span-2">
          <div className="border-t border-line pt-4">
            <label className="flex items-start gap-2.5 text-sm">
              <input
                type="checkbox"
                name="gravatar"
                defaultChecked={branding.gravatar}
                className="mt-0.5 size-4 accent-[var(--action)]"
              />
              <span>
                <span className="block font-medium text-ink">Use Gravatar for accounts without an avatar</span>
                <span className="block text-xs text-ink-2">
                  People who have not uploaded a picture show their Gravatar instead of their initials. Their browser asks
                  gravatar.com for it, using a hash of their email address; an address without a Gravatar keeps the initials.
                </span>
              </span>
            </label>
            <label className="mt-3 flex items-start gap-2.5 text-sm">
              <input
                type="checkbox"
                name="showArtifacts"
                defaultChecked={branding.showArtifacts}
                className="mt-0.5 size-4 accent-[var(--action)]"
              />
              <span>
                <span className="block font-medium text-ink">Show index members and artifacts in lists (default for everyone)</span>
                <span className="block text-xs text-ink-2">
                  Off: the untagged list leaves out manifests that belong to a multi-arch index (platform variants and the
                  unknown/unknown attestation entries docker buildx adds) and attached artifacts, tag lists leave out cosign tags
                  (sha256-….sig / .att / .sbom), and variants tables leave out attestation entries. Everything stays on the index
                  page, the Attestations tab and by URL. Each user can override this under Settings → Display.
                </span>
              </span>
            </label>
          </div>

              <Button type="submit" disabled={saving || !!logoError}>
                Save branding
              </Button>
              <Feedback state={state} />
            </div>
          </form>
        </CardBody>
      </Card>
    </div>
  );
}
