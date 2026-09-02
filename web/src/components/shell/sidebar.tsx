"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { clsx } from "clsx";
import {
  Compass,
  KeyRound,
  LayoutDashboard,
  LogOut,
  Plus,
  Settings,
  ShieldCheck,
  Container,
} from "lucide-react";
import { Chicory } from "@/components/brand";
import { authClient } from "@/lib/auth-client";

export interface NavOrg {
  slug: string;
  name: string;
}

function NavLink({
  href,
  active,
  children,
}: {
  href: string;
  active: boolean;
  children: React.ReactNode;
}) {
  return (
    <Link
      href={href}
      className={clsx(
        "flex items-center gap-2.5 rounded-lg px-2.5 py-2 text-[13.5px] font-medium transition-colors lg:py-1.5",
        active ? "bg-card-2 text-ink" : "text-ink-2 hover:bg-card-2 hover:text-ink",
      )}
    >
      {children}
    </Link>
  );
}

export function Sidebar({
  orgs,
  user,
  isAdmin,
}: {
  orgs: NavOrg[];
  user: { name: string; email: string };
  isAdmin: boolean;
}) {
  const pathname = usePathname();
  const router = useRouter();

  async function signOut() {
    await authClient.signOut();
    router.push("/sign-in");
    router.refresh();
  }

  return (
    <div className="flex h-full flex-col">
      <Link href="/dashboard" className="flex items-center gap-2.5 px-4 pb-5 pt-5">
        <Chicory className="size-6 text-brand" />
        <span className="font-display text-lg font-bold tracking-tight">Chicorée</span>
      </Link>

      <nav className="flex-1 space-y-6 overflow-y-auto px-2.5">
        <div className="space-y-0.5">
          <NavLink href="/dashboard" active={pathname === "/dashboard"}>
            <LayoutDashboard className="size-4" /> Dashboard
          </NavLink>
          <NavLink href="/explore" active={pathname === "/explore"}>
            <Compass className="size-4" /> Explore
          </NavLink>
        </div>

        <div>
          <div className="eyebrow mb-1.5 flex items-center justify-between px-2.5">
            <span>Organizations</span>
            <Link
              href="/orgs/new"
              aria-label="Create organization"
              className="rounded-md p-1 text-ink-3 hover:bg-card-2 hover:text-ink lg:p-0.5"
            >
              <Plus className="size-3.5" />
            </Link>
          </div>
          <div className="space-y-0.5">
            {orgs.map((org) => (
              <NavLink
                key={org.slug}
                href={`/${org.slug}`}
                active={pathname === `/${org.slug}` || pathname.startsWith(`/${org.slug}/`)}
              >
                <Container className="size-4" />
                <span className="truncate">{org.name}</span>
              </NavLink>
            ))}
            {orgs.length === 0 && (
              <Link
                href="/orgs/new"
                className="block rounded-lg border border-dashed border-line-2 px-2.5 py-2 text-[13px] text-ink-2 hover:border-ink-3 hover:text-ink"
              >
                Create your first organization
              </Link>
            )}
          </div>
        </div>

        <div className="space-y-0.5">
          <div className="eyebrow mb-1.5 px-2.5">Account</div>
          <NavLink href="/settings" active={pathname === "/settings" || pathname === "/settings/security"}>
            <Settings className="size-4" /> Settings
          </NavLink>
          <NavLink href="/settings/tokens" active={pathname === "/settings/tokens"}>
            <KeyRound className="size-4" /> Access tokens
          </NavLink>
          {isAdmin && (
            <NavLink href="/admin" active={pathname.startsWith("/admin")}>
              <ShieldCheck className="size-4" /> Administration
            </NavLink>
          )}
        </div>
      </nav>

      <div className="border-t border-line p-3">
        <div className="flex items-center gap-2.5 rounded-lg px-1.5 py-1">
          <div className="flex size-8 shrink-0 items-center justify-center rounded-full bg-action font-display text-sm font-semibold text-action-ink">
            {user.name.slice(0, 1).toUpperCase()}
          </div>
          <div className="min-w-0 flex-1">
            <div className="truncate text-[13px] font-medium">{user.name}</div>
            <div className="truncate text-xs text-ink-3">{user.email}</div>
          </div>
          <button
            onClick={signOut}
            aria-label="Sign out"
            className="rounded-md p-2 text-ink-3 transition-colors hover:bg-card-2 hover:text-ink cursor-pointer lg:p-1.5"
          >
            <LogOut className="size-4" />
          </button>
        </div>
      </div>
    </div>
  );
}
