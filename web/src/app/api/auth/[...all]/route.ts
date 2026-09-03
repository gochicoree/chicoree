import { getAuth } from "@/lib/auth";

// The instance is resolved per request so provider changes made in the
// admin panel take effect without a restart.
export async function GET(req: Request) {
  return (await getAuth()).handler(req);
}
export async function POST(req: Request) {
  return (await getAuth()).handler(req);
}
