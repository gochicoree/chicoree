import Link from "next/link";
import { Chicory } from "@/components/brand";

// Auth screens: a quiet centered column with the wordmark above the card.
export default function AuthLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-dvh flex-col items-center px-4 py-10 sm:justify-center sm:py-16">
      <Link href="/" className="mb-8 flex items-center gap-2.5">
        <Chicory className="size-7 text-brand" />
        <span className="font-display text-xl font-bold tracking-tight">Chicorée</span>
      </Link>
      <div className="w-full max-w-sm">{children}</div>
      <p className="mt-10 text-xs text-ink-3">Self-hosted OCI container registry</p>
    </div>
  );
}
