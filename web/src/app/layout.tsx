import type { Metadata, Viewport } from "next";
import "@fontsource-variable/bricolage-grotesque";
import "@fontsource-variable/public-sans";
import "@fontsource-variable/jetbrains-mono";
import "./globals.css";

export const metadata: Metadata = {
  title: {
    default: "Chicorée — container registry",
    template: "%s · Chicorée",
  },
  description:
    "Self-hosted OCI container registry with organizations, access control and vulnerability scanning.",
  applicationName: "Chicorée",
  appleWebApp: { title: "Chicorée", statusBarStyle: "default" },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  // Lets the shell paint under the notch / home indicator; components pad
  // with env(safe-area-inset-*) where it matters.
  viewportFit: "cover",
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#f2f5f6" },
    { media: "(prefers-color-scheme: dark)", color: "#0c191f" },
  ],
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body className="bg-paper text-ink antialiased">{children}</body>
    </html>
  );
}
