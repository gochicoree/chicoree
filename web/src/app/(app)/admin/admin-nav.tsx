import { NavTabs } from "@/components/ui/nav-tabs";

const items = [
  { href: "/admin", label: "Overview", exact: true },
  { href: "/admin/users", label: "Users" },
  { href: "/admin/organizations", label: "Organizations" },
  { href: "/admin/jobs", label: "Jobs" },
  { href: "/admin/settings", label: "Settings" },
];

export function AdminNav() {
  return <NavTabs className="mb-6" items={items} />;
}
