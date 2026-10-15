import { describe, expect, it } from "vitest";
import { NotificationManager, NOTIFICATION_LIMITS as L } from "./notificationManager";

describe("bounded notifications", () => {
  it("counts repeated attempts without preventing retries, and distinguishes causes", () => {
    const manager = new NotificationManager(() => 100);
    for (let i = 0; i < 10; i++) manager.report("denied", { operation: "save", documentId: "a", code: "io_write" });
    expect(manager.visible()).toHaveLength(1);
    expect(manager.visible()[0]).toMatchObject({ critical: true, occurrences: 10, repeats: 9 });
    manager.report("disk full", { operation: "save", documentId: "a", code: "io_write" });
    expect(manager.visible()).toHaveLength(2);
  });

  it("aggregates multiple known targets but keeps target count separate from repeats", () => {
    const manager = new NotificationManager(() => 100);
    for (const documentId of ["a", "b", "a"]) manager.report("denied", { operation: "save", documentId });
    expect(manager.visible()[0]).toMatchObject({ occurrences: 3, repeats: 1 });
    expect(manager.visible()[0].details).toHaveLength(2);
  });

  it("bounds entries, diagnostic content and cooldown records and keeps recent save errors visible", () => {
    let now = 100;
    const manager = new NotificationManager(() => now++);
    for (let i = 0; i < 200; i++) manager.report("X".repeat(5000) + i, { operation: "save", path: `file${i}` });
    expect(manager.diagnostics().entries).toBe(L.entries);
    expect(manager.visible()).toHaveLength(3);
    expect(manager.visible()[0].details[0].context.path).toBe("file199");
    expect(manager.visible()[0].details[0].raw).toHaveLength(L.diagnosticChars);
    expect(manager.visible()[0].details[0].truncated).toBe(true);
    expect(manager.getSnapshot().omittedEntries).toBe(188);
    for (let i = 0; i < 100; i++) {
      manager.report(`error${i}`, { operation: "save", path: `p${i}` });
      manager.dismiss(manager.visible()[0].id);
    }
    expect(manager.diagnostics().cooldown).toBeLessThanOrEqual(L.cooldownRecords);
  });

  it("bounds per-group details and states omitted diagnostics", () => {
    const manager = new NotificationManager(() => 100);
    for (let i = 0; i < 20; i++) manager.report("denied", { operation: "save", documentId: `d${i}`, batchId: "batch" });
    expect(manager.visible()[0].details).toHaveLength(L.details);
    expect(manager.visible()[0].omitted).toBe(12);
    expect(manager.visible()[0].occurrences).toBe(20);
  });

  it("dismisses with bounded cooldown without hiding a new cause", () => {
    let now = 100;
    const manager = new NotificationManager(() => now);
    const context = { operation: "save" as const, documentId: "a" };
    manager.report("denied", context); manager.dismiss(manager.visible()[0].id);
    manager.report("denied", context); expect(manager.visible()).toHaveLength(0);
    manager.report("disk full", context); expect(manager.visible()).toHaveLength(1);
    now += L.cooldownMs;
    manager.report("denied", context); expect(manager.visible()).toHaveLength(2);
  });

  it("clears only matching operation/target through the successful generation", () => {
    const manager = new NotificationManager(() => 100);
    manager.report("denied", { operation: "save", documentId: "a", generation: 3 });
    manager.report("denied", { operation: "save", documentId: "b", generation: 1 });
    manager.resolve({ operation: "save", documentId: "a", generation: 2 });
    expect(manager.visible()[0].details).toHaveLength(2);
    manager.resolve({ operation: "save", documentId: "a", generation: 3 });
    expect(manager.visible()[0].details.map(d => d.context.documentId)).toEqual(["b"]);
  });

  it("pauses ordinary timers but never expires critical errors", () => {
    const manager = new NotificationManager(() => 100);
    manager.notify("info", "hello");
    const infoId = manager.visible()[0].id;
    manager.report("denied", { operation: "save", documentId: "a" });
    manager.elapse(L.durationMs + 1, new Set([infoId])); expect(manager.visible()).toHaveLength(2);
    manager.elapse(L.durationMs + 1, new Set()); expect(manager.visible()).toHaveLength(1);
    expect(manager.visible()[0].critical).toBe(true);
  });

  it("distinguishes different Save As target paths for the same documentId, and deduplicates identical id+target repeats", () => {
    const manager = new NotificationManager(() => 100);
    manager.report("denied", { operation: "saveAs", documentId: "doc-1", path: "C:\\work\\B.txt" });
    manager.report("denied", { operation: "saveAs", documentId: "doc-1", path: "C:\\work\\C.txt" });
    // Repeated failure on target B deduplicates
    manager.report("denied", { operation: "saveAs", documentId: "doc-1", path: "C:\\work\\B.txt" });

    const entry = manager.visible()[0];
    expect(entry.details).toHaveLength(2);
    const detailB = entry.details.find(d => d.context.path?.includes("B.txt"))!;
    expect(detailB.occurrences).toBe(2);

    // Resolving C clears C but keeps B
    manager.resolve({ operation: "saveAs", documentId: "doc-1", path: "C:\\work\\C.txt" });
    expect(manager.visible()[0].details).toHaveLength(1);
    expect(manager.visible()[0].details[0].context.path).toContain("B.txt");
  });

  it("clears dismiss cooldown on resolve even when entry was already dismissed", () => {
    let now = 100;
    const manager = new NotificationManager(() => now);
    const ctx = { operation: "save" as const, documentId: "doc-1" };
    manager.report("io error", ctx);
    const id = manager.visible()[0].id;
    manager.dismiss(id);
    expect(manager.visible()).toHaveLength(0);

    // Suppressed by dismiss cooldown
    manager.report("io error", ctx);
    expect(manager.visible()).toHaveLength(0);

    // Success resolves doc-1, lifting cooldown
    manager.resolve(ctx);

    // Subsequent error is reported immediately
    manager.report("io error", ctx);
    expect(manager.visible()).toHaveLength(1);
  });

  it("does not let late-arriving older failures overwrite a newer success (generation watermark)", () => {
    const manager = new NotificationManager(() => 100);
    // Generation 5 succeeded
    manager.resolve({ operation: "save", documentId: "doc-1", generation: 5 });

    // Late failure from older generation 4 arrives
    manager.report("late failure", { operation: "save", documentId: "doc-1", generation: 4 });
    expect(manager.visible()).toHaveLength(0);

    // Failure from generation 5 also discarded
    manager.report("late failure 5", { operation: "save", documentId: "doc-1", generation: 5 });
    expect(manager.visible()).toHaveLength(0);

    // New failure from generation 6 is reported
    manager.report("newer failure", { operation: "save", documentId: "doc-1", generation: 6 });
    expect(manager.visible()).toHaveLength(1);
  });

  it("resolves long path matching bounded identity despite context truncation", () => {
    const manager = new NotificationManager(() => 100);
    const longPath = "C:\\very\\" + "long_segment\\".repeat(100) + "file.txt";
    expect(longPath.length).toBeGreaterThan(L.contextChars);

    manager.report("failed", { operation: "save", path: longPath });
    const detail = manager.visible()[0].details[0];
    expect(detail.context.path?.length).toBe(L.contextChars);
    expect(detail.truncated).toBe(true);

    manager.resolve({ operation: "save", path: longPath });
    expect(manager.visible()).toHaveLength(0);
  });
  it("preserves omitted summary on resolve when details length becomes 0, and allows manual dismissal", () => {
    const manager = new NotificationManager(() => 100);
    for (let i = 0; i < 20; i++) {
      manager.report("denied", { operation: "save", documentId: `d${i}`, batchId: "batch" });
    }
    const entry = manager.visible()[0];
    expect(entry.details).toHaveLength(L.details);
    expect(entry.omitted).toBe(12);

    // Resolve all retained details (d12..d19)
    for (let i = 12; i < 20; i++) {
      manager.resolve({ operation: "save", documentId: `d${i}` });
    }

    // Details are 0, but omitted summary is preserved
    expect(manager.visible()).toHaveLength(1);
    const remainingEntry = manager.visible()[0];
    expect(remainingEntry.details).toHaveLength(0);
    expect(remainingEntry.omitted).toBe(12);

    // Can be manually dismissed
    manager.dismiss(remainingEntry.id);
    expect(manager.visible()).toHaveLength(0);
  });

  it("updates repeats when a repeated target is resolved to avoid occurrences=1 and repeats=1", () => {
    const manager = new NotificationManager(() => 100);
    // Target A fails twice
    manager.report("denied", { operation: "save", documentId: "A" });
    manager.report("denied", { operation: "save", documentId: "A" });
    // Target B fails once
    manager.report("denied", { operation: "save", documentId: "B" });

    const entry = manager.visible()[0];
    expect(entry.occurrences).toBe(3);
    expect(entry.repeats).toBe(1);

    // Resolve target A
    manager.resolve({ operation: "save", documentId: "A" });

    expect(manager.visible()).toHaveLength(1);
    const updated = manager.visible()[0];
    expect(updated.details).toHaveLength(1);
    expect(updated.details[0].context.documentId).toBe("B");
    expect(updated.occurrences).toBe(1);
    expect(updated.repeats).toBe(0);
  });
});
