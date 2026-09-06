import type { CSSProperties } from "react";
import type { Metadata, Viewport } from "next";
import "@fontsource-variable/bricolage-grotesque";
import "@fontsource-variable/public-sans";
import "@fontsource-variable/jetbrains-mono";
import "./globals.css";
import { ToastProvider } from "@/components/ui/toast";
import { getBranding } from "@/lib/branding";

// Title, application name and the brand colour follow Administration → Branding.
export async function generateMetadata(): Promise<Metadata> {
  const b = await getBranding();
  return {
    title: {
      default: `${b.instanceName} — container registry`,
      template: `%s · ${b.instanceName}`,
    },
    description:
      b.tagline ||
      (b.edition === "hosted"
        ? "Hosted OCI container registry with organizations, access control and vulnerability scanning."
        : "Self-hosted OCI container registry with organizations, access control and vulnerability scanning."),
    applicationName: b.instanceName,
    appleWebApp: { title: b.instanceName, statusBarStyle: "default" },
  };
}

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

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const b = await getBranding();
  // The accent colour overrides the --brand token (the mark and brand tints).
  const style = b.accentColor ? ({ "--brand": b.accentColor } as CSSProperties) : undefined;
  return (
    <html lang="en" suppressHydrationWarning>
      <body className="bg-paper text-ink antialiased" style={style} data-instance={b.instanceName}>
        <ToastProvider>{children}</ToastProvider>
      </body>
    </html>
  );
}
