"use client";

import { useState } from "react";
import { Modal } from "@/components/ui/modal";
import { Input } from "@/components/ui/field";
import type { SbomComponent } from "@/lib/signatures-shared";

interface Pkg {
  name: string;
  version?: string;
}

/** Pull the package list out of an SPDX or CycloneDX document. */
function packagesOf(doc: unknown): Pkg[] {
  const d = doc as Record<string, unknown> | null;
  if (!d || typeof d !== "object") return [];
  const spdx = Array.isArray(d.packages) ? (d.packages as Record<string, unknown>[]) : null;
  if (spdx) {
    return spdx
      .map((p) => ({ name: String(p.name ?? ""), version: p.versionInfo ? String(p.versionInfo) : undefined }))
      .filter((p) => p.name);
  }
  const cyclone = Array.isArray(d.components) ? (d.components as Record<string, unknown>[]) : null;
  if (cyclone) {
    return cyclone
      .map((c) => ({ name: String(c.name ?? ""), version: c.version ? String(c.version) : undefined }))
      .filter((p) => p.name);
  }
  return [];
}

function Chip({ name, version, title }: { name: string; version?: string | null; title?: string }) {
  return (
    <li
      title={title}
      className="max-w-full rounded-md border border-line bg-card-2 px-1.5 py-0.5 font-mono text-[11px] text-ink-2 [overflow-wrap:anywhere]"
    >
      {name}
      {version && <span className="text-ink-3">@{version}</span>}
    </li>
  );
}

/**
 * The first few packages of an SBOM, with the rest a click away. Only a
 * preview is stored next to the image; opening the full list fetches the
 * document itself from the artifact route.
 */
export function SbomPackages({
  preview,
  packageCount,
  href,
  label,
}: {
  preview: SbomComponent[];
  packageCount: number;
  /** Artifact route serving the SBOM document. */
  href: string;
  /** What the dialog is about, e.g. the image reference. */
  label: string;
}) {
  const [open, setOpen] = useState(false);
  const [all, setAll] = useState<Pkg[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [filter, setFilter] = useState("");
  const hidden = packageCount - preview.length;

  async function openAll() {
    setOpen(true);
    if (all || busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(href);
      if (!res.ok) throw new Error(`The SBOM could not be loaded (${res.status}).`);
      // The document names the image itself as a package; the card says that above.
      setAll(packagesOf(await res.json()).filter((pkg) => pkg.name !== label));
    } catch (err) {
      setError(err instanceof Error ? err.message : "The SBOM could not be loaded.");
    } finally {
      setBusy(false);
    }
  }

  const shown = (all ?? []).filter((p) => !filter || `${p.name}@${p.version ?? ""}`.toLowerCase().includes(filter.toLowerCase()));

  return (
    <>
      <ul className="flex flex-wrap gap-1.5">
        {preview.map((c, i) => (
          <Chip key={`${c.name}-${i}`} name={c.name} version={c.version} title={c.license ? `license ${c.license}` : undefined} />
        ))}
        {hidden > 0 && (
          <li>
            <button
              type="button"
              onClick={openAll}
              className="cursor-pointer rounded-md border border-dashed border-line-2 px-1.5 py-0.5 text-[11px] text-ink-2 transition-colors hover:border-ink-3 hover:text-ink"
            >
              +{hidden} more
            </button>
          </li>
        )}
      </ul>

      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title={`Packages (${all ? all.length : packageCount})`}
        description={<span className="font-mono text-xs [overflow-wrap:anywhere]">{label}</span>}
        size="lg"
      >
        <div className="space-y-3">
          {all && all.length > 12 && (
            <Input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Filter packages…" aria-label="Filter packages" />
          )}
          {busy && <p className="text-sm text-ink-3">Loading the SBOM…</p>}
          {error && <p className="rounded-md bg-danger-soft px-3 py-2 text-sm text-danger">{error}</p>}
          {all && (
            <ul className="flex flex-wrap gap-1.5">
              {shown.map((p, i) => (
                <Chip key={`${p.name}-${i}`} name={p.name} version={p.version} />
              ))}
              {shown.length === 0 && <li className="text-sm text-ink-3">No package matches that filter.</li>}
            </ul>
          )}
        </div>
      </Modal>
    </>
  );
}
