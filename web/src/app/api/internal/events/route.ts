// Receives push/delete notifications from registryd (HMAC-signed) and kicks
// off background work: config caching and vulnerability scanning.
import { createHmac, timingSafeEqual } from "crypto";
import { NextRequest, NextResponse } from "next/server";
import { after } from "next/server";
import { env } from "@/lib/env";
import { cacheManifestConfig, runScan } from "@/lib/scan";
import { buildPushPayload, dispatchRepositoryWebhooks } from "@/lib/webhooks";
import { splitImagePath } from "@/lib/library";

export const dynamic = "force-dynamic";

interface RegistryEvent {
  type: string;
  repository: string;
  digest: string;
  tag?: string;
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
        if (built) await dispatchRepositoryWebhooks(built.repositoryId, built.payload);
      }
      await runScan(event.repository, event.digest).catch((err) =>
        console.error("scan failed:", err),
      );
    });
  }

  return new NextResponse(null, { status: 204 });
}
