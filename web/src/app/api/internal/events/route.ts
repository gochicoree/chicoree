// Receives push/delete notifications from registryd (HMAC-signed). The
// event also sits in registry_event_outbox; the row is claimed before any
// work starts, so an event handled here is never handled again by the
// outbox drain (lib/registry-events.ts) — and one this process drops
// mid-way is picked up there once the claim goes stale.
import { createHmac, timingSafeEqual } from "crypto";
import { NextRequest, NextResponse } from "next/server";
import { after } from "next/server";
import { env } from "@/lib/env";
import { claimOutboxEvent, handleClaimedEvent, processRegistryEvent, type RegistryEvent } from "@/lib/registry-events";

export const dynamic = "force-dynamic";

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
  if (!event.type || !event.repository) return NextResponse.json({ error: "invalid payload" }, { status: 400 });

  const id = typeof event.id === "number" && event.id > 0 ? event.id : null;
  if (id !== null) {
    // Already delivered, or in flight elsewhere: registryd's retry after a
    // slow response must not run the webhooks twice.
    if (!(await claimOutboxEvent(id))) return new NextResponse(null, { status: 204 });
    after(() => handleClaimedEvent(id, event));
  } else {
    // A registryd without the outbox (older build, or its insert failed):
    // best effort, as before.
    after(() => processRegistryEvent(event).catch((err) => console.error(`registry event ${event.type} ${event.repository} failed:`, err)));
  }

  return new NextResponse(null, { status: 204 });
}
