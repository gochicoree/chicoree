"use client";

import { useState } from "react";
import { clsx } from "clsx";
import { Download, PackagePlus } from "lucide-react";
import { NewRepositoryForm } from "./new-repository-form";
import { ImportForm } from "../import/import-form";

export type SetupMode = "empty" | "mirror";

const MODES: { value: SetupMode; title: string; text: string; Icon: typeof PackagePlus }[] = [
  { value: "empty", title: "Empty repository", text: "Create it now and push images to it.", Icon: PackagePlus },
  {
    value: "mirror",
    title: "Mirror another registry",
    text: "Copy tags from a source repository and keep them in sync.",
    Icon: Download,
  },
];

/** One place to create a repository, either empty or as a mirror. */
export function RepositorySetup({
  organizationId,
  orgSlug,
  defaultVisibility,
  initialMode,
}: {
  organizationId: string;
  orgSlug: string;
  defaultVisibility: "public" | "private";
  initialMode: SetupMode;
}) {
  const [mode, setMode] = useState<SetupMode>(initialMode);
  return (
    <div className="space-y-5">
      <div role="tablist" aria-label="How to create the repository" className="grid gap-2 sm:grid-cols-2">
        {MODES.map((m) => {
          const active = mode === m.value;
          return (
            <button
              key={m.value}
              type="button"
              role="tab"
              aria-selected={active}
              onClick={() => setMode(m.value)}
              className={clsx(
                "flex items-start gap-3 rounded-xl border px-4 py-3 text-left transition-colors cursor-pointer",
                active ? "border-action bg-card shadow-card" : "border-line bg-card-2 hover:border-ink-3",
              )}
            >
              <m.Icon className={clsx("mt-0.5 size-4 shrink-0", active ? "text-accent" : "text-ink-3")} />
              <span>
                <span className="block text-sm font-medium text-ink">{m.title}</span>
                <span className="block text-xs text-ink-2">{m.text}</span>
              </span>
            </button>
          );
        })}
      </div>
      {mode === "empty" ? (
        <NewRepositoryForm organizationId={organizationId} orgSlug={orgSlug} defaultVisibility={defaultVisibility} />
      ) : (
        <ImportForm organizationId={organizationId} orgSlug={orgSlug} />
      )}
    </div>
  );
}
