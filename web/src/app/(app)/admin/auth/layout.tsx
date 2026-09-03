import { requireAdmin } from "@/lib/session";
import { PageHeader } from "@/components/page-header";
import { NavTabs } from "@/components/ui/nav-tabs";
import { AdminNav } from "../admin-nav";

export default async function AdminAuthLayout({ children }: { children: React.ReactNode }) {
  await requireAdmin();
  return (
    <>
      <PageHeader
        eyebrow="Instance"
        title="Administration"
        description="Sign-in providers, directory access, group-based roles and who may register. Values saved here apply immediately and override the environment."
      />
      <AdminNav />
      <NavTabs
        variant="pills"
        className="mb-6"
        items={[
          { href: "/admin/auth", label: "Sign-in providers", exact: true },
          { href: "/admin/auth/ldap", label: "LDAP" },
          { href: "/admin/auth/bindings", label: "Group bindings" },
          { href: "/admin/auth/access", label: "Access" },
        ]}
      />
      {children}
    </>
  );
}
