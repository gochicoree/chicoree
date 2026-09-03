import { NavTabs } from "@/components/ui/nav-tabs";
import { orgSettingsContext } from "./context";

export default async function OrgSettingsLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ org: string }>;
}) {
  const { base, canDelete, library } = await orgSettingsContext(params);
  return (
    <div>
      <NavTabs
        variant="pills"
        className="mb-6"
        items={[
          { href: base, label: "General", exact: true },
          { href: `${base}/policies`, label: "Policies" },
          ...(library ? [] : [{ href: `${base}/proxy`, label: "Proxy" }]),
          ...(canDelete ? [{ href: `${base}/danger`, label: "Danger zone" }] : []),
        ]}
      />
      {children}
    </div>
  );
}
