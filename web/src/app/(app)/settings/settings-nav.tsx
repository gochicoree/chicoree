import { NavTabs } from "@/components/ui/nav-tabs";

const items = [
  { href: "/settings", label: "Profile", exact: true },
  { href: "/settings/security", label: "Security" },
  { href: "/settings/notifications", label: "Notifications" },
  { href: "/settings/tokens", label: "Access tokens" },
  { href: "/settings/signing-keys", label: "Signing keys" },
];

export function SettingsNav() {
  return <NavTabs className="mb-6" items={items} />;
}
