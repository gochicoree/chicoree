"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Search } from "lucide-react";
import { Select } from "@/components/ui/select";
import { Button } from "@/components/ui/button";

export interface ExploreQuery {
  q: string;
  org: string;
  visibility: string;
  sort: string;
  /** "all" keeps the filterable list even with every filter at its default. */
  view?: string;
}

function exploreHref(v: ExploreQuery): string {
  const p = new URLSearchParams();
  if (v.view === "all") p.set("view", "all");
  if (v.q) p.set("q", v.q);
  if (v.org) p.set("org", v.org);
  if (v.visibility && v.visibility !== "all") p.set("visibility", v.visibility);
  if (v.sort && v.sort !== "pulls") p.set("sort", v.sort);
  const qs = p.toString();
  return qs ? `/explore?${qs}` : "/explore";
}

/**
 * Search field plus organization / visibility / sort filters. Selects apply
 * immediately; the text field on Enter. Everything lives in the URL, so a
 * filtered view can be linked, and the form degrades to a plain GET.
 */
export function ExploreFilters({
  value,
  orgs,
  showVisibility,
}: {
  value: ExploreQuery;
  orgs: { slug: string; name: string }[];
  /** Signed-in viewers can see private repositories, so the filter makes sense for them. */
  showVisibility: boolean;
}) {
  const router = useRouter();
  const [q, setQ] = useState(value.q);

  function apply(next: Partial<ExploreQuery>) {
    router.push(exploreHref({ ...value, q, ...next }));
  }

  return (
    <form
      method="get"
      action="/explore"
      className="mb-5 flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center"
      onSubmit={(e) => {
        e.preventDefault();
        apply({ q });
      }}
    >
      {value.view === "all" && <input type="hidden" name="view" value="all" />}
      <div className="relative min-w-0 flex-1 sm:min-w-56">
        <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-ink-3" aria-hidden />
        <input
          type="search"
          name="q"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Filter by name or description"
          aria-label="Filter repositories"
          autoComplete="off"
          className="h-9.5 w-full rounded-lg border border-line-2 bg-card pl-9 pr-3 text-base text-ink placeholder:text-ink-3 focus:border-action focus:outline-none focus:ring-2 focus:ring-action/15 sm:text-sm [&::-webkit-search-cancel-button]:hidden"
        />
      </div>
      <Select
        name="org"
        aria-label="Organization"
        value={value.org}
        onChange={(org) => apply({ org })}
        options={[{ value: "", label: "All organizations" }, ...orgs.map((o) => ({ value: o.slug, label: o.name, description: o.slug }))]}
        className="sm:w-52"
      />
      {showVisibility && (
        <Select
          name="visibility"
          aria-label="Visibility"
          value={value.visibility || "all"}
          onChange={(visibility) => apply({ visibility })}
          options={[
            { value: "all", label: "Public and private" },
            { value: "public", label: "Public only" },
            { value: "private", label: "Private only" },
          ]}
          className="sm:w-44"
        />
      )}
      <Select
        name="sort"
        aria-label="Sort"
        value={value.sort || "pulls"}
        onChange={(sort) => apply({ sort })}
        options={[
          { value: "pulls", label: "Most pulled" },
          { value: "updated", label: "Recently updated" },
          { value: "name", label: "Name A–Z" },
        ]}
        className="sm:w-44"
      />
      <Button type="submit" variant="secondary" className="sm:hidden">
        Apply
      </Button>
    </form>
  );
}
