"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { clsx } from "clsx";

export interface NavTab {
  href: string;
  label: string;
  /** Match only the exact path (for index tabs whose href prefixes the others). */
  exact?: boolean;
}

/**
 * Underlined section tabs driven by the URL. On narrow screens the strip
 * scrolls sideways and bleeds to the screen edge instead of wrapping.
 */
export function NavTabs({ items, className }: { items: NavTab[]; className?: string }) {
  const pathname = usePathname();
  return (
    <nav
      className={clsx(
        "-mx-4 flex gap-1 overflow-x-auto border-b border-line px-4 scrollbar-none sm:mx-0 sm:px-0",
        className,
      )}
    >
      {items.map((item) => {
        const active = item.exact
          ? pathname === item.href
          : pathname === item.href || pathname.startsWith(`${item.href}/`);
        return (
          <Link
            key={item.href}
            href={item.href}
            aria-current={active ? "page" : undefined}
            className={clsx(
              "-mb-px shrink-0 whitespace-nowrap border-b-2 px-3 py-2.5 text-sm font-medium transition-colors sm:py-2",
              active ? "border-accent text-ink" : "border-transparent text-ink-2 hover:border-line-2 hover:text-ink",
            )}
          >
            {item.label}
          </Link>
        );
      })}
    </nav>
  );
}
