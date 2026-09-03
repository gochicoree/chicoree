import { notFound } from "next/navigation";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { userLimits } from "@/db/schema";
import { getAdminUserDetail } from "@/lib/admin-data";
import { LimitsForm } from "@/components/admin/limits-form";

export default async function AdminUserLimits({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const detail = await getAdminUserDetail(id);
  if (!detail) notFound();
  const row = await db.query.userLimits.findFirst({ where: eq(userLimits.userId, id) });
  return <LimitsForm scope="user" targetId={detail.user.id} limits={detail.limits} note={row?.note ?? ""} />;
}
