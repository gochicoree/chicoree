import Link from "next/link";
import { BookOpen, ExternalLink, FileText, Pencil } from "lucide-react";
import type { ImageAbout } from "@/lib/readme";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { buttonClasses } from "@/components/ui/button";
import "./readme.css";

/**
 * The README card on the repository page. With a README: the rendered
 * Markdown. Without one: an "About" block from the image's OCI annotations /
 * labels, or — for people who can edit — a nudge to write one.
 */
export function ReadmeCard({
  html,
  about,
  canEdit,
  settingsHref,
}: {
  /** Sanitized HTML from lib/readme.ts, or null when no README is set. */
  html: string | null;
  about: ImageAbout | null;
  canEdit: boolean;
  settingsHref: string;
}) {
  const editLink = canEdit ? (
    <Link href={settingsHref} className={buttonClasses("ghost", "sm")}>
      <Pencil className="size-3.5" /> Edit
    </Link>
  ) : undefined;

  if (html && html.trim()) {
    return (
      <Card>
        <CardHeader eyebrow="Documentation" title="README" action={editLink} />
        <CardBody>
          <article className="markdown" data-readme dangerouslySetInnerHTML={{ __html: html }} />
        </CardBody>
      </Card>
    );
  }

  if (about) {
    const facts: [string, string | undefined][] = [
      ["Title", about.title],
      ["Version", about.version],
      ["Vendor", about.vendor],
      ["Licenses", about.licenses],
      ["Authors", about.authors],
    ];
    return (
      <Card>
        <CardHeader
          eyebrow="Image metadata"
          title="About"
          description={`From the org.opencontainers.image.* labels and annotations of :${about.tag}.`}
          action={editLink}
        />
        <CardBody className="space-y-3" data-about>
          {about.description && <p className="text-sm text-ink">{about.description}</p>}
          {facts.some(([, v]) => v) && (
            <dl className="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-2 lg:grid-cols-3">
              {facts
                .filter(([, v]) => v)
                .map(([label, value]) => (
                  <div key={label} className="min-w-0">
                    <dt className="eyebrow mb-0.5">{label}</dt>
                    <dd className="break-words text-ink-2">{value}</dd>
                  </div>
                ))}
            </dl>
          )}
          {about.links.length > 0 && (
            <ul className="flex flex-wrap gap-2">
              {about.links.map((l) => (
                <li key={l.url}>
                  <a href={l.url} rel="nofollow noopener" target="_blank" className={buttonClasses("secondary", "sm")}>
                    {l.label === "Documentation" ? <BookOpen className="size-3.5" /> : <ExternalLink className="size-3.5" />}
                    {l.label}
                  </a>
                </li>
              ))}
            </ul>
          )}
        </CardBody>
      </Card>
    );
  }

  if (!canEdit) return null;
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-dashed border-line px-4 py-4 text-sm text-ink-2" data-readme-empty>
      <span className="inline-flex items-center gap-2">
        <FileText className="size-4 text-ink-3" /> No README yet. Describe how to run this image and which tags to use.
      </span>
      <Link href={settingsHref} className={buttonClasses("secondary", "sm")}>
        Write a README
      </Link>
    </div>
  );
}
