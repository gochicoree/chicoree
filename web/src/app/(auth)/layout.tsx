import Link from "next/link";
import { BrandLockup } from "@/components/brand";
import { AnnouncementBar } from "@/components/shell/announcement-bar";
import { getBranding } from "@/lib/branding";
import { announcementDismissible, announcementHash } from "@/lib/branding-shared";

// Auth screens: a quiet centered column with the wordmark above the card.
export default async function AuthLayout({ children }: { children: React.ReactNode }) {
  const b = await getBranding();
  const a = b.announcement;
  return (
    <div className="flex min-h-dvh flex-col">
      {a.enabled && a.text && (
        <AnnouncementBar level={a.level} text={a.text} dismissible={announcementDismissible(a)} hash={announcementHash(a)} />
      )}
      <div className="flex flex-1 flex-col items-center px-4 py-10 sm:justify-center sm:py-16">
        <Link href="/" className="mb-8 flex items-center gap-2.5">
          <BrandLockup name={b.instanceName} logoDataUrl={b.logoDataUrl || undefined} size="lg" />
        </Link>
        <div className="w-full max-w-sm">{children}</div>
        {b.tagline && <p className="mt-10 text-xs text-ink-3">{b.tagline}</p>}
      </div>
    </div>
  );
}
