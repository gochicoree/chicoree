"use client";

import { useRouter } from "next/navigation";
import { UserCog } from "lucide-react";
import { authClient } from "@/lib/auth-client";

/** Shown across the top of every page while an admin impersonates a user. */
export function ImpersonationBanner({ userName, userEmail }: { userName: string; userEmail: string }) {
  const router = useRouter();
  async function stop() {
    await authClient.admin.stopImpersonating();
    router.push("/admin/users");
    router.refresh();
  }
  return (
    <div className="flex items-center justify-between gap-3 border-b border-accent/40 bg-accent-soft px-4 py-2 text-sm text-accent-ink">
      <span className="flex min-w-0 items-center gap-2">
        <UserCog className="size-4 shrink-0" />
        <span className="truncate">
          Impersonating <strong>{userName}</strong>
          <span className="hidden sm:inline"> ({userEmail}). Actions are performed as them.</span>
        </span>
      </span>
      <button
        onClick={stop}
        className="shrink-0 rounded-md border border-accent/50 bg-card px-2.5 py-1 text-[13px] font-medium text-ink hover:bg-card-2 cursor-pointer"
      >
        Stop<span className="hidden sm:inline"> impersonating</span>
      </button>
    </div>
  );
}
