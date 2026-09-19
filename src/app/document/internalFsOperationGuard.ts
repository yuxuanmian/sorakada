/**
 * Reconciles watcher hints that Sorakada's *own* filesystem mutations produced.
 *
 * Save, Save As, the file-recreate branch of Save, Rename and Delete all make the
 * watched paths change, so the backend reports the very work the user just asked
 * for. Treated naively those hints look like outside edits: a clean document would
 * reload itself, a dirty one would report a conflict with itself (FR-035).
 *
 * The guard therefore never suppresses anything by *shape* — no "ignore the next N
 * events" counter and no short timeout is allowed, because both are guesses about
 * which hints were ours, and a genuine outside edit that lands inside the guessed
 * interval is silently swallowed (FR-035, FR-036). Instead:
 *
 * 1. `beginMutation` claims the paths an operation is about to change;
 * 2. hints for a claimed path are *held* rather than validated immediately, and
 *    every hint for any other path is passed straight through, so an unrelated
 *    outside change is never delayed;
 * 3. `settle` receives the caller's authoritative post-operation observation of
 *    the disk, and only hints that observation actually explains are reconciled.
 *    Anything left over is a divergence candidate the caller must validate.
 *
 * Deliberate consequences of that design:
 *
 * - A successful operation that produces no hints at all is reconciled, because
 *   there is nothing to explain.
 * - A claimed key the caller could not confirm (`succeeded: true` with no
 *   confirmation for it) can never be declared internal, so its hints surface.
 * - A hint kind the claimed effect cannot produce — `removed` during a write, or
 *   any `invalidated`/`other` hint, which says nothing about *this* path — is
 *   never reconciled. Invalidation in particular means the backend cannot promise
 *   its stream was complete, so it must reach the consumer as a revalidation
 *   request even while an internal operation happens to be in flight (FR-038).
 *
 * Everything is keyed by the caller's comparison key, never by a raw path string,
 * because equivalent spellings of one file are one interest. The `path` of a
 * captured hint is carried through untouched so the caller can validate exactly
 * what was last observed.
 *
 * The mechanism knows nothing about documents, is reusable by a future Move/New
 * operation, and involves no timer, no counter and no clock reading: there is no
 * API to "wait out" a hint, which is the point. Hints for an operation that never
 * settles stay pending indefinitely, and a newer claim on a key always owns that
 * key, so a stale completion cannot clear what its successor still needs.
 */

/**
 * What kind of internal filesystem mutation is in flight (descriptive only).
 *
 * The reconciliation decision never reads this value — it is decided from each
 * claim's {@link InternalPathClaim.effect} and the caller's confirmed
 * post-operation state — so a future 006 Move or New operation only has to
 * describe its own path effects to reuse the guard unchanged. `move` is listed
 * because that is the next operation the plan anticipates (a move is a `remove`
 * claim on the source plus a `create` claim on the destination).
 */
export type InternalFsOperationKind =
  | "save"
  | "save-as"
  | "recreate"
  | "create"
  | "rename"
  | "move"
  | "delete"
  | "unknown";

/** The kind of hint the guard may capture. */
export type InternalHintKind =
  | "created"
  | "changed"
  | "removed"
  | "other"
  | "invalidated";

/** One hint offered to the guard, already keyed by the consumer's comparison identity. */
export interface CapturedWatchHint {
  comparisonKey: string;
  path: string;
  kind: InternalHintKind;
}

/** What the operation does to one path. */
export interface InternalPathClaim {
  path: string;
  comparisonKey: string;
  effect: "write" | "create" | "remove";
}

export interface FsMutationRequest {
  kind: InternalFsOperationKind;
  claims: readonly InternalPathClaim[];
}

/** The caller's authoritative post-operation observation of one claimed path. */
export interface InternalPathConfirmation {
  comparisonKey: string;
  /** Whether the path exists on disk after the operation settled. */
  exists: boolean;
}

export interface FsMutationSettlement {
  /** Whether the filesystem operation itself succeeded. */
  succeeded: boolean;
  /**
   * Confirmed post-operation observations for the claimed paths.
   *
   * A claimed key with no entry here could not be confirmed, and every captured
   * hint for it must therefore be surfaced instead of being declared internal.
   */
  confirmed: readonly InternalPathConfirmation[];
}

export type FsMutationOutcome =
  | { status: "reconciled" }
  /**
   * The post-operation disk state does not explain these captured hints, so they
   * are genuine divergence candidates the caller must validate. They are not
   * swallowed and not suppressed.
   */
  | { status: "diverged"; unreconciled: readonly CapturedWatchHint[] }
  /** This operation had already settled (or was never begun); nothing was changed. */
  | { status: "superseded" };

/** A mutation in flight. */
export interface InternalFsOperation {
  readonly operationId: number;
  readonly kind: InternalFsOperationKind;
  /** Settles exactly once; a later call resolves `superseded`. */
  settle(settlement: FsMutationSettlement): FsMutationOutcome;
}

/**
 * One mutation the guard is tracking.
 *
 * The claim list is kept as a key -> effect map rather than a list of paths: a
 * rename registers two keys, and a repeated key inside one request must resolve to
 * the newest claim for that key.
 */
interface ActiveFsMutation {
  readonly operationId: number;
  readonly kind: InternalFsOperationKind;
  /** comparisonKey -> what this mutation does to that path. */
  readonly effects: Map<string, InternalPathClaim["effect"]>;
}

export class InternalFsOperationGuard {
  private readonly mutations = new Map<number, ActiveFsMutation>();
  /**
   * comparisonKey -> the newest mutation that claimed it.
   *
   * A key has exactly one authoritative owner, so a stale settlement can tell
   * "this is still mine" from "a newer operation owns it now" without any
   * generation counter on the hint itself.
   */
  private readonly owners = new Map<string, number>();
  /**
   * comparisonKey -> hints held until that key's owner settles.
   *
   * Hints live per key rather than per operation deliberately: when a newer
   * operation takes over a key it inherits whatever is still unexplained there,
   * and the older operation's settlement must leave that state alone.
   */
  private readonly held = new Map<string, CapturedWatchHint[]>();

  /**
   * comparisonKey -> how many hints have ever been held for it (monotonic).
   *
   * Used only to detect that a notification arrived after a proof (T064); see
   * {@link InternalFsOperationGuard.capturedHintCountFor}.
   */
  private readonly captured = new Map<string, number>();
  private nextOperationId = 1;

  /** Begins a mutation. Calling it twice for the same path is allowed; the newer claim owns the path. */
  beginMutation(request: FsMutationRequest): InternalFsOperation {
    const operationId = this.nextOperationId;
    this.nextOperationId += 1;

    const effects = new Map<string, InternalPathClaim["effect"]>();
    for (const claim of request.claims) {
      // A later claim for the same key in one request is the newer intent, so it
      // replaces the earlier effect instead of registering a second entry.
      effects.set(claim.comparisonKey, claim.effect);
    }

    const mutation: ActiveFsMutation = { operationId, kind: request.kind, effects };
    this.mutations.set(operationId, mutation);

    for (const comparisonKey of effects.keys()) {
      this.owners.set(comparisonKey, operationId);
    }

    return {
      operationId,
      kind: request.kind,
      settle: (settlement) => this.settle(mutation, settlement),
    };
  }

  /**
   * Offers one incoming hint to the guard.
   *
   * Returns `true` when the hint concerns a path an active mutation claimed, in
   * which case the caller must NOT validate it immediately — the settle step
   * decides. Returns `false` for every other path, so an unrelated outside change
   * is never delayed or swallowed.
   */
  capture(hint: CapturedWatchHint): boolean {
    if (!this.owners.has(hint.comparisonKey)) {
      return false;
    }

    this.captured.set(
      hint.comparisonKey,
      (this.captured.get(hint.comparisonKey) ?? 0) + 1,
    );

    const pending = this.held.get(hint.comparisonKey);
    if (pending === undefined) {
      this.held.set(hint.comparisonKey, [hint]);
    } else {
      // No deduplication and no cap: every observation is kept, because deciding
      // that "we have already seen this one" is exactly the count-based
      // suppression FR-035 forbids.
      pending.push(hint);
    }

    return true;
  }

  /**
   * How many hints have ever been held for one canonical comparison key.
   *
   * Monotonic: settling a key does not reset it. It exists so a writer can tell
   * whether a notification arrived *after* a proof it just took (T064) — a
   * question the held set cannot answer, because held hints are only released when
   * the operation settles.
   *
   * This is deliberately **not** count-based suppression: the number only ever
   * triggers additional verification (another read-back of the disk), and the
   * decision to treat a notification as internal still comes from that disk
   * evidence plus the ordering fact that nothing arrived after it. Nothing is ever
   * declared internal because "the count was expected".
   */
  capturedHintCountFor(comparisonKey: string): number {
    return this.captured.get(comparisonKey) ?? 0;
  }

  /** Whether any mutation is currently in flight. */
  hasActiveMutations(): boolean {
    return this.mutations.size > 0;
  }

  /** How many hints are currently held pending reconciliation (test seam). */
  pendingHintCount(): number {
    let total = 0;
    for (const hints of this.held.values()) {
      total += hints.length;
    }
    return total;
  }

  /** Drops all state; pending hints are discarded. */
  dispose(): void {
    this.mutations.clear();
    this.owners.clear();
    this.held.clear();
    this.captured.clear();
  }

  /**
   * Reconciles one mutation against the caller's post-operation observation.
   *
   * Only the keys this mutation still owns are decided here. A key a newer
   * mutation has since claimed keeps its held hints, and this settlement neither
   * reports nor clears them — the newer operation's settlement owns that
   * reconciliation, which is what keeps a stale completion from resolving newer
   * state.
   */
  private settle(
    mutation: ActiveFsMutation,
    settlement: FsMutationSettlement,
  ): FsMutationOutcome {
    if (this.mutations.get(mutation.operationId) !== mutation) {
      // Already settled, or dropped by `dispose()`: a second settlement must not
      // consume hints that belong to whatever is in flight now.
      return { status: "superseded" };
    }

    this.mutations.delete(mutation.operationId);

    const held: CapturedWatchHint[] = [];
    for (const comparisonKey of mutation.effects.keys()) {
      if (this.owners.get(comparisonKey) !== mutation.operationId) {
        continue;
      }

      this.owners.delete(comparisonKey);

      const pending = this.held.get(comparisonKey);
      if (pending === undefined) {
        continue;
      }
      this.held.delete(comparisonKey);
      held.push(...pending);
    }

    if (held.length === 0) {
      // Nothing was observed for the paths this mutation still owns, so there is
      // nothing the disk state would have to explain.
      return { status: "reconciled" };
    }

    if (!settlement.succeeded) {
      // A failed operation explains nothing: every hint held for it is a
      // divergence candidate rather than an internal event.
      return { status: "diverged", unreconciled: held };
    }

    const confirmed = new Map<string, boolean>();
    for (const observation of settlement.confirmed) {
      confirmed.set(observation.comparisonKey, observation.exists);
    }

    const unreconciled = held.filter((hint) => {
      const effect = mutation.effects.get(hint.comparisonKey);
      const exists = confirmed.get(hint.comparisonKey);
      if (effect === undefined || exists === undefined) {
        // An unconfirmed claimed key cannot be declared internal: "we could not
        // check" is not evidence that the hint was ours.
        return true;
      }
      return !isExplainedBy(effect, exists, hint.kind);
    });

    if (unreconciled.length > 0) {
      return { status: "diverged", unreconciled };
    }

    return { status: "reconciled" };
  }
}

/**
 * Whether a confirmed post-operation disk state explains one hint kind.
 *
 * The pairing is deliberately narrow. A write or a create can explain a path that
 * exists now, and a remove can explain one that is gone; everything else — a
 * removal reported for a path the write left in place, or an `invalidated`/`other`
 * hint, which describes the stream rather than this path — stays unexplained and
 * is handed to the caller as a divergence candidate. Erring that way costs one
 * extra validation, while erring the other way silently discards a real outside
 * edit.
 */
function isExplainedBy(
  effect: InternalPathClaim["effect"],
  exists: boolean,
  kind: InternalHintKind,
): boolean {
  switch (kind) {
    case "created":
    case "changed":
      return exists && (effect === "write" || effect === "create");
    case "removed":
      return !exists && effect === "remove";
    case "other":
    case "invalidated":
      return false;
  }
}
