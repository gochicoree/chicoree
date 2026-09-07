import Link from "next/link";
import { redirect } from "next/navigation";
import { ArrowRight, Fingerprint, Layers, ScanSearch, Users } from "lucide-react";
import { getSession } from "@/lib/session";
import { env } from "@/lib/env";
import { BrandLockup } from "@/components/brand";
import { buttonClasses } from "@/components/ui/button";
import { getBranding } from "@/lib/branding";
import { defaultTagline } from "@/lib/branding-shared";
import { formatBytes } from "@/lib/format";
import { getInstanceSettings } from "@/lib/instance-settings";
import { userDefaultsConfigured } from "@/lib/quota-shared";

// Landing: the docker-pull moment plus the layer strata — the two things this
// product is about. Signed-in users go straight to work.
export default async function LandingPage() {
  if (await getSession()) redirect("/dashboard");
  const [brand, settings] = await Promise.all([getBranding(), getInstanceSettings()]);
  // Invitation-only and closed instances do not advertise sign-up.
  const canSignUp = settings.access.signUpMode === "open";
  const hosted = brand.edition === "hosted";
  // What a new account gets, from the instance's default limits (Administration → Limits).
  const free = settings.quotas.user;
  const freeLine = hosted && userDefaultsConfigured(settings.quotas)
    ? [
        free.maxOrganizations !== null ? `${free.maxOrganizations} organization${free.maxOrganizations === 1 ? "" : "s"}` : "unlimited organizations",
        free.maxPrivateRepos !== null ? `${free.maxPrivateRepos} private repositories` : "unlimited private repositories",
        free.maxStorageBytes !== null ? `${formatBytes(free.maxStorageBytes).replace(/\.0 /, " ")} of storage` : "",
      ]
        .filter(Boolean)
        .join(", ")
    : null;
  const plansUrl = hosted && settings.portal.url ? settings.portal.url.replace(/\/handoff\/?$/, "") : null;

  // A believable image, drawn as proportional layer strata.
  const strata = [4, 18, 3, 41, 9, 26, 6, 13];

  return (
    <div className="min-h-dvh">
      <header className="mx-auto flex max-w-5xl items-center justify-between gap-3 px-4 py-4 sm:px-6 sm:py-5">
        <div className="flex min-w-0 items-center gap-2.5">
          <BrandLockup name={brand.instanceName} logoDataUrl={brand.logoDataUrl || undefined} size="lg" />
        </div>
        <nav className="flex items-center gap-2">
          <Link href="/explore" className={buttonClasses("ghost", "sm", "max-sm:hidden")}>
            Explore
          </Link>
          <Link href="/sign-in" className={buttonClasses(canSignUp ? "secondary" : "primary", "sm")}>
            Sign in
          </Link>
          {canSignUp && (
            <Link href="/sign-up" className={buttonClasses("primary", "sm")}>
              Get started
            </Link>
          )}
        </nav>
      </header>

      <main className="mx-auto max-w-5xl px-4 sm:px-6">
        <section className="grid items-center gap-10 py-10 sm:py-16 lg:grid-cols-2 lg:gap-12 lg:py-24">
          <div>
            <div className="eyebrow mb-3">{brand.tagline || defaultTagline(brand.edition)}</div>
            <h1 className="font-display text-4xl font-bold leading-[1.08] tracking-tight sm:text-5xl">
              Every layer,
              <br />
              accounted for.
            </h1>
            <p className="mt-4 max-w-md text-[15px] leading-relaxed text-ink-2">
              {hosted
                ? `${brand.instanceName} hosts your container images and Helm charts and shows you what's inside them: layers, sizes, platforms, vulnerabilities, chart values. Organizations, fine-grained access and CI credentials included; nothing to run yourself.`
                : `${brand.instanceName} stores your container images and Helm charts and shows you what's inside them: layers, sizes, platforms, vulnerabilities, chart values. Organizations, fine-grained access and CI credentials included.`}
            </p>
            {freeLine && (
              <p className="mt-3 max-w-md text-sm text-ink-2">
                <span className="font-medium text-ink">Free to start:</span> {freeLine}, unlimited public repositories. Upgrade when you grow.
              </p>
            )}
            <div className="mt-6 flex flex-wrap gap-2">
              {canSignUp ? (
                <Link href="/sign-up" className={buttonClasses("primary")}>
                  {hosted ? "Create your account" : "Create the first account"} <ArrowRight className="size-4" />
                </Link>
              ) : (
                <Link href="/sign-in" className={buttonClasses("primary")}>
                  Sign in <ArrowRight className="size-4" />
                </Link>
              )}
              <Link href="/explore" className={buttonClasses("secondary")}>
                Browse public images
              </Link>
              {plansUrl && (
                <a href={plansUrl} className={buttonClasses("ghost")}>
                  See plans
                </a>
              )}
            </div>
          </div>

          <div className="min-w-0 rounded-xl border border-line bg-card p-4 shadow-card sm:p-5">
            <div className="flex items-center gap-1.5 pb-3">
              <span className="size-2.5 rounded-full bg-line-2" />
              <span className="size-2.5 rounded-full bg-line-2" />
              <span className="size-2.5 rounded-full bg-line-2" />
            </div>
            <div className="space-y-1.5 font-mono text-[13px] leading-relaxed [overflow-wrap:anywhere]">
              <p>
                <span className="text-accent">$</span> docker pull {env.registryHost}/acme/api:1.4.2
              </p>
              <p className="text-ink-2">1.4.2: Pulling from acme/api</p>
              <p className="text-ink-2">
                Digest: <span className="text-ink">sha256:9f8e2a41c7b3</span>…
              </p>
              <p className="text-ok">Status: image is up to date</p>
              <p className="pt-1.5">
                <span className="text-accent">$</span> helm pull oci://{env.registryHost}/acme/api-chart --version 1.4.2
              </p>
              <p className="text-ok">Pulled: {env.registryHost}/acme/api-chart:1.4.2</p>
            </div>
            <div className="mt-5 border-t border-line pt-4">
              <div className="eyebrow mb-2">Cargo plan · 8 layers · 142 MiB</div>
              <div className="flex h-9 gap-0.5" aria-hidden>
                {strata.map((size, i) => (
                  <div
                    key={i}
                    className="rounded-[4px]"
                    style={{
                      flexGrow: size,
                      flexBasis: 0,
                      background: i % 2 === 0 ? "var(--chart-1)" : "var(--chart-1-soft)",
                    }}
                  />
                ))}
              </div>
            </div>
          </div>
        </section>

        <section className="grid gap-6 border-t border-line py-10 sm:grid-cols-2 sm:gap-4 sm:py-14 lg:grid-cols-4">
          {[
            {
              icon: Layers,
              title: "Images and Helm charts",
              text: "Layer-by-layer sizes, instructions and dedup savings for images; Chart.yaml, values and README for charts. One registry, one set of rules.",
            },
            {
              icon: ScanSearch,
              title: "Vulnerability scanning",
              text: "Every push is scanned for known vulnerabilities; CVE reports, search and accepted risks live next to the tag.",
            },
            {
              icon: Users,
              title: "Organizations",
              text: "Namespaces with roles, teams and per-repository access; public or private repositories.",
            },
            {
              icon: Fingerprint,
              title: hosted ? "Yours, safely" : "Modern sign-in",
              text: hosted
                ? "Passkeys, magic links and two-factor sign-in; service accounts and keyless CI credentials for your pipelines."
                : "Passkeys, magic links, TOTP and email codes, OAuth — plus service accounts for CI.",
            },
          ].map((f) => (
            <div key={f.title}>
              <f.icon className="size-5 text-accent" />
              <h2 className="mt-2.5 font-display text-[15px] font-semibold">{f.title}</h2>
              <p className="mt-1 text-sm leading-relaxed text-ink-2">{f.text}</p>
            </div>
          ))}
        </section>
      </main>

      <footer className="border-t border-line py-8 text-center text-xs text-ink-3">
        {brand.instanceName}
        {brand.tagline ? ` — ${brand.tagline}` : ""}
        {brand.footerLinks.length > 0 && (
          <span className="mt-2 flex flex-wrap justify-center gap-x-3 gap-y-1">
            {brand.footerLinks.map((l) => (
              <a key={`${l.label}-${l.url}`} href={l.url} className="hover:text-ink hover:underline">
                {l.label}
              </a>
            ))}
          </span>
        )}
      </footer>
    </div>
  );
}
