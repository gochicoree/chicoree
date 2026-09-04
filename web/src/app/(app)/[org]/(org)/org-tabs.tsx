import { NavTabs } from "@/components/ui/nav-tabs";

export function OrgTabs({
  slug,
  canManage,
  isMember,
}: {
  slug: string;
  canManage: boolean;
  isMember: boolean;
}) {
  const tabs = [
    { href: `/${slug}`, label: "Repositories", show: true, exact: true },
    { href: `/${slug}/security`, label: "Security", show: isMember },
    { href: `/${slug}/members`, label: "Members", show: isMember },
    { href: `/${slug}/service-accounts`, label: "Service accounts", show: canManage },
    { href: `/${slug}/audit`, label: "Audit", show: canManage },
    { href: `/${slug}/settings`, label: "Settings", show: canManage },
  ];
  return <NavTabs className="mt-5" items={tabs.filter((t) => t.show)} />;
}
