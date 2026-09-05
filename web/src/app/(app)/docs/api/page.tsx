import type { Metadata } from "next";
import Link from "next/link";
import { FileJson } from "lucide-react";
import { PageHeader } from "@/components/page-header";
import { buttonClasses } from "@/components/ui/button";
import { Card, CardBody } from "@/components/ui/card";
import { Tabs } from "@/components/ui/tabs";
import { API_CATALOG } from "@/lib/api/catalog";
import { apiDocsMarkdown } from "@/lib/api/docs";
import { renderApiDocs } from "@/lib/api/docs-html";
import { API_BASE, API_NOTICE, API_REVISION } from "@/lib/api/version";
import { getBranding } from "@/lib/branding";
import { env } from "@/lib/env";
import { ApiBrowser } from "./api-browser";
import "@/components/readme/readme.css";

export const metadata: Metadata = { title: "REST API" };

/**
 * The API documentation: an interactive browser over the endpoint catalog
 * (with real requests against this instance) and the written guide. Both
 * are rendered from lib/api/*, so they cannot drift from the handlers.
 */
export default async function ApiDocsPage() {
  const branding = await getBranding();
  const appUrl = env.appUrl.replace(/\/$/, "");
  const guide = renderApiDocs(
    apiDocsMarkdown({ appUrl, registryHost: env.registryHost, instanceName: branding.instanceName, inApp: true, endpoints: false }),
  );
  const openApiUrl = `${API_BASE}/openapi.json`;

  return (
    <>
      <PageHeader
        eyebrow="Documentation"
        title="REST API"
        description={
          <>
            Revision <code className="font-mono text-xs">{API_REVISION}</code> · {API_NOTICE}
          </>
        }
        action={
          <>
            <Link href={API_BASE} className={buttonClasses("secondary", "sm")} prefetch={false}>
              GET {API_BASE}
            </Link>
            <a href={openApiUrl} className={buttonClasses("secondary", "sm")}>
              <FileJson className="size-3.5" /> OpenAPI
            </a>
          </>
        }
      />
      <Tabs
        tabs={[
          {
            label: "Browse & try",
            badge: API_CATALOG.length,
            content: <ApiBrowser endpoints={API_CATALOG} appUrl={appUrl} base={API_BASE} />,
          },
          {
            label: "Guide",
            content: (
              <Card>
                <CardBody>
                  <article className="markdown" dangerouslySetInnerHTML={{ __html: guide }} />
                </CardBody>
              </Card>
            ),
          },
        ]}
      />
    </>
  );
}
