import Link from "next/link";
import { Chicory } from "@/components/brand";
import { buttonClasses } from "@/components/ui/button";

export default function NotFound() {
  return (
    <div className="flex min-h-dvh flex-col items-center justify-center px-6 text-center">
      <Chicory className="size-10 text-ink-3" />
      <p className="eyebrow mt-6">404 · Manifest unknown</p>
      <h1 className="mt-2 font-display text-3xl font-bold tracking-tight">
        Nothing at this address
      </h1>
      <p className="mt-3 max-w-md text-sm leading-relaxed text-ink-2">
        The page, repository or tag you're looking for doesn't exist — or it's in a private
        repository your account can't see. Check the path for typos, or sign in with an account
        that has access.
      </p>
      <div className="mt-6 flex flex-wrap justify-center gap-2">
        <Link href="/dashboard" className={buttonClasses("primary")}>
          Go to dashboard
        </Link>
        <Link href="/explore" className={buttonClasses("secondary")}>
          Explore public images
        </Link>
      </div>
    </div>
  );
}
