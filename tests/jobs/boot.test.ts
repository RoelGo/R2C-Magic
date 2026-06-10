/**
 * Boot-time recovery tests. We simulate a crashed previous process by
 * leaving rows in inconsistent states, then call runBootRecovery() and
 * assert it cleans up + re-enqueues stuck work.
 */
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { EnrichmentSource } from "../../src/lib/enrichment/sources/source";
import { useTmpEnv } from "../helpers/tmp-env";

const enabledMock = vi.fn<() => readonly EnrichmentSource[]>(() => []);
vi.mock("../../src/lib/enrichment/sources", () => ({
  enabledSources: () => enabledMock(),
}));

beforeEach(() => {
  enabledMock.mockReturnValue([]);
});
afterEach(() => {
  enabledMock.mockReset();
});

describe("jobs/boot.runBootRecovery", () => {
  useTmpEnv();

  it("is a no-op when there's nothing to recover", async () => {
    const { runBootRecovery } = await import("../../src/lib/jobs/boot");
    const result = runBootRecovery();
    expect(result).toEqual({ resumedRuns: 0, reEnqueuedBooks: 0 });
  });

  it("flips books stuck in 'enriching' back to 'pending'", async () => {
    const { createRun } = await import("../../src/lib/runs");
    const { books } = await import("../../src/lib/db/schema");
    const db = await import("../../src/lib/db/client").then((m) => m.getDb());

    const csv = `EAN,Description,Brand,SKU,tag,aankoopprijs,verkoopprijs,leverancier,btw,gewenste voorraad,herbestellingspunt
9780140328721,Fantastic Mr Fox,Roald Dahl,,,10.00,15.00,CB,Item,1,0
`;
    const { runId } = await createRun({ fileName: "x.csv", content: csv });

    // Simulate a crash: book half-processed, marked 'enriching' but never finished.
    db.update(books).set({ status: "enriching" }).where(eq(books.runId, runId)).run();

    const { runBootRecovery } = await import("../../src/lib/jobs/boot");
    const { awaitRun } = await import("../../src/lib/jobs/run");

    runBootRecovery();
    await awaitRun(runId);

    const row = db.select().from(books).where(eq(books.runId, runId)).get();
    expect(["done", "failed"]).toContain(row?.status);
  });

  it("re-enqueues pending books in a previously-running run", async () => {
    const { createRun } = await import("../../src/lib/runs");
    const { runs } = await import("../../src/lib/db/schema");
    const db = await import("../../src/lib/db/client").then((m) => m.getDb());

    const csv = `EAN,Description,Brand,SKU,tag,aankoopprijs,verkoopprijs,leverancier,btw,gewenste voorraad,herbestellingspunt
9780140328721,Fantastic Mr Fox,Roald Dahl,,,10.00,15.00,CB,Item,1,0
9780140328722,Other Book,Roald Dahl,,,10.00,15.00,CB,Item,1,0
`;
    const { runId } = await createRun({ fileName: "x.csv", content: csv });

    // Simulate a crash where the run was already 'running' but no books processed.
    db.update(runs).set({ status: "running" }).where(eq(runs.id, runId)).run();

    const { runBootRecovery } = await import("../../src/lib/jobs/boot");
    const { awaitRun } = await import("../../src/lib/jobs/run");

    const result = runBootRecovery();
    expect(result.resumedRuns).toBe(1);
    expect(result.reEnqueuedBooks).toBe(2);

    await awaitRun(runId);
    const finalRun = db.select().from(runs).where(eq(runs.id, runId)).get();
    expect(["completed", "failed"]).toContain(finalRun?.status);
  });

  it("is idempotent in the same process — second call does nothing", async () => {
    const { runBootRecovery, resetBootForTests } = await import("../../src/lib/jobs/boot");
    resetBootForTests();
    expect(runBootRecovery()).toEqual({ resumedRuns: 0, reEnqueuedBooks: 0 });
    expect(runBootRecovery()).toEqual({ resumedRuns: 0, reEnqueuedBooks: 0 });
  });
});
