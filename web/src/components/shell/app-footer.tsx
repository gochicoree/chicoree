import type { FooterLink } from "@/lib/branding-shared";

/** Small footer under every app page: instance name, tagline and the admin's links. */
export function AppFooter({ name, tagline, links }: { name: string; tagline: string; links: FooterLink[] }) {
  return (
    <footer className="mt-10 flex flex-wrap items-center gap-x-4 gap-y-1 border-t border-line pt-4 text-xs text-ink-3">
      <span className="min-w-0">
        <span className="font-medium text-ink-2">{name}</span>
        {tagline && <span> · {tagline}</span>}
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
