"use client";

import { useState, type ReactNode } from "react";
import { clsx } from "clsx";
import { Container } from "lucide-react";
import { logoSrc, type LogoKind, type LogoRef } from "@/lib/logo-shared";

/**
 * The picture of an organization, repository or user — or the icon that stood
 * there before pictures existed. One component for every call site, so a
 * missing picture takes exactly the same space as one that is set.
 *
 * `logo` is a reference, never the bytes: the browser fetches them from
 * /api/logo/<kind>/<id>?v=<version>, which is cached for a year and changes
 * whenever the picture does. Nothing here inlines a data URL.
 *
 * Pictures never cascade: a repository without one shows the repository icon,
 * not its organization's logo.
 */
export function EntityLogo({
  kind,
  name,
  logo,
  size = 16,
  shape,
  className,
  fallback,
}: {
  kind: LogoKind;
  /** Used for the monogram and as the accessible name when the picture is decorative. */
  name: string;
  /** Where the picture lives; null or undefined renders the fallback. */
  logo?: LogoRef | null;
  /** Rendered edge length in pixels. The fallback matches it exactly. */
  size?: number;
  /** Users default to a circle, organizations and repositories to a rounded square. */
  shape?: "circle" | "square";
  className?: string;
  /** Replaces the default fallback (a proxy repository shows a globe, the org header a filled tile). */
  fallback?: ReactNode;
}) {
  const [broken, setBroken] = useState(false);
  const round = (shape ?? (kind === "user" ? "circle" : "square")) === "circle";
  const radius = round ? "rounded-full" : size >= 28 ? "rounded-xl" : "rounded-md";
  const box = { width: size, height: size };

  if (logo && !broken) {
    return (
      // eslint-disable-next-line @next/next/no-img-element -- served by /api/logo with its own cache headers
      <img
        src={logoSrc(logo)}
        alt=""
        onError={() => setBroken(true)}
        width={size}
        height={size}
        style={box}
        className={clsx("shrink-0 bg-card-2", radius, round ? "object-cover" : "object-contain", className)}
      />
    );
  }

  return (
    <span
      style={box}
      aria-hidden
      // inline-flex, not flex: a flex parent blockifies it anyway, and inline
      // call sites (the activity feed) can sit it on the text baseline.
      className={clsx("inline-flex shrink-0 items-center justify-center", round && "rounded-full", className)}
    >
      {fallback ?? defaultFallback(kind, name, size)}
    </span>
  );
}

function defaultFallback(kind: LogoKind, name: string, size: number): ReactNode {
  if (kind === "user") {
    return (
      <span
        className="flex size-full items-center justify-center rounded-full bg-card-2 font-display font-semibold text-ink-2"
        style={{ fontSize: Math.max(9, Math.round(size * 0.45)) }}
      >
        {(name.trim().slice(0, 1) || "?").toUpperCase()}
      </span>
    );
  }
  return <Container className="text-ink-3" style={{ width: Math.round(size * 0.875), height: Math.round(size * 0.875) }} />;
}
