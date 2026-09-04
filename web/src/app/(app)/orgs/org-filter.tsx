"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Search } from "lucide-react";
import { Input } from "@/components/ui/field";

/** Filters the organization list through the URL, so the page stays shareable. */
export function OrgFilter({ initial }: { initial: string }) {
  const router = useRouter();
  const [q, setQ] = useState(initial);
  return (
    <form
      className="mb-4 flex max-w-md items-center gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        router.push(q.trim() ? `/orgs?q=${encodeURIComponent(q.trim())}` : "/orgs");
      }}
    >
      <div className="relative flex-1">
        <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-ink-3" />
        <Input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Filter organizations…"
          aria-label="Filter organizations"
          className="pl-8"
        />
      </div>
    </form>
  );
}
