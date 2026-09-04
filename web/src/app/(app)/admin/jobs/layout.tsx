import { requireAdmin } from "@/lib/session";
import { listJobs } from "@/lib/jobs";
import { PageHeader } from "@/components/page-header";
import { NavTabs } from "@/components/ui/nav-tabs";
import { AdminNav } from "../admin-nav";

export default async function AdminJobsLayout({ children }: { children: React.ReactNode }) {
  await requireAdmin();
  const jobs = await listJobs();
  return (
    <>
      <PageHeader
        eyebrow="Instance"
        title="Administration"
        description="Maintenance jobs: run them by hand, put them on a schedule, and review what they did."
      />
      <AdminNav />
      <NavTabs
        variant="pills"
        className="mb-6"
        items={[{ href: "/admin/jobs", label: "Overview", exact: true }, ...jobs.map((j) => ({ href: `/admin/jobs/${j.name}`, label: j.tab }))]}
      />
      {children}
    </>
  );
}
