"use client";

import { useEffect } from "react";
import Link from "next/link";
import { AlertTriangle, RefreshCw } from "lucide-react";
import { Button, buttonClasses } from "@/components/ui/button";

/**
 * A form submitted from a page that was loaded before the last deploy: its
 * server action ids belong to the previous build, so the server cannot find
 * them. Nothing is wrong with the instance; a reload picks up the new build.
 */
function isStaleBuild(error: Error): boolean {
  return /failed-to-find-server-action|Server Action .* was not found/i.test(error.message ?? "");
}

// Route-level error boundary: says what broke, offers a retry, and gives the
// digest operators need to find the matching server log line.
export default function ErrorBoundary({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  const stale = isStaleBuild(error);

  useEffect(() => {
    console.error(error);
    if (!stale) return;
    // Reload once on our own; if the fresh build still fails, show the message.
    try {
      const key = `reloaded-after-deploy:${window.location.pathname}`;
      if (!sessionStorage.getItem(key)) {
        sessionStorage.setItem(key, String(Date.now()));
        window.location.reload();
      }
    } catch {
      // storage unavailable: fall through to the manual reload button
    }
  }, [error, stale]);

  if (stale) {
    return (
      <div className="flex min-h-dvh flex-col items-center justify-center px-6 text-center">
        <div className="flex size-12 items-center justify-center rounded-xl bg-card-2">
          <RefreshCw className="size-6 text-accent" />
        </div>
        <p className="eyebrow mt-6">New version</p>
        <h1 className="mt-2 font-display text-3xl font-bold tracking-tight">The registry was updated</h1>
        <p className="mt-3 max-w-md text-sm leading-relaxed text-ink-2">
          This page was open while a new version was deployed, so the form it submitted no longer
          matches the server. Reload and try again; nothing was lost on the server side.
        </p>
        <div className="mt-6 flex flex-wrap justify-center gap-2">
          <Button onClick={() => window.location.reload()}>
            <RefreshCw className="size-4" /> Reload page
          </Button>
          <Link href="/dashboard" className={buttonClasses("secondary")}>
            Go to dashboard
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div className="flex min-h-dvh flex-col items-center justify-center px-6 text-center">
      <div className="flex size-12 items-center justify-center rounded-xl bg-danger-soft">
        <AlertTriangle className="size-6 text-danger" />
      </div>
      <p className="eyebrow mt-6">Something broke</p>
      <h1 className="mt-2 font-display text-3xl font-bold tracking-tight">
        This page hit an error
      </h1>
      <p className="mt-3 max-w-md text-sm leading-relaxed text-ink-2">
        The rest of the registry is unaffected — pushes and pulls keep working. Try again; if it
        keeps happening, check that the database and registry services are reachable and share the
        reference below with your administrator.
      </p>
      {error.digest && (
        <p className="mt-3 rounded-md bg-card-2 px-3 py-1.5 font-mono text-xs text-ink-2">
          error digest: {error.digest}
        </p>
      )}
      {error.message && (
        <p className="mt-2 max-w-md break-words font-mono text-xs text-ink-3">{error.message}</p>
      )}
      <div className="mt-6 flex flex-wrap justify-center gap-2">
        <Button onClick={reset}>Try again</Button>
        <Link href="/dashboard" className={buttonClasses("secondary")}>
          Go to dashboard
        </Link>
      </div>
    </div>
  );
}
