import type { Metadata } from "next";
import { requireAdmin } from "@/lib/session";
import { activeSigner, fileKeyInfo, listSigningKeys, KEY_DROP_WINDOW_MS } from "@/lib/signing-keys";
import { registryStatus } from "@/lib/registry-client";
import { PageHeader } from "@/components/page-header";
import { AdminNav } from "../../admin-nav";
import { KeysManager, type KeyView } from "./keys-manager";

export const metadata: Metadata = { title: "Signing keys" };
export const dynamic = "force-dynamic";

export default async function AdminSigningKeysPage() {
  await requireAdmin();
  const [keys, file, status] = await Promise.all([listSigningKeys(), Promise.resolve(fileKeyInfo()), registryStatus()]);
  let signerKid: string | null = null;
  let signerError: string | null = null;
  try {
    signerKid = (await activeSigner()).kid;
  } catch (e) {
    signerError = e instanceof Error ? e.message : String(e);
  }
  const registry = "status" in status ? status.status : null;
  const trusted = new Set(registry?.publicKeyFingerprints ?? (registry?.publicKeyFingerprint ? [registry.publicKeyFingerprint] : []));
  const now = Date.now();

  const views: KeyView[] = keys.map((k) => ({
    kid: k.kid,
    source: "database",
    algorithm: k.algorithm,
    createdAt: k.createdAt.toISOString(),
    activatedAt: k.activatedAt?.toISOString() ?? null,
    retiredAt: k.retiredAt?.toISOString() ?? null,
    droppedAt: k.retiredAt ? new Date(k.retiredAt.getTime() + KEY_DROP_WINDOW_MS).toISOString() : null,
    signs: k.kid === signerKid,
    trustedByRegistry: registry ? trusted.has(k.kid) : null,
    dropped: !!k.retiredAt && k.retiredAt.getTime() + KEY_DROP_WINDOW_MS <= now,
  }));
  views.push({
    kid: file.fingerprint ?? "",
    source: "file",
    algorithm: "ES256",
    createdAt: null,
    activatedAt: null,
    retiredAt: null,
    droppedAt: null,
    signs: !!file.fingerprint && file.fingerprint === signerKid,
    trustedByRegistry: registry && file.fingerprint ? trusted.has(file.fingerprint) : null,
    dropped: false,
    path: file.path,
    error: file.error,
  });

  return (
    <>
      <PageHeader
        eyebrow="Instance"
        title="Administration"
        description="Keys that sign the five-minute registry tokens. Rotate without downtime: the new key signs at once, the old one keeps verifying until you retire it."
      />
      <AdminNav />
      <KeysManager keys={views} signerError={signerError} registryReachable={!!registry} registryAuthDisabled={!!registry?.authDisabled} />
    </>
  );
}
