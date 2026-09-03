// Next.js instrumentation hook: runs once when a server instance starts.
// Starts the in-app job scheduler on the Node.js runtime only — never in the
// edge runtime and never during `next build`.
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  if (process.env.NEXT_PHASE === "phase-production-build") return;
  const { startScheduler } = await import("./lib/scheduler");
  startScheduler();
}
