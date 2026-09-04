"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { Compass, Menu, Search, Settings, X } from "lucide-react";
import { BrandLockup } from "@/components/brand";
import { Sidebar, type NavBranding, type NavOrg } from "./sidebar";

/**
 * Small-screen shell: a slim sticky header with a menu button, and the full
 * sidebar in a slide-in drawer. Closes on navigation, Escape and backdrop tap.
 */
export function MobileNav({
  orgs,
  orgCount,
  user,
  isAdmin,
  branding,
  canCreateOrgs,
}: {
  orgs: NavOrg[];
  orgCount?: number;
  user: { name: string; email: string };
  isAdmin: boolean;
  branding?: NavBranding;
  canCreateOrgs?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const pathname = usePathname();
  const panelRef = useRef<HTMLDivElement>(null);
  const openerRef = useRef<HTMLButtonElement>(null);

  // Navigating anywhere closes the drawer.
  useEffect(() => {
    setOpen(false);
  }, [pathname]);

  useEffect(() => {
    if (!open) return;
    panelRef.current?.focus();
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = prevOverflow;
      openerRef.current?.focus({ preventScroll: true });
    };
  }, [open]);

  const iconLink =
    "flex size-10 items-center justify-center rounded-lg text-ink-2 transition-colors hover:bg-card-2 hover:text-ink";

  return (
    <>
      <header className="sticky top-0 z-30 flex h-14 items-center gap-1 border-b border-line bg-card/95 px-2 backdrop-blur supports-[backdrop-filter]:bg-card/85 lg:hidden">
        <button
          ref={openerRef}
          type="button"
          onClick={() => setOpen(true)}
          aria-label="Open navigation"
          aria-expanded={open}
          aria-controls="mobile-drawer"
          className={`${iconLink} cursor-pointer`}
        >
          <Menu className="size-5" />
        </button>
        <Link href="/dashboard" className="flex min-w-0 items-center gap-2 px-1">
          <BrandLockup name={branding?.name ?? "Chicorée"} logoDataUrl={branding?.logoDataUrl} size="sm" />
        </Link>
        <div className="ml-auto flex items-center">
          <Link href="/search" aria-label="Search" className={iconLink}>
            <Search className="size-5" />
          </Link>
          <Link href="/explore" aria-label="Explore" className={iconLink}>
            <Compass className="size-5" />
          </Link>
          <Link href="/settings" aria-label="Settings" className={iconLink}>
            <Settings className="size-5" />
          </Link>
        </div>
      </header>

      {open && (
        <div className="fixed inset-0 z-40 lg:hidden" role="presentation">
          <div
            className="absolute inset-0 animate-fade-in bg-overlay backdrop-blur-[2px]"
            onClick={() => setOpen(false)}
            aria-hidden
          />
          <div
            id="mobile-drawer"
            ref={panelRef}
            role="dialog"
            aria-modal="true"
            aria-label="Navigation"
            tabIndex={-1}
            className="absolute inset-y-0 left-0 flex w-[min(18rem,85vw)] animate-slide-in flex-col border-r border-line bg-card pb-[env(safe-area-inset-bottom)] shadow-card outline-none"
          >
            <button
              type="button"
              onClick={() => setOpen(false)}
              aria-label="Close navigation"
              className="absolute right-2 top-3 flex size-10 items-center justify-center rounded-lg text-ink-3 transition-colors hover:bg-card-2 hover:text-ink cursor-pointer"
            >
              <X className="size-5" />
            </button>
            <Sidebar orgs={orgs} orgCount={orgCount} user={user} isAdmin={isAdmin} branding={branding} canCreateOrgs={canCreateOrgs} />
          </div>
        </div>
      )}
    </>
  );
}
