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
 * Section tabs driven by the URL. "underline" is the primary level (org,
 * settings, admin); "pills" is the secondary level inside a section. On
 * narrow screens both scroll sideways instead of wrapping.
 */
export function NavTabs({
  items,
  className,
  variant = "underline",
}: {
  items: NavTab[];
  className?: string;
  variant?: "underline" | "pills";
}) {
  const pathname = usePathname();
  const pills = variant === "pills";
  return (
    <nav
      className={clsx(
        pills
          ? "flex max-w-full gap-1 overflow-x-auto rounded-lg border border-line bg-card-2 p-1 scrollbar-none sm:inline-flex"
          : "-mx-4 flex gap-1 overflow-x-auto border-b border-line px-4 scrollbar-none sm:mx-0 sm:px-0",
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
              "shrink-0 whitespace-nowrap font-medium transition-colors",
              pills
                ? clsx(
                    "rounded-md px-3 py-1.5 text-[13px]",
                    active ? "bg-card text-ink shadow-card" : "text-ink-2 hover:text-ink",
                  )
                : clsx(
                    "-mb-px border-b-2 px-3 py-2.5 text-sm sm:py-2",
                    active ? "border-accent text-ink" : "border-transparent text-ink-2 hover:border-line-2 hover:text-ink",
                  ),
            )}
          >
            {item.label}
          </Link>
        );
      })}
    </nav>
  );
}
