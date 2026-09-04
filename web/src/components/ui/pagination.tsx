import Link from "next/link";
import { clsx } from "clsx";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { pageHref, pageWindow, rangeLabel, type PageState, type QueryLike } from "@/lib/paginate-shared";

/**
 * One pagination control for every list in the app.
 *
 * Server-rendered lists pass `basePath` (plus the page's search params) and
 * page through the URL, so a page is linkable and survives a reload; lists
 * that filter in the browser pass `onPage` instead and page in the component.
 * The component itself holds no state and uses no hooks, so it renders in
 * both server and client components.
 */
export interface PaginationProps {
  state: PageState;
  /** Word for the rows: "entries", "findings", "tags"… */
  noun?: string;
  /** URL mode: the path pages link to. */
  basePath?: string;
  /** URL mode: the other query parameters to keep (filters, tabs, sibling lists). */
  params?: QueryLike;
  /** URL mode: the search parameter carrying the page (default "page"). */
  paramKey?: string;
  /** Component mode: called with the new page instead of navigating. */
  onPage?: (page: number) => void;
  /** Rows-per-page choices; needs onPageSize. */
  pageSizeOptions?: readonly number[];
  onPageSize?: (size: number) => void;
  /** Render even with a single page (keeps the row count visible). */
  always?: boolean;
  className?: string;
  /** Accessible name, when a screen has more than one control. */
  label?: string;
}

const stepBase =
  "inline-flex h-8 items-center gap-1 rounded-lg border border-line-2 bg-card px-2.5 text-[13px] font-medium text-ink transition-colors pointer-coarse:h-9";
const stepOn = "hover:bg-card-2 hover:border-ink-3 cursor-pointer";
const stepOff = "opacity-40 pointer-events-none";
const numBase =
  "inline-flex h-8 min-w-8 items-center justify-center rounded-lg px-2 font-mono text-[13px] tabular-nums transition-colors";

export function Pagination({
  state,
  noun = "rows",
  basePath,
  params,
  paramKey = "page",
  onPage,
  pageSizeOptions,
  onPageSize,
  always = false,
  className,
  label = "Pagination",
}: PaginationProps) {
  const { page, pages } = state;
  if (pages <= 1 && !always && !pageSizeOptions) return null;
  const href = (p: number) => pageHref(basePath ?? "", params, p, paramKey);

  function Step({ to, disabled, children, name }: { to: number; disabled: boolean; children: React.ReactNode; name: string }) {
    if (disabled) {
      return (
        <span aria-disabled="true" aria-label={name} className={clsx(stepBase, stepOff)}>
          {children}
        </span>
      );
    }
    if (onPage) {
      return (
        <button type="button" aria-label={name} onClick={() => onPage(to)} className={clsx(stepBase, stepOn)}>
          {children}
        </button>
      );
    }
    return (
      <Link href={href(to)} aria-label={name} className={clsx(stepBase, stepOn)}>
        {children}
      </Link>
    );
  }

  function Num({ to }: { to: number }) {
    const current = to === page;
    const cls = clsx(numBase, current ? "bg-card-2 font-semibold text-ink ring-1 ring-line-2" : "text-ink-2 hover:bg-card-2 hover:text-ink cursor-pointer");
    if (current) {
      return (
        <span aria-current="page" className={cls}>
          {to}
        </span>
      );
    }
    if (onPage) {
      return (
        <button type="button" aria-label={`Page ${to}`} onClick={() => onPage(to)} className={cls}>
          {to}
        </button>
      );
    }
    return (
      <Link href={href(to)} aria-label={`Page ${to}`} className={cls}>
        {to}
      </Link>
    );
  }

  return (
    <nav
      aria-label={label}
      data-pagination
      data-page={page}
      data-pages={pages}
      data-total={state.total}
      className={clsx("flex flex-wrap items-center justify-between gap-x-3 gap-y-2", className)}
    >
      <p data-pagination-range className="min-w-0 text-xs text-ink-3">
        {rangeLabel(state, noun)}
      </p>
      <div className="flex flex-wrap items-center gap-1.5">
        {pageSizeOptions && onPageSize && (
          <label className="mr-1 inline-flex items-center gap-1.5 text-xs text-ink-3">
            <span className="max-sm:sr-only">Rows</span>
            <select
              aria-label="Rows per page"
              value={state.pageSize}
              onChange={(e) => onPageSize(Number(e.target.value))}
              className="h-8 rounded-lg border border-line-2 bg-card px-1.5 font-mono text-[13px] text-ink focus:border-action focus:outline-none focus:ring-2 focus:ring-action/15 pointer-coarse:h-9"
            >
              {pageSizeOptions.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
          </label>
        )}
        {pages > 1 && (
          <>
            <Step to={page - 1} disabled={!state.hasPrev} name="Previous page">
              <ChevronLeft className="size-4" />
              <span className="max-sm:sr-only">Previous</span>
            </Step>
            <span className="hidden items-center gap-1 sm:flex">
              {pageWindow(page, pages).map((p, i) =>
                p === 0 ? (
                  <span key={`gap-${i}`} aria-hidden className="px-0.5 text-xs text-ink-3">
                    …
                  </span>
                ) : (
                  <Num key={p} to={p} />
                ),
              )}
            </span>
            <span className="font-mono text-xs tabular-nums text-ink-3 sm:hidden">
              {page}/{pages}
            </span>
            <Step to={page + 1} disabled={!state.hasNext} name="Next page">
              <span className="max-sm:sr-only">Next</span>
              <ChevronRight className="size-4" />
            </Step>
          </>
        )}
      </div>
    </nav>
  );
}

/** The control as a card footer — the usual place for it under a table. */
export function PaginationFooter(props: PaginationProps) {
  const { pages } = props.state;
  if (pages <= 1 && !props.always && !props.pageSizeOptions) return null;
  return (
    <div className="border-t border-line px-4 py-2.5 sm:px-5">
      <Pagination {...props} />
    </div>
  );
}
