import { describe, expect, it } from "vitest";

import {
  InternalFsOperationGuard,
  type CapturedWatchHint,
  type InternalHintKind,
  type InternalPathClaim,
  type InternalPathConfirmation,
} from "./internalFsOperationGuard";

/* -------------------------------------------------------------------------- */
/* Fixtures                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Canonical comparison keys, not path spellings, are the guard's identity: the
 * two spellings below are one file on purpose, so a suite that accidentally keyed
 * on `path` would fail here rather than in production.
 */
const NOTES_KEY = "c:\\work\\notes.txt";
const NOTES_PATH = "C:\\work\\NOTES.TXT";
const OTHER_KEY = "c:\\work\\other.txt";

function hint(
  comparisonKey: string,
  kind: InternalHintKind,
  path: string = comparisonKey,
): CapturedWatchHint {
  return { comparisonKey, path, kind };
}

function claim(
  comparisonKey: string,
  effect: InternalPathClaim["effect"],
): InternalPathClaim {
  return { comparisonKey, path: comparisonKey, effect };
}

function confirm(
  comparisonKey: string,
  exists: boolean,
): InternalPathConfirmation {
  return { comparisonKey, exists };
}

/* -------------------------------------------------------------------------- */
/* Tests                                                                      */
/* -------------------------------------------------------------------------- */

describe("InternalFsOperationGuard", () => {
  it("passes a hint for an unclaimed path straight through", () => {
    const guard = new InternalFsOperationGuard();
    const operation = guard.beginMutation({
      kind: "save",
      claims: [claim(NOTES_KEY, "write")],
    });

    // An outside change to some other document must never be delayed by this
    // document's save, so it is neither captured nor held.
    expect(guard.capture(hint(OTHER_KEY, "changed"))).toBe(false);
    expect(guard.pendingHintCount()).toBe(0);
    expect(guard.hasActiveMutations()).toBe(true);

    expect(
      operation.settle({ succeeded: true, confirmed: [confirm(NOTES_KEY, true)] }),
    ).toEqual({ status: "reconciled" });
    expect(guard.hasActiveMutations()).toBe(false);
  });

  it("captures and holds a hint for a path an active mutation claimed", () => {
    const guard = new InternalFsOperationGuard();
    guard.beginMutation({ kind: "save", claims: [claim(NOTES_KEY, "write")] });

    expect(guard.capture(hint(NOTES_KEY, "changed"))).toBe(true);
    expect(guard.pendingHintCount()).toBe(1);
  });

  it("reconciles its own write without reporting a false conflict", () => {
    const guard = new InternalFsOperationGuard();
    const operation = guard.beginMutation({
      kind: "save",
      claims: [claim(NOTES_KEY, "write")],
    });

    guard.capture(hint(NOTES_KEY, "changed"));

    expect(
      operation.settle({ succeeded: true, confirmed: [confirm(NOTES_KEY, true)] }),
    ).toEqual({ status: "reconciled" });
    expect(guard.pendingHintCount()).toBe(0);
  });

  it("identifies operations and carries their descriptive kind", () => {
    const guard = new InternalFsOperationGuard();
    const first = guard.beginMutation({
      kind: "save",
      claims: [claim(NOTES_KEY, "write")],
    });
    const second = guard.beginMutation({
      kind: "delete",
      claims: [claim(OTHER_KEY, "remove")],
    });

    expect(first.operationId).not.toBe(second.operationId);
    expect(first.kind).toBe("save");
    expect(second.kind).toBe("delete");

    first.settle({ succeeded: true, confirmed: [confirm(NOTES_KEY, true)] });
    second.settle({ succeeded: true, confirmed: [confirm(OTHER_KEY, false)] });
    // The descriptive kind changes nothing about the rules, but both operations
    // still settle independently.
    expect(guard.hasActiveMutations()).toBe(false);
  });

  /**
   * The combinations the post-operation disk state really does explain. Every one
   * of them is the "own event" case: the hint describes the change the operation
   * itself just made.
   */
  const RECONCILED_CASES: ReadonlyArray<{
    name: string;
    effect: InternalPathClaim["effect"];
    kind: InternalHintKind;
    exists: boolean;
  }> = [
    { name: "a write reconciles a changed hint", effect: "write", kind: "changed", exists: true },
    { name: "a write reconciles a created hint", effect: "write", kind: "created", exists: true },
    { name: "a create reconciles a created hint", effect: "create", kind: "created", exists: true },
    { name: "a create reconciles a changed hint", effect: "create", kind: "changed", exists: true },
    { name: "a remove reconciles a removed hint", effect: "remove", kind: "removed", exists: false },
  ];

  for (const testCase of RECONCILED_CASES) {
    it(testCase.name, () => {
      const guard = new InternalFsOperationGuard();
      const operation = guard.beginMutation({
        kind: "unknown",
        claims: [claim(NOTES_KEY, testCase.effect)],
      });

      guard.capture(hint(NOTES_KEY, testCase.kind));

      expect(
        operation.settle({
          succeeded: true,
          confirmed: [confirm(NOTES_KEY, testCase.exists)],
        }),
      ).toEqual({ status: "reconciled" });
      expect(guard.pendingHintCount()).toBe(0);
    });
  }

  it("reconciles an internal operation that produced no hints at all", () => {
    const guard = new InternalFsOperationGuard();
    const operation = guard.beginMutation({
      kind: "recreate",
      claims: [claim(NOTES_KEY, "create")],
    });

    // No observation was needed: there was nothing for the disk state to explain,
    // so a silent write is not a divergence.
    expect(operation.settle({ succeeded: true, confirmed: [] })).toEqual({
      status: "reconciled",
    });
    expect(guard.pendingHintCount()).toBe(0);
  });

  it("does not swallow an outside removal observed during a guarded write", () => {
    const guard = new InternalFsOperationGuard();
    const operation = guard.beginMutation({
      kind: "save",
      claims: [claim(NOTES_KEY, "write")],
    });
    const outsideRemoval = hint(NOTES_KEY, "removed");

    guard.capture(outsideRemoval);

    // A write leaves the path present, so a removal cannot be its own event: it
    // is handed back for validation rather than dismissed as internal.
    expect(
      operation.settle({ succeeded: true, confirmed: [confirm(NOTES_KEY, true)] }),
    ).toEqual({ status: "diverged", unreconciled: [outsideRemoval] });
    expect(guard.pendingHintCount()).toBe(0);
  });

  it("does not swallow a write whose confirmed disk state contradicts it", () => {
    const guard = new InternalFsOperationGuard();
    const operation = guard.beginMutation({
      kind: "save",
      claims: [claim(NOTES_KEY, "write")],
    });
    const changed = hint(NOTES_KEY, "changed");

    guard.capture(changed);

    expect(
      operation.settle({ succeeded: true, confirmed: [confirm(NOTES_KEY, false)] }),
    ).toEqual({ status: "diverged", unreconciled: [changed] });
  });

  it("never reconciles an invalidation or an uninterpretable hint", () => {
    const guard = new InternalFsOperationGuard();
    const operation = guard.beginMutation({
      kind: "save",
      claims: [claim(NOTES_KEY, "write")],
    });
    const invalidated = hint(NOTES_KEY, "invalidated");
    const other = hint(NOTES_KEY, "other");

    guard.capture(invalidated);
    guard.capture(other);

    // Neither hint says anything about this path: invalidation means the stream
    // may be incomplete (FR-038) and `other` is not interpretable, so both stay
    // divergence candidates even though the write itself succeeded.
    expect(
      operation.settle({ succeeded: true, confirmed: [confirm(NOTES_KEY, true)] }),
    ).toEqual({ status: "diverged", unreconciled: [invalidated, other] });
  });

  it("surfaces everything when the filesystem operation failed", () => {
    const guard = new InternalFsOperationGuard();
    const operation = guard.beginMutation({
      kind: "save-as",
      claims: [claim(NOTES_KEY, "write")],
    });
    const changed = hint(NOTES_KEY, "changed");
    const removed = hint(NOTES_KEY, "removed");

    guard.capture(changed);
    guard.capture(removed);

    // A failed operation explains nothing: no confirmation can make its hints
    // internal.
    expect(
      operation.settle({
        succeeded: false,
        confirmed: [confirm(NOTES_KEY, true)],
      }),
    ).toEqual({ status: "diverged", unreconciled: [changed, removed] });
  });

  it("cannot declare a claimed key internal without confirming it", () => {
    const guard = new InternalFsOperationGuard();
    const operation = guard.beginMutation({
      kind: "save",
      claims: [claim(NOTES_KEY, "write")],
    });
    const changed = hint(NOTES_KEY, "changed");

    guard.capture(changed);

    // "We could not check whether it exists" is not evidence that the hint was
    // ours, so the hint may not be reconciled away.
    expect(operation.settle({ succeeded: true, confirmed: [] })).toEqual({
      status: "diverged",
      unreconciled: [changed],
    });
    expect(
      operation.settle({ succeeded: true, confirmed: [confirm(OTHER_KEY, true)] }),
    ).toEqual({ status: "superseded" });
  });

  it("keeps overlapping mutations on different keys independent", () => {
    const guard = new InternalFsOperationGuard();
    const first = guard.beginMutation({
      kind: "save",
      claims: [claim(NOTES_KEY, "write")],
    });
    const second = guard.beginMutation({
      kind: "delete",
      claims: [claim(OTHER_KEY, "remove")],
    });

    const notes = hint(NOTES_KEY, "changed");
    guard.capture(notes);
    guard.capture(hint(OTHER_KEY, "removed"));

    // The first settlement reports only its own key's hints; the second key's
    // hint is neither resolved nor dropped, and the second mutation is untouched.
    expect(
      first.settle({ succeeded: true, confirmed: [confirm(NOTES_KEY, true)] }),
    ).toEqual({ status: "reconciled" });
    expect(guard.pendingHintCount()).toBe(1);
    expect(guard.hasActiveMutations()).toBe(true);

    expect(
      second.settle({ succeeded: true, confirmed: [confirm(OTHER_KEY, false)] }),
    ).toEqual({ status: "reconciled" });
    expect(guard.pendingHintCount()).toBe(0);
    expect(guard.hasActiveMutations()).toBe(false);
  });

  it("keeps a settled claim from every key it registered", () => {
    const guard = new InternalFsOperationGuard();
    // A rename claims two keys: the source is removed and the destination is
    // created, and both must stop being claimed once it settles.
    const rename = guard.beginMutation({
      kind: "rename",
      claims: [claim(NOTES_KEY, "remove"), claim(OTHER_KEY, "create")],
    });

    guard.capture(hint(NOTES_KEY, "removed"));
    guard.capture(hint(OTHER_KEY, "created"));

    expect(
      rename.settle({
        succeeded: true,
        confirmed: [confirm(NOTES_KEY, false), confirm(OTHER_KEY, true)],
      }),
    ).toEqual({ status: "reconciled" });
    expect(guard.hasActiveMutations()).toBe(false);
    // With nothing in flight, no path is claimed any more.
    expect(guard.capture(hint(OTHER_KEY, "changed"))).toBe(false);
    expect(guard.pendingHintCount()).toBe(0);
  });

  it("lets a stale settlement leave a newer claim's hints alone", () => {
    const guard = new InternalFsOperationGuard();
    const older = guard.beginMutation({
      kind: "save",
      claims: [claim(NOTES_KEY, "write")],
    });
    const newer = guard.beginMutation({
      kind: "save-as",
      claims: [claim(NOTES_KEY, "write")],
    });
    const changed = hint(NOTES_KEY, "changed");

    guard.capture(changed);

    // The newer claim owns the key now, so the older settlement must not report
    // the hint (its own confirmation is irrelevant) and must not clear it.
    expect(
      older.settle({ succeeded: true, confirmed: [confirm(NOTES_KEY, true)] }),
    ).toEqual({ status: "reconciled" });
    expect(guard.pendingHintCount()).toBe(1);
    expect(guard.hasActiveMutations()).toBe(true);

    // Settling the same operation twice changes nothing at all.
    expect(
      older.settle({ succeeded: false, confirmed: [] }),
    ).toEqual({ status: "superseded" });
    expect(guard.pendingHintCount()).toBe(1);
    expect(guard.hasActiveMutations()).toBe(true);

    // The newer operation owns the reconciliation of everything still held there.
    expect(
      newer.settle({ succeeded: true, confirmed: [confirm(NOTES_KEY, true)] }),
    ).toEqual({ status: "reconciled" });
    expect(guard.pendingHintCount()).toBe(0);
    expect(guard.hasActiveMutations()).toBe(false);
  });

  it("lets a newer claim on one key coexist with an older operation's other key", () => {
    const guard = new InternalFsOperationGuard();
    const rename = guard.beginMutation({
      kind: "rename",
      claims: [claim(NOTES_KEY, "remove"), claim(OTHER_KEY, "create")],
    });
    // A later save takes over the destination key only.
    const save = guard.beginMutation({
      kind: "save",
      claims: [claim(OTHER_KEY, "write")],
    });

    guard.capture(hint(NOTES_KEY, "removed"));
    guard.capture(hint(OTHER_KEY, "created"));

    // The source key is still the rename's, so it resolves normally; the
    // destination key belongs to the save now, so its hint stays pending.
    expect(
      rename.settle({
        succeeded: true,
        confirmed: [confirm(NOTES_KEY, false), confirm(OTHER_KEY, true)],
      }),
    ).toEqual({ status: "reconciled" });
    expect(guard.pendingHintCount()).toBe(1);
    expect(guard.hasActiveMutations()).toBe(true);

    expect(
      save.settle({ succeeded: true, confirmed: [confirm(OTHER_KEY, true)] }),
    ).toEqual({ status: "reconciled" });
    expect(guard.pendingHintCount()).toBe(0);
  });

  it("clears active mutations and pending hints on dispose", () => {
    const guard = new InternalFsOperationGuard();
    const operation = guard.beginMutation({
      kind: "save",
      claims: [claim(NOTES_KEY, "write")],
    });
    guard.capture(hint(NOTES_KEY, "changed"));

    guard.dispose();

    expect(guard.hasActiveMutations()).toBe(false);
    expect(guard.pendingHintCount()).toBe(0);
    expect(guard.capture(hint(NOTES_KEY, "changed"))).toBe(false);
    // Discarding is not settling: an operation that was dropped mid-flight has
    // nothing left to reconcile.
    expect(operation.settle({ succeeded: true, confirmed: [] })).toEqual({
      status: "superseded",
    });

    // Disposal only drops state; a later mutation is tracked normally.
    const restarted = guard.beginMutation({
      kind: "save",
      claims: [claim(NOTES_KEY, "write")],
    });
    expect(guard.capture(hint(NOTES_KEY, "changed"))).toBe(true);
    expect(
      restarted.settle({ succeeded: true, confirmed: [confirm(NOTES_KEY, true)] }),
    ).toEqual({ status: "reconciled" });
  });

  it("holds two identical hint bursts instead of suppressing the second", () => {
    const guard = new InternalFsOperationGuard();
    const operation = guard.beginMutation({
      kind: "save",
      claims: [claim(NOTES_KEY, "write")],
    });
    const duplicate = hint(NOTES_KEY, "changed");

    // "Ignore the next N events" is forbidden (FR-035), so an identical second
    // burst is captured and reported just like the first one.
    expect(guard.capture(duplicate)).toBe(true);
    expect(guard.capture(duplicate)).toBe(true);
    expect(guard.pendingHintCount()).toBe(2);

    expect(
      operation.settle({ succeeded: true, confirmed: [confirm(NOTES_KEY, false)] }),
    ).toEqual({ status: "diverged", unreconciled: [duplicate, duplicate] });
    expect(guard.pendingHintCount()).toBe(0);
  });

  it("keeps a hint pending for a mutation that never settles", () => {
    const guard = new InternalFsOperationGuard();
    const unsettled = guard.beginMutation({
      kind: "save",
      claims: [claim(NOTES_KEY, "write")],
    });
    const changed = hint(NOTES_KEY, "changed");
    guard.capture(changed);

    // Arbitrary unrelated activity — including other operations opening and
    // settling — cannot age the hint out, because nothing in this guard measures
    // time or counts events.
    for (const key of [OTHER_KEY, "c:\\work\\third.txt"]) {
      const other = guard.beginMutation({
        kind: "save-as",
        claims: [claim(key, "write")],
      });
      guard.capture(hint(key, "changed"));
      other.settle({ succeeded: true, confirmed: [confirm(key, true)] });
    }

    expect(guard.pendingHintCount()).toBe(1);
    expect(guard.hasActiveMutations()).toBe(true);

    // The hint is still there when its own operation finally settles, and it is
    // judged against that operation's real disk observation.
    expect(
      unsettled.settle({ succeeded: true, confirmed: [confirm(NOTES_KEY, false)] }),
    ).toEqual({ status: "diverged", unreconciled: [changed] });
    expect(guard.pendingHintCount()).toBe(0);
  });

  it("keys hints by comparison key and carries the observed path untouched", () => {
    const guard = new InternalFsOperationGuard();
    const operation = guard.beginMutation({
      kind: "save",
      claims: [claim(NOTES_KEY, "write")],
    });
    // A different spelling of the same file: identity is the comparison key, and
    // the path is exactly what the caller must validate.
    const observed = hint(NOTES_KEY, "changed", NOTES_PATH);

    expect(guard.capture(observed)).toBe(true);
    expect(
      operation.settle({ succeeded: true, confirmed: [confirm(NOTES_KEY, false)] }),
    ).toEqual({ status: "diverged", unreconciled: [observed] });
  });
});
