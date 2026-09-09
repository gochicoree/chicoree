import { getSession } from "@/lib/session";
import { listNavOrgs } from "@/lib/data";
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
import { buildLabel } from "@/lib/build-info";
import { logoVersionOf, userLogoVersion } from "@/lib/logo";
import { logoRef } from "@/lib/logo-shared";

/**
 * The signed-in shell. Visitors without a session get it too, reduced to
 * Explore, search and the API docs, so public organizations and repositories
 * can be browsed without an account; every page that needs a user asks for
 * one itself (requireSession) and sends visitors to sign-in.
 */
export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const session = await getSession();
  if (session?.user.role === "admin") await ensureLibraryOrg(session.user.id);
  const [nav0rgs, settings, branding] = await Promise.all([
    session ? listNavOrgs(session.user.id) : Promise.resolve({ orgs: [], total: 0 }),
    getInstanceSettings(),
    getBranding(),
  ]);
  const impersonating = !!session?.session.impersonatedBy;
  const announcement = branding.announcement;

  const nav = {
    orgs: nav0rgs.orgs.map((o) => ({ slug: o.slug, name: o.name, logo: logoRef("organization", o.id, o.logoVersion) })),
    orgCount: nav0rgs.total,
    user: session
      ? {
          name: session.user.name,
          email: session.user.email,
          logo: logoRef("user", session.user.id, userLogoVersion(session.user, branding.gravatar)),
        }
      : null,
    isAdmin: session?.user.role === "admin",
    branding: { name: branding.instanceName, logoDataUrl: branding.logoDataUrl || undefined },
    canCreateOrgs: session ? canCreateOrganization(settings.access, session.user.role) : false,
    canSignUp: settings.access.signUpMode === "open",
    // While the API is off, its entry and pages disappear for everyone (the switch is under Administration → Access).
    showApi: settings.access.apiEnabled,
  };

  return (
    <div className="flex min-h-dvh flex-col">
      {impersonating && session && <ImpersonationBanner userName={session.user.name} userEmail={session.user.email} />}
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
          <main className="mx-auto w-full max-w-[110rem] px-4 py-5 pb-[max(1.25rem,env(safe-area-inset-bottom))] sm:px-6 sm:py-8 lg:px-8">
            {children}
            <AppFooter name={branding.instanceName} tagline={branding.tagline} build={buildLabel()} links={branding.footerLinks} />
          </main>
        </div>
      </div>
    </div>
  );
}
