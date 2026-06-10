/**
 * Next.js instrumentation hook. Called once when the server starts (both
 * `next dev` and `next start`). We use it to resume any runs that were
 * mid-flight when the previous process exited — see
 * `src/lib/jobs/boot.ts` for the recovery logic.
 *
 * The `register` export is the documented Next.js hook
 * (https://nextjs.org/docs/app/api-reference/file-conventions/instrumentation).
 * It runs in the Node.js runtime only (Edge runtime would not have
 * access to better-sqlite3 anyway).
 */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const { runBootRecovery } = await import("@/lib/jobs/boot");
  runBootRecovery();
}
