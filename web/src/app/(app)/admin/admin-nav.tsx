import { NavTabs } from "@/components/ui/nav-tabs";

const items = [
  { href: "/admin", label: "Overview", exact: true },
  { href: "/admin/users", label: "Users" },
  { href: "/admin/organizations", label: "Organizations" },
  { href: "/admin/jobs", label: "Jobs" },
  { href: "/admin/metrics", label: "Metrics" },
  { href: "/admin/health", label: "Health" },
  { href: "/admin/audit", label: "Audit" },
  { href: "/admin/email", label: "Email" },
  { href: "/admin/auth", label: "Auth providers" },
  { href: "/admin/branding", label: "Branding" },
  { href: "/admin/settings/limits", label: "Rate limits" },
];

export function AdminNav() {
  return <NavTabs className="mb-6" items={items} />;
}
