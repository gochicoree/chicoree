"use client";

import { useState } from "react";
import { Check, Copy } from "lucide-react";
import { clsx } from "clsx";

/** Inline copy-to-clipboard affordance for digests and commands. */
export function CopyButton({ value, label }: { value: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      aria-label={label ?? "Copy to clipboard"}
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(value);
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        } catch {
          // Clipboard unavailable (http origin); nothing sensible to do.
        }
      }}
      className="inline-flex size-6 shrink-0 items-center justify-center rounded-md text-ink-3 transition-colors hover:bg-card-2 hover:text-ink cursor-pointer pointer-coarse:size-8"
    >
      {copied ? <Check className="size-3.5 text-ok pointer-coarse:size-4" /> : <Copy className="size-3.5 pointer-coarse:size-4" />}
    </button>
  );
}

/** A shell command with a copy button, styled like a terminal line. */
export function CommandLine({ command, className }: { command: string; className?: string }) {
  return (
    <div
      className={clsx(
        "flex items-center gap-2 rounded-lg border border-line bg-card-2 py-2 pl-3 pr-2 font-mono text-[13px]",
        className,
      )}
    >
      <span aria-hidden className="select-none text-accent">
        $
      </span>
      <code className="min-w-0 flex-1 overflow-x-auto whitespace-nowrap text-ink">{command}</code>
      <CopyButton value={command} label="Copy command" />
    </div>
  );
}

/** Truncated digest with full-value copy. */
export function Digest({ digest, length = 12 }: { digest: string; length?: number }) {
  const hex = digest.includes(":") ? digest.split(":")[1] : digest;
  return (
    <span className="inline-flex items-center gap-1 font-mono text-[13px] text-ink-2">
      <span title={digest}>{hex.slice(0, length)}</span>
      <CopyButton value={digest} label="Copy digest" />
    </span>
  );
}
