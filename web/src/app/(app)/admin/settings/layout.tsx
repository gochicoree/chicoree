import { requireAdmin } from "@/lib/session";
import { PageHeader } from "@/components/page-header";
import { NavTabs } from "@/components/ui/nav-tabs";
import { AdminNav } from "../admin-nav";

export default async function AdminSettingsLayout({ children }: { children: React.ReactNode }) {
  await requireAdmin();
  return (
    <>
      <PageHeader
        eyebrow="Instance"
        title="Administration"
        description="Email, sign-in providers and directory settings. Values saved here apply immediately and override the environment."
      />
      <AdminNav />
      <NavTabs
        variant="pills"
        className="mb-6"
        items={[
          { href: "/admin/settings", label: "Email", exact: true },
          { href: "/admin/settings/providers", label: "Sign-in providers" },
          { href: "/admin/settings/ldap", label: "LDAP" },
          { href: "/admin/settings/bindings", label: "Group bindings" },
        ]}
      />
      {children}
    </>
  );
}
