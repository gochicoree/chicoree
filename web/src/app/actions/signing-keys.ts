"use server";

import { revalidatePath } from "next/cache";
import { requireAdmin } from "@/lib/session";
import { recordAudit } from "@/lib/audit";
import { generateSigningKey, retireSigningKey } from "@/lib/signing-keys";

export interface KeyActionResult {
  error?: string;
  message?: string;
  kid?: string;
}

/** Generate a new ES256 key and make it the active signer; older keys keep verifying. */
export async function generateSigningKeyAction(_prev: KeyActionResult | null, _fd: FormData): Promise<KeyActionResult> {
  const session = await requireAdmin();
  try {
    const key = await generateSigningKey(session.user.id);
    await recordAudit({ action: "keys.generate", targetType: "signing_key", targetId: key.kid, targetLabel: key.kid.slice(0, 16), details: { algorithm: key.algorithm } });
    revalidatePath("/admin/settings/keys");
    revalidatePath("/admin/health");
    return { message: "New signing key active", kid: key.kid };
  } catch (e) {
    return { error: e instanceof Error ? e.message : "Could not generate a key." };
  }
}

/** Retire a key that no longer signs; registryd drops it ten minutes later. */
export async function retireSigningKeyAction(_prev: KeyActionResult | null, fd: FormData): Promise<KeyActionResult> {
  await requireAdmin();
  const kid = String(fd.get("kid") ?? "");
  const res = await retireSigningKey(kid);
  if (!res.ok) return { error: res.error };
  await recordAudit({ action: "keys.retire", targetType: "signing_key", targetId: kid, targetLabel: kid.slice(0, 16) });
  revalidatePath("/admin/settings/keys");
  revalidatePath("/admin/health");
  return { message: "Key retired; the registry stops trusting it in 10 minutes", kid };
}
