import type { Metadata } from "next";
import Link from "next/link";
import { requireAdmin } from "@/lib/session";
import { listAdminUsers } from "@/lib/data";
import { relativeTime } from "@/lib/format";
import { PageHeader } from "@/components/page-header";
import { Card, CardHeader } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { AdminNav } from "../admin-nav";
import { CreateUserForm } from "./create-user-form";

export const metadata: Metadata = { title: "Users" };

export default async function AdminUsersPage() {
  const session = await requireAdmin();
  const users = await listAdminUsers();

  return (
    <>
      <PageHeader eyebrow="Instance" title="Administration" />
      <AdminNav />
      <div className="mb-6">
        <CreateUserForm />
      </div>
      <Card>
        <CardHeader eyebrow="People" title={`Users (${users.length})`} description="Open a user to change their role, set limits, or impersonate them." />
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-line text-left">
                <th className="px-4 py-2.5 text-xs font-medium text-ink-2 sm:px-5">User</th>
                <th className="px-4 py-2.5 text-xs font-medium text-ink-2">Role</th>
                <th className="px-4 py-2.5 text-xs font-medium text-ink-2">Status</th>
                <th className="hidden px-4 py-2.5 text-right text-xs font-medium text-ink-2 sm:table-cell">Joined</th>
              </tr>
            </thead>
            <tbody>
              {users.map((u) => (
                <tr key={u.id} className="border-b border-line last:border-0 hover:bg-card-2">
                  <td className="px-4 py-3 sm:px-5">
                    <Link href={`/admin/users/${u.id}`} className="text-sm font-medium hover:underline">
                      {u.name}
                    </Link>
                    {u.id === session.user.id && <span className="ml-1.5 text-xs text-ink-3">(you)</span>}
                    <div className="break-all text-xs text-ink-2">{u.email}</div>
                  </td>
                  <td className="px-4 py-3">
                    <Badge tone={u.role === "admin" ? "accent" : "neutral"}>{u.role ?? "user"}</Badge>
                  </td>
                  <td className="px-4 py-3">
                    {u.banned ? (
                      <Badge tone="danger">banned</Badge>
                    ) : u.emailVerified ? (
                      <Badge tone="ok">verified</Badge>
                    ) : (
                      <Badge>unverified</Badge>
                    )}
                  </td>
                  <td className="hidden px-4 py-3 text-right text-[13px] text-ink-2 sm:table-cell">{relativeTime(u.createdAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
    </>
  );
}
