import type { FooterLink } from "@/lib/branding-shared";

/** Small footer under every app page: instance name, tagline, the build this instance runs, and the admin's links. */
export function AppFooter({
  name,
  tagline,
  build = "",
  links,
}: {
  name: string;
  tagline: string;
  /** Version and commit the web app was built from (lib/build-info.ts); empty in development. */
  build?: string;
  links: FooterLink[];
}) {
  return (
    <footer className="mt-10 flex flex-wrap items-center gap-x-4 gap-y-1 border-t border-line pt-4 text-xs text-ink-3">
      <span className="min-w-0">
        <span className="font-medium text-ink-2">{name}</span>
        {tagline && <span> · {tagline}</span>}
        {build && (
          <span title="The build this instance runs">
            {" "}· <span className="font-mono">{build}</span>
          </span>
        )}
      </span>
      {links.length > 0 && (
        <nav className="flex flex-wrap items-center gap-x-3 gap-y-1 sm:ml-auto" aria-label="Footer">
          {links.map((l) => (
            <a
              key={`${l.label}-${l.url}`}
              href={l.url}
              className="hover:text-ink hover:underline"
              {...(/^https?:\/\//i.test(l.url) ? { target: "_blank", rel: "noreferrer" } : {})}
            >
              {l.label}
            </a>
          ))}
        </nav>
      )}
    </footer>
  );
}
