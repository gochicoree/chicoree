"use client";

import { useState } from "react";
import { Field, Input } from "@/components/ui/field";
import { Select } from "@/components/ui/select";
import type { Relabel, TagSelector } from "@/db/schema";

const SELECTOR_OPTIONS = [
  { value: "all", label: "All tags", description: "Every tag the source has" },
  { value: "glob", label: "Glob patterns", description: "e.g. 1.27.*, stable-*" },
  { value: "regex", label: "Regular expression", description: "e.g. ^v?\\d+\\.\\d+\\.\\d+$" },
  { value: "list", label: "Explicit list", description: "Comma or space separated tags" },
];

/** Shared form fields for the import page and the repository mirror card. */
export function MirrorFormFields({
  source,
  selector,
  relabel,
  hasStoredAuth,
}: {
  source?: string;
  selector?: TagSelector;
  relabel?: Relabel;
  hasStoredAuth?: boolean;
}) {
  const [mode, setMode] = useState<TagSelector["mode"]>(selector?.mode ?? "all");
  return (
    <>
      <div className="sm:col-span-2">
        <Field
          label="Source repository"
          htmlFor="source"
          hint="e.g. nginx, ghcr.io/org/app, registry.example.com/team/app"
        >
          <Input id="source" name="source" required defaultValue={source} className="font-mono" placeholder="docker.io/library/nginx" />
        </Field>
      </div>
      <Field label="Source username" htmlFor="username" hint="Leave empty for anonymous pulls">
        <Input id="username" name="username" autoComplete="off" />
      </Field>
      <Field
        label="Source password / token"
        htmlFor="password"
        hint={hasStoredAuth ? "Stored — leave blank to keep, enter - to clear" : undefined}
      >
        <Input id="password" name="password" type="password" autoComplete="new-password" />
      </Field>

      <Field label="Which tags" htmlFor="selectorMode">
        <Select
          id="selectorMode"
          name="selectorMode"
          options={SELECTOR_OPTIONS}
          value={mode}
          onChange={(v) => setMode(v as TagSelector["mode"])}
        />
      </Field>
      <Field
        label={mode === "list" ? "Tags" : "Pattern"}
        htmlFor="pattern"
        hint={mode === "all" ? "Not needed for all tags" : mode === "glob" ? "e.g. v* 1.2?" : undefined}
      >
        <Input id="pattern" name="pattern" defaultValue={selector?.pattern} disabled={mode === "all"} className="font-mono" />
      </Field>
      <div className="sm:col-span-2">
        <Field label="Exclude" htmlFor="exclude" hint={mode === "regex" ? "Regular expression" : "Glob patterns, e.g. *-alpine *-rc*"}>
          <Input id="exclude" name="exclude" defaultValue={selector?.exclude} className="font-mono" />
        </Field>
      </div>

      <Field
        label="Destination tag template"
        htmlFor="tagTemplate"
        hint="{tag} source tag · {source} source repo name · {major} {minor} {patch} from semver tags"
      >
        <Input id="tagTemplate" name="tagTemplate" defaultValue={relabel?.tagTemplate ?? "{tag}"} className="font-mono" />
      </Field>
      <div className="grid grid-cols-2 gap-2">
        <Field label="Rewrite (regex)" htmlFor="replaceFrom">
          <Input id="replaceFrom" name="replaceFrom" defaultValue={relabel?.replaceFrom} className="font-mono" placeholder="^v" />
        </Field>
        <Field label="With" htmlFor="replaceTo">
          <Input id="replaceTo" name="replaceTo" defaultValue={relabel?.replaceTo} className="font-mono" placeholder="" />
        </Field>
      </div>
      <label className="flex items-start gap-2 text-sm text-ink-2 sm:col-span-2">
        <input type="hidden" name="latest" value="off" />
        <input
          type="checkbox"
          name="latest"
          value="on"
          defaultChecked={relabel?.latest ?? true}
          className="mt-0.5 size-4 accent-[var(--action)]"
        />
        <span>
          Point <code className="font-mono">latest</code> at the newest imported image when the source has no{" "}
          <code className="font-mono">latest</code> tag (highest version, else most recently built)
        </span>
      </label>
    </>
  );
}
