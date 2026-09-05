import { notFound, redirect } from "next/navigation";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { invitation } from "@/db/schema";
import { getOrgContext, getSession } from "@/lib/session";
import { listMembersWithUsers } from "@/lib/data";
import { logoRef } from "@/lib/logo-shared";
import { MembersManager } from "./members-manager";

export default async function MembersPage({ params }: { params: Promise<{ org: string }> }) {
  const { org: slug } = await params;
  const ctx = await getOrgContext(slug);
  if (!ctx) notFound();
  if (!ctx.role) redirect(`/${slug}`);
  const session = await getSession();

  const [members, invitations] = await Promise.all([
    listMembersWithUsers(ctx.org.id),
    db.query.invitation.findMany({ where: eq(invitation.organizationId, ctx.org.id) }),
  ]);

  return (
    <MembersManager
      organizationId={ctx.org.id}
      canManage={ctx.role === "owner" || ctx.role === "admin"}
      selfUserId={session!.user.id}
      members={members.map((m) => ({
        id: m.id,
        role: m.role,
        userId: m.userId,
        name: m.userName,
        email: m.userEmail,
        logo: logoRef("user", m.userId, m.userLogoVersion),
      }))}
      invitations={invitations
        .filter((i) => i.status === "pending")
        .map((i) => ({ id: i.id, email: i.email, role: i.role ?? "member" }))}
    />
  );
}
