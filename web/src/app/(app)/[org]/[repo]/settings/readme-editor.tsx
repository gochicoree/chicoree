"use client";

import { useActionState, useState, useTransition } from "react";
import { clsx } from "clsx";
import { previewReadme, updateReadme, type ReadmeResult } from "@/app/actions/readme";
import { README_MAX_BYTES, readmeBytes } from "@/lib/readme-shared";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/field";
import { useActionToast } from "@/components/ui/toast";

/** Markdown editor with a server-rendered preview (same sanitizer as the repository page). */
export function ReadmeEditor({ repositoryId, readme }: { repositoryId: string; readme: string | null }) {
  const [state, action, pending] = useActionState<ReadmeResult | null, FormData>(updateReadme, null);
  const [text, setText] = useState(readme ?? "");
  const [mode, setMode] = useState<"write" | "preview">("write");
  const [html, setHtml] = useState<string | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [previewing, startPreview] = useTransition();
  useActionToast(state, "README saved");

  const bytes = readmeBytes(text);
  const tooBig = bytes > README_MAX_BYTES;

  function showPreview() {
    setMode("preview");
    startPreview(async () => {
      const result = await previewReadme(text);
      setPreviewError(result.error ?? null);
      setHtml(result.html ?? null);
    });
  }

  const tab = (active: boolean) =>
    clsx(
      "rounded-md px-3 py-1.5 text-[13px] font-medium transition-colors cursor-pointer",
      active ? "bg-card text-ink shadow-card" : "text-ink-2 hover:text-ink",
    );

  return (
    <Card>
      <CardHeader
        eyebrow="Documentation"
        title="README"
        description="Markdown shown on the repository page: usage, tags, configuration. Links open with nofollow; images must be served over https."
      />
      <CardBody>
        <form action={action} className="space-y-3">
          <input type="hidden" name="repositoryId" value={repositoryId} />
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div role="tablist" className="inline-flex gap-1 rounded-lg border border-line bg-card-2 p-1">
              <button type="button" role="tab" aria-selected={mode === "write"} className={tab(mode === "write")} onClick={() => setMode("write")}>
                Markdown
              </button>
              <button type="button" role="tab" aria-selected={mode === "preview"} className={tab(mode === "preview")} onClick={showPreview}>
                Preview
              </button>
            </div>
            <span className={clsx("font-mono text-xs tabular-nums", tooBig ? "text-danger" : "text-ink-3")} data-readme-bytes>
              {(bytes / 1024).toFixed(1)} / {README_MAX_BYTES / 1024} KB
            </span>
          </div>
          {/* The textarea stays mounted in both modes so the form always submits the current text. */}
          <Textarea
            name="readme"
            value={text}
            onChange={(e) => setText(e.target.value)}
            rows={16}
            spellCheck={false}
            placeholder={"# My image\n\nHow to run it, which tags exist, what to configure…"}
            className={clsx("min-h-64 font-mono text-[13px] leading-relaxed", mode !== "write" && "hidden")}
            aria-label="README in Markdown"
          />
          {mode === "preview" && (
            <div className="min-h-64 rounded-lg border border-line bg-card px-4 py-3" data-readme-preview>
              {previewing ? (
                <p className="text-sm text-ink-3">Rendering…</p>
              ) : previewError ? (
                <p className="text-sm text-danger">{previewError}</p>
              ) : html === null || html.trim() === "" ? (
                <p className="text-sm text-ink-3">Nothing to preview yet.</p>
              ) : (
                <article className="markdown" dangerouslySetInnerHTML={{ __html: html }} />
              )}
            </div>
          )}
          <div className="flex flex-wrap items-center gap-3">
            <Button type="submit" disabled={pending || tooBig}>
              Save README
            </Button>
            {state?.error && <span className="text-sm text-danger">{state.error}</span>}
          </div>
        </form>
      </CardBody>
    </Card>
  );
}
