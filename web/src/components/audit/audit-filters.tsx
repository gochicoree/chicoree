import Link from "next/link";
import { Download, Search } from "lucide-react";
import { Button, buttonClasses } from "@/components/ui/button";
import { Card, CardBody } from "@/components/ui/card";
import { Input, Label } from "@/components/ui/field";
import { Select } from "@/components/ui/select";
import { AUDIT_ACTION_GROUPS, AUDIT_EXPORT_MAX, type AuditFilter } from "@/lib/audit-shared";

/**
 * GET form for the audit pages: text search, action group, organization,
 * date range. Plain form submission keeps the filter in the URL so it can be
 * shared and drives the CSV export link.
 */
export function AuditFilters({
  filter,
  basePath,
  organizations,
  exportHref,
}: {
  filter: AuditFilter;
  basePath: string;
  /** Omit on organization pages (the scope is fixed). */
  organizations?: { id: string; slug: string; name: string }[];
  exportHref: string;
}) {
  return (
    <Card className="mb-4">
      <CardBody>
        <form method="get" action={basePath} className="grid gap-3 sm:grid-cols-2 lg:grid-cols-[1.3fr_1fr_1fr_10rem_10rem]">
          <div className="min-w-0">
            <Label htmlFor="audit-q">Search</Label>
            <Input id="audit-q" name="q" defaultValue={filter.q} placeholder="actor, target, action, IP or id" />
          </div>
          <div className="min-w-0">
            <Label htmlFor="audit-action">Action</Label>
            <Select
              id="audit-action"
              name="action"
              defaultValue={filter.action}
              options={[{ value: "", label: "All actions" }, ...AUDIT_ACTION_GROUPS.map((g) => ({ value: g.prefix, label: g.label, description: `${g.prefix}.*` }))]}
            />
          </div>
          {organizations ? (
            <div className="min-w-0">
              <Label htmlFor="audit-org">Organization</Label>
              <Select
                id="audit-org"
                name="org"
                defaultValue={filter.organizationId}
                options={[{ value: "", label: "All organizations" }, ...organizations.map((o) => ({ value: o.id, label: o.slug, description: o.name }))]}
              />
            </div>
          ) : (
            <div className="hidden lg:block" />
          )}
          <div className="min-w-0">
            <Label htmlFor="audit-from">From</Label>
            <Input id="audit-from" name="from" type="date" defaultValue={filter.from} className="font-mono" />
          </div>
          <div className="min-w-0">
            <Label htmlFor="audit-to">To</Label>
            <Input id="audit-to" name="to" type="date" defaultValue={filter.to} className="font-mono" />
          </div>
          <div className="flex flex-wrap items-end gap-2 sm:col-span-2 lg:col-span-5">
            <Button type="submit" size="md">
              <Search className="size-4" /> Filter
            </Button>
            <Link href={basePath} className={buttonClasses("ghost", "md")}>
              Reset
            </Link>
            <a href={exportHref} className={buttonClasses("secondary", "md")} title={`Download the current filter as CSV (up to ${AUDIT_EXPORT_MAX.toLocaleString("en-US")} rows)`}>
              <Download className="size-4" /> Export CSV
            </a>
          </div>
        </form>
      </CardBody>
    </Card>
  );
}
