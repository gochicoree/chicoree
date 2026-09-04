"use server";

import { headers } from "next/headers";
import { sql } from "drizzle-orm";
import { db } from "@/db";
import { getAuth } from "@/lib/auth";
import { requireSession } from "@/lib/session";
import { getInstanceSettings } from "@/lib/instance-settings";
import { recordAudit } from "@/lib/audit";
import { env } from "@/lib/env";

export interface VerificationResult {
  error?: string;
  saved?: boolean;
  message?: string;
}

/** One resend per minute per account, claimed atomically so parallel clicks cannot both send. */
async function claimSlot(userId: string): Promise<boolean> {
  const { rows } = await db.execute(sql`
    INSERT INTO notification_state (key, sent_at) VALUES (${`verify-email:${userId}`}, now())
    ON CONFLICT (key) DO UPDATE SET sent_at = now()
    WHERE notification_state.sent_at < now() - interval '60 seconds'
    RETURNING key`);
  return rows.length > 0;
}

/** Sends the verification email again, to the signed-in account's own address. */
export async function resendVerificationEmail(): Promise<VerificationResult> {
  const session = await requireSession();
  if (session.user.emailVerified) return { error: "This address is already verified." };
  if (!(await getInstanceSettings()).smtp.host) {
    return { error: "No mail server is configured; ask an administrator to verify the address for you." };
  }
  if (!(await claimSlot(session.user.id))) {
    return { error: "A verification email went out less than a minute ago; check your inbox and spam folder." };
  }
  const auth = await getAuth();
  try {
    await auth.api.sendVerificationEmail({
      headers: await headers(),
      body: { email: session.user.email, callbackURL: `${env.appUrl}/dashboard` },
    });
  } catch (err) {
    return { error: err instanceof Error && err.message ? err.message : "Could not send the email." };
  }
  await recordAudit({ action: "auth.verification.resend", targetType: "user", targetId: session.user.id, targetLabel: session.user.email });
  return { saved: true, message: `Verification email sent to ${session.user.email}` };
}
