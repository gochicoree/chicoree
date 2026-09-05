"use server";

import { after } from "next/server";
import { revalidatePath } from "next/cache";
import { requireSession } from "@/lib/session";
import { recordAudit } from "@/lib/audit";
import { addUserSigningKey, removeUserSigningKey, reverifyForUser } from "@/lib/signatures";

export interface UserSigningKeyResult {
  error?: string;
  saved?: boolean;
}

/**
 * Re-verification touches every repository the user may push to, which for
 * an instance administrator is the whole registry: it runs after the
 * response, the page only needs the key list.
 */
function reverifyLater(userId: string) {
  after(async () => {
    await reverifyForUser(userId).catch((err) => console.error("re-verification after a personal key change failed:", err));
  });
}

/** Register a personal signing key (Settings → Signing keys). */
export async function addUserSigningKeyAction(_prev: UserSigningKeyResult | null, formData: FormData): Promise<UserSigningKeyResult> {
  const session = await requireSession();
  const name = String(formData.get("name") ?? "");
  const pem = String(formData.get("pem") ?? "");
  let key;
  try {
    key = await addUserSigningKey({ userId: session.user.id, name, pem });
  } catch (err) {
    return { error: err instanceof Error ? err.message : "Could not add the key." };
  }
  await recordAudit({
    action: "signing_key.personal.add",
    targetType: "user",
    targetId: session.user.id,
    targetLabel: session.user.email,
    details: { name: key.name, fingerprint: key.fingerprint, keyType: key.keyType },
  });
  reverifyLater(session.user.id);
  revalidatePath("/settings/signing-keys");
  return { saved: true };
}

export async function removeUserSigningKeyAction(formData: FormData): Promise<UserSigningKeyResult> {
  const session = await requireSession();
  const id = String(formData.get("id") ?? "");
  const row = await removeUserSigningKey(id, session.user.id);
  if (!row) return { error: "Key not found." };
  await recordAudit({
    action: "signing_key.personal.remove",
    targetType: "user",
    targetId: session.user.id,
    targetLabel: session.user.email,
    details: { name: row.name, fingerprint: row.fingerprint },
  });
  reverifyLater(session.user.id);
  revalidatePath("/settings/signing-keys");
  return { saved: true };
}
