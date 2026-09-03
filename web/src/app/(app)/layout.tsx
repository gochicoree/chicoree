import { requireSession } from "@/lib/session";
import { listUserOrgs } from "@/lib/data";
import { Sidebar } from "@/components/shell/sidebar";
import { MobileNav } from "@/components/shell/mobile-nav";
import { ImpersonationBanner } from "@/components/shell/impersonation-banner";
import { AnnouncementBar } from "@/components/shell/announcement-bar";
import { AppFooter } from "@/components/shell/app-footer";
import { ensureLibraryOrg } from "@/lib/library";
import { getBranding } from "@/lib/branding";
import { getInstanceSettings } from "@/lib/instance-settings";
import { canCreateOrganization } from "@/lib/signup-policy";
import { announcementDismissible, announcementHash } from "@/lib/branding-shared";

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const session = await requireSession();
  if (session.user.role === "admin") await ensureLibraryOrg(session.user.id);
  const [orgs, settings, branding] = await Promise.all([listUserOrgs(session.user.id), getInstanceSettings(), getBranding()]);
  const impersonating = !!session.session.impersonatedBy;
  const announcement = branding.announcement;

  const nav = {
    orgs: orgs.map((o) => ({ slug: o.slug, name: o.name })),
    user: { name: session.user.name, email: session.user.email },
    isAdmin: session.user.role === "admin",
    branding: { name: branding.instanceName, logoDataUrl: branding.logoDataUrl || undefined },
    canCreateOrgs: canCreateOrganization(settings.access, session.user.role),
  };

  return (
    <div className="flex min-h-dvh flex-col">
      {impersonating && <ImpersonationBanner userName={session.user.name} userEmail={session.user.email} />}
      <div className="flex flex-1">
        <aside
          className={`fixed bottom-0 left-0 z-20 hidden w-60 border-r border-line bg-card lg:block ${impersonating ? "top-10" : "top-0"}`}
        >
          <Sidebar {...nav} />
        </aside>
        <div className="min-w-0 flex-1 lg:pl-60">
          <MobileNav {...nav} />
          {announcement.enabled && announcement.text && (
            <AnnouncementBar
              level={announcement.level}
              text={announcement.text}
              dismissible={announcementDismissible(announcement)}
              hash={announcementHash(announcement)}
            />
          )}
          <main className="mx-auto w-full max-w-6xl px-4 py-5 pb-[max(1.25rem,env(safe-area-inset-bottom))] sm:px-6 sm:py-8 lg:px-8">
            {children}
            <AppFooter name={branding.instanceName} tagline={branding.tagline} links={branding.footerLinks} />
          </main>
        </div>
      </div>
    </div>
  );
}
