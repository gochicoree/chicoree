// Receives push/delete notifications from registryd (HMAC-signed) and kicks
// off background work: config caching and vulnerability scanning.
import { createHmac, timingSafeEqual } from "crypto";
import { NextRequest, NextResponse } from "next/server";
import { after } from "next/server";
import { env } from "@/lib/env";
import { cacheManifestConfig, runScan } from "@/lib/scan";
import { buildPushPayload, dispatchRepositoryWebhooks, emitRepositoryEvent, resolveActor } from "@/lib/webhooks";
import { checkQuotaWarningsForRepository } from "@/lib/notify";
import { getRepoByPath } from "@/lib/data";
import { imageReference, splitImagePath } from "@/lib/library";
import { onManifestPushed } from "@/lib/signatures";

export const dynamic = "force-dynamic";

interface RegistryEvent {
  type: string;
  repository: string;
  digest: string;
  tag?: string;
  /** Tags that pointed at a manifest deleted by digest. */
  tags?: string[];
  mediaType?: string;
  actor?: string;
}

function validSignature(body: string, signature: string | null): boolean {
  if (!signature) return false;
  const expected = createHmac("sha256", env.webhookSecret).update(body).digest();
  let provided: Buffer;
  try {
    provided = Buffer.from(signature, "hex");
  } catch {
    return false;
  }
  return provided.length === expected.length && timingSafeEqual(provided, expected);
}

export async function POST(req: NextRequest) {
  const body = await req.text();
  if (!validSignature(body, req.headers.get("x-chicoree-signature"))) {
    return NextResponse.json({ error: "invalid signature" }, { status: 401 });
  }

  let event: RegistryEvent;
  try {
    event = JSON.parse(body) as RegistryEvent;
  } catch {
    return NextResponse.json({ error: "invalid payload" }, { status: 400 });
  }

  if (event.type === "manifest.push" && event.repository && event.digest) {
    after(async () => {
      await cacheManifestConfig(event.repository, event.digest).catch((err) =>
        console.error("config cache failed:", err),
      );
      // Repository webhooks go out right after the config is cached so the
      // payload can include platform, labels and entrypoint.
      const target = splitImagePath(event.repository);
      if (target) {
        const built = await buildPushPayload(
          target.orgSlug,
          target.repoName,
          event.digest,
          event.tag ?? null,
          event.actor,
        ).catch((err) => {
          console.error("webhook payload failed:", err);
          return null;
        });
        if (built) {
          await dispatchRepositoryWebhooks(built.repositoryId, built.payload);
          await checkQuotaWarningsForRepository(built.repositoryId).catch((err) =>
            console.error("quota warning check failed:", err),
          );
        }
      }
      // Signatures and attestations arrive as pushes too: verify what was
      // attached (or the image itself) and refresh the signature policy.
      await onManifestPushed(event.repository, event.digest, event.tag).catch((err) =>
        console.error("signature verification failed:", err),
      );
      await runScan(event.repository, event.digest).catch((err) =>
        console.error("scan failed:", err),
      );
    });
  }

  if (event.type === "manifest.delete" && event.repository) {
    after(async () => {
      const target = splitImagePath(event.repository);
      if (!target) return;
      const found = await getRepoByPath(target.orgSlug, target.repoName);
      if (!found) return;
      const tags = event.tags ?? (event.tag ? [event.tag] : []);
      const digest = event.digest || null;
      await emitRepositoryEvent(found.repo.id, "delete", {
        tag: event.tag ?? null,
        tags,
        digest,
        image: digest
          ? {
              digest,
              reference: imageReference(env.registryHost, target.orgSlug, target.repoName, digest),
              digestReference: imageReference(env.registryHost, target.orgSlug, target.repoName, digest),
            }
          : null,
        actor: await resolveActor(event.actor),
      }).catch((err) => console.error("delete webhook failed:", err));
    });
  }

  return new NextResponse(null, { status: 204 });
}
