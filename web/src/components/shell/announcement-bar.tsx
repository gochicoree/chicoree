"use client";

import { useEffect, useState } from "react";
import { AlertTriangle, Info, OctagonAlert, X } from "lucide-react";
import { clsx } from "clsx";
import type { AnnouncementLevel } from "@/lib/branding-shared";

const STORAGE_KEY = "chicoree.announcement.dismissed";

const STYLES: Record<AnnouncementLevel, { wrap: string; Icon: typeof Info }> = {
  info: { wrap: "border-line bg-card-2 text-ink", Icon: Info },
  warning: { wrap: "border-accent/40 bg-accent-soft text-accent-ink", Icon: AlertTriangle },
  danger: { wrap: "border-danger/40 bg-danger-soft text-danger", Icon: OctagonAlert },
};

/**
 * Instance-wide banner from Administration → Branding. Dismissal is remembered
 * per browser under a hash of the text, so an edited announcement shows again;
 * "danger" banners cannot be dismissed. `preview` renders it inert for the
 * admin form.
 */
export function AnnouncementBar({
  level,
  text,
  dismissible,
  hash,
  preview = false,
  className,
}: {
  level: AnnouncementLevel;
  text: string;
  dismissible: boolean;
  hash: string;
  preview?: boolean;
  className?: string;
}) {
  const [hidden, setHidden] = useState(false);
  useEffect(() => {
    if (preview || !dismissible) return;
    try {
      setHidden(window.localStorage.getItem(STORAGE_KEY) === hash);
    } catch {
      // storage unavailable: always show
    }
  }, [hash, dismissible, preview]);

  function dismiss() {
    if (preview) return;
    try {
      window.localStorage.setItem(STORAGE_KEY, hash);
    } catch {
      // ignore
    }
    setHidden(true);
  }

  if (hidden || !text) return null;
  const { wrap, Icon } = STYLES[level] ?? STYLES.info;
  return (
    <div
      role={level === "danger" ? "alert" : "status"}
      data-announcement={hash}
      className={clsx("flex items-start gap-2.5 border-b px-4 py-2 text-sm", wrap, className)}
    >
      <Icon className="mt-0.5 size-4 shrink-0" />
      <span className="min-w-0 flex-1 whitespace-pre-line [overflow-wrap:anywhere]">{text}</span>
      {dismissible && (
        <button
          type="button"
          onClick={dismiss}
          aria-label="Dismiss announcement"
          className="-my-1 -mr-1.5 flex size-7 shrink-0 items-center justify-center rounded-md opacity-70 hover:bg-card/60 hover:opacity-100 cursor-pointer"
        >
          <X className="size-3.5" />
        </button>
      )}
    </div>
  );
}
