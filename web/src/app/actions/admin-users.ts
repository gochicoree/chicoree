"use server";

import { randomBytes } from "crypto";
import { headers } from "next/headers";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { and, eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { passkey, twoFactor, user as userTable } from "@/db/schema";
import { getAuth } from "@/lib/auth";
import { requireAdmin } from "@/lib/session";
import { recordAudit } from "@/lib/audit";
import { env } from "@/lib/env";

export interface AdminUserResult {
  error?: string;
  saved?: boolean;
  message?: string;
  /** A generated password, shown once (user creation without a password). */
  secret?: string;
}

const MIN_PASSWORD = 8;
const MAX_PASSWORD = 128;

function str(fd: FormData, key: string): string {
  return String(fd.get(key) ?? "").trim();
}

function errorMessage(err: unknown, fallback: string): string {
  if (err && typeof err === "object" && "body" in err) {
    const body = (err as { body?: { message?: string } }).body;
    if (body?.message) return body.message;
  }
  return err instanceof Error && err.message ? err.message : fallback;
}

async function target(userId: string) {
  const u = await db.query.user.findFirst({ where: eq(userTable.id, userId) });
  return u ?? null;
}

/** Name, email and the verified flag. Changing the email keeps whatever verified state the form sends. */
export async function adminUpdateAccount(_prev: AdminUserResult | null, fd: FormData): Promise<AdminUserResult> {
  const session = await requireAdmin();
  const userId = str(fd, "userId");
  const u = await target(userId);
  if (!u) return { error: "User not found." };
  const name = str(fd, "name");
  const email = str(fd, "email").toLowerCase();
  const emailVerified = fd.get("emailVerified") === "on";
  if (!name || name.length > 120) return { error: "Enter a name (up to 120 characters)." };
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return { error: "Enter a valid email address." };
  if (email !== u.email) {
    const taken = await db.query.user.findFirst({ where: eq(userTable.email, email) });
    if (taken) return { error: "Another account already uses that email address." };
  }
  const auth = await getAuth();
  try {
    await auth.api.adminUpdateUser({ headers: await headers(), body: { userId, data: { name, email, emailVerified } } });
  } catch (err) {
    return { error: errorMessage(err, "Could not update the account.") };
  }
  await recordAudit({
    action: "admin.user.update",
    targetType: "user",
    targetId: userId,
    targetLabel: email,
    details: {
      name: name !== u.name ? { from: u.name, to: name } : undefined,
      email: email !== u.email ? { from: u.email, to: email } : undefined,
      emailVerified: emailVerified !== !!u.emailVerified ? emailVerified : undefined,
      self: userId === session.user.id,
    },
  });
  revalidatePath(`/admin/users/${userId}`, "layout");
  revalidatePath("/admin/users");
  return { saved: true, message: "Account updated" };
}

/** Sets a new password and, by default, signs the user out everywhere. */
export async function adminSetPassword(_prev: AdminUserResult | null, fd: FormData): Promise<AdminUserResult> {
  await requireAdmin();
  const userId = str(fd, "userId");
  const u = await target(userId);
  if (!u) return { error: "User not found." };
  let newPassword = String(fd.get("newPassword") ?? "");
  let generated: string | undefined;
  if (!newPassword) {
    generated = randomBytes(15).toString("base64url");
    newPassword = generated;
  }
  if (newPassword.length < MIN_PASSWORD || newPassword.length > MAX_PASSWORD) {
    return { error: `Passwords are ${MIN_PASSWORD} to ${MAX_PASSWORD} characters long.` };
  }
  const revoke = fd.get("revokeSessions") === "on";
  const auth = await getAuth();
  try {
    const h = await headers();
    await auth.api.setUserPassword({ headers: h, body: { userId, newPassword } });
    if (revoke) await auth.api.revokeUserSessions({ headers: h, body: { userId } });
  } catch (err) {
    return { error: errorMessage(err, "Could not set the password.") };
  }
  await recordAudit({ action: "admin.user.password", targetType: "user", targetId: userId, targetLabel: u.email, details: { generated: !!generated, revokedSessions: revoke } });
  revalidatePath(`/admin/users/${userId}`, "layout");
  return { saved: true, message: generated ? "Password generated" : "Password set", secret: generated };
}

/** Emails the user a password-reset link through the normal flow. */
export async function adminSendPasswordReset(_prev: AdminUserResult | null, fd: FormData): Promise<AdminUserResult> {
  await requireAdmin();
  const userId = str(fd, "userId");
  const u = await target(userId);
  if (!u) return { error: "User not found." };
  const auth = await getAuth();
  try {
    await auth.api.requestPasswordReset({ headers: await headers(), body: { email: u.email, redirectTo: `${env.appUrl}/reset-password` } });
  } catch (err) {
    return { error: errorMessage(err, "Could not send the reset email.") };
  }
  await recordAudit({ action: "admin.user.password_reset", targetType: "user", targetId: userId, targetLabel: u.email });
  return { saved: true, message: `Reset link sent to ${u.email}` };
}

/** Removes TOTP and backup codes so the user can sign in with the password alone (and enrol again). */
export async function adminDisableTwoFactor(_prev: AdminUserResult | null, fd: FormData): Promise<AdminUserResult> {
  await requireAdmin();
  const userId = str(fd, "userId");
  const u = await target(userId);
  if (!u) return { error: "User not found." };
  await db.transaction(async (tx) => {
    await tx.delete(twoFactor).where(eq(twoFactor.userId, userId));
    await tx.update(userTable).set({ twoFactorEnabled: false }).where(eq(userTable.id, userId));
  });
  await recordAudit({ action: "admin.user.2fa.disable", targetType: "user", targetId: userId, targetLabel: u.email });
  revalidatePath(`/admin/users/${userId}`, "layout");
  return { saved: true, message: "Two-factor authentication removed" };
}

/** Deletes every passkey of the user. */
export async function adminRemovePasskeys(_prev: AdminUserResult | null, fd: FormData): Promise<AdminUserResult> {
  await requireAdmin();
  const userId = str(fd, "userId");
  const u = await target(userId);
  if (!u) return { error: "User not found." };
  const removed = await db.delete(passkey).where(eq(passkey.userId, userId)).returning({ id: passkey.id });
  await recordAudit({ action: "admin.user.passkeys.remove", targetType: "user", targetId: userId, targetLabel: u.email, details: { removed: removed.length } });
  revalidatePath(`/admin/users/${userId}`, "layout");
  return { saved: true, message: removed.length ? `${removed.length} passkey${removed.length === 1 ? "" : "s"} removed` : "No passkeys to remove" };
}

/** Creates an account directly (works even when sign-up is closed). */
export async function adminCreateUser(_prev: AdminUserResult | null, fd: FormData): Promise<AdminUserResult> {
  await requireAdmin();
  const name = str(fd, "name");
  const email = str(fd, "email").toLowerCase();
  const role = str(fd, "role") === "admin" ? "admin" : "user";
  const emailVerified = fd.get("emailVerified") === "on";
  let password = String(fd.get("password") ?? "");
  let generated: string | undefined;
  if (!name || name.length > 120) return { error: "Enter a name (up to 120 characters)." };
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return { error: "Enter a valid email address." };
  if (!password) {
    generated = randomBytes(15).toString("base64url");
    password = generated;
  }
  if (password.length < MIN_PASSWORD || password.length > MAX_PASSWORD) {
    return { error: `Passwords are ${MIN_PASSWORD} to ${MAX_PASSWORD} characters long.` };
  }
  const auth = await getAuth();
  let created: { user: { id: string } };
  try {
    created = await auth.api.createUser({ headers: await headers(), body: { email, password, name, role, data: { emailVerified } } });
  } catch (err) {
    return { error: errorMessage(err, "Could not create the user.") };
  }
  if (emailVerified) {
    // createUser ignores unknown extra fields on some versions; make sure the flag sticks.
    await db.update(userTable).set({ emailVerified: true }).where(eq(userTable.id, created.user.id));
  }
  await recordAudit({ action: "admin.user.create", targetType: "user", targetId: created.user.id, targetLabel: email, details: { role, emailVerified, generatedPassword: !!generated } });
  revalidatePath("/admin/users");
  if (generated) return { saved: true, message: "User created", secret: generated };
  redirect(`/admin/users/${created.user.id}`);
}

/** Deletes the account, its sessions, tokens and memberships. Refused for the last owner of an organization. */
export async function adminDeleteUser(_prev: AdminUserResult | null, fd: FormData): Promise<AdminUserResult> {
  const session = await requireAdmin();
  const userId = str(fd, "userId");
  if (userId === session.user.id) return { error: "You cannot delete your own account here." };
  const u = await target(userId);
  if (!u) return { error: "User not found." };
  if (str(fd, "confirm").toLowerCase() !== u.email.toLowerCase()) return { error: "Type the user's email address to confirm." };
  const { rows } = await db.execute(sql`
    SELECT o.slug FROM member m JOIN organization o ON o.id = m.organization_id
    WHERE m.user_id = ${userId} AND m.role = 'owner'
      AND (SELECT count(*) FROM member m2 WHERE m2.organization_id = m.organization_id AND m2.role = 'owner') = 1
    ORDER BY o.slug`);
  if (rows.length > 0) {
    const slugs = rows.map((r) => r.slug as string).join(", ");
    return { error: `This user is the only owner of ${slugs}. Add another owner or delete the organization first.` };
  }
  const auth = await getAuth();
  try {
    await auth.api.removeUser({ headers: await headers(), body: { userId } });
  } catch (err) {
    return { error: errorMessage(err, "Could not delete the user.") };
  }
  await recordAudit({ action: "admin.user.delete", targetType: "user", targetId: userId, targetLabel: u.email, details: { name: u.name, role: u.role } });
  revalidatePath("/admin/users");
  redirect("/admin/users");
}

// referenced so the `and` import stays useful for future scoped queries
void and;
