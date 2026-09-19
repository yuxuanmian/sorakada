/**
 * Bound-path disk validation.
 *
 * A filesystem watcher only ever produces *hints* (FR-007). This module owns the
 * one explicit comparison that turns a hint — or a tab activation, a window
 * focus regain, a reappearance, or an imminent save — into an answer about what
 * is actually on disk right now: unchanged, changed, missing, temporarily
 * unverifiable, or no longer applicable.
 *
 * Three boundaries shape the design:
 *
 * 1. This module never mutates a `DocumentSession`, never touches CodeMirror and
 *    never decides which document state to enter. It returns an explicit
 *    `DiskValidationResult` and the caller applies it (FR-016–FR-020, FR-028,
 *    FR-029, FR-033, FR-034, FR-039, FR-043).
 * 2. Content comparison belongs to the document, not here. The validator returns
 *    the freshly read `OpenTextFileResult`; the caller compares its text against
 *    its own saved baseline, because the baseline is owned by the document
 *    (Constitution II).
 * 3. There is no timer, no attempt counter, no per-document cache and no mutable
 *    state beyond the injected `FileService`, so two identical calls produce
 *    identical observable behaviour.
 */

import type { DocumentId } from "./documentSession";
import {
  toFileCommandError,
  type DiskRevision,
  type DocumentPathInspection,
  type FileCommandError,
  type FileService,
  type OpenTextFileResult,
  type ResolvedPathIdentity,
} from "../../services/fileService";

/**
 * Why a validation is running. Each trigger gets a different intensity (plan §4).
 *
 * The validator itself deliberately treats every trigger identically: intensity
 * is expressed by how often the caller schedules a pass, so this field is
 * diagnostic context rather than a branch.
 */
export type DiskValidationTrigger =
  | "watcher-hint"
  | "tab-activate"
  | "window-focus"
  | "pre-save"
  | "post-subscription"
  | "reappearance";

/** The exact binding a result may still be applied to. */
export interface DiskBinding {
  documentId: DocumentId;
  /** The bound path exactly as the session spells it. */
  path: string;
  /** Comparison key of the bound path — the identity the result must still describe. */
  comparisonKey: string;
  /** Increments whenever the bound path changes; a stale result must never be applied. */
  generation: number;
  /** The identity/revision the session last adopted from disk. */
  identity: ResolvedPathIdentity;
}

export interface DiskValidationRequest {
  binding: DiskBinding;
  trigger: DiskValidationTrigger;
  /**
   * Checked before and after every await. When it reports false the result is
   * `stale`, because the document was closed or rebound while validation ran
   * (FR-039).
   */
  isCurrent?: () => boolean;
}

/** The explicit outcome of one validation. */
export type DiskValidationResult =
  | { outcome: "unchanged"; identity: ResolvedPathIdentity }
  | {
      outcome: "changed";
      identity: ResolvedPathIdentity;
      /**
       * The supported disk snapshot, read for comparison.
       *
       * Always present: a caller with a dirty buffer needs it just as much as a
       * clean one, because an identical snapshot is what distinguishes a
       * metadata-only touch from a real divergence (T061, spec Edge Cases). What
       * the caller may *do* with it — adopt it, or only compare it — is a
       * document-state decision that belongs to the document, not here
       * (Constitution II).
       */
      content: OpenTextFileResult;
    }
  | { outcome: "missing" }
  | { outcome: "unverifiable"; error: FileCommandError }
  | { outcome: "stale" };

/**
 * Whether two observed disk revisions describe the same disk state.
 *
 * This is the single definition of revision equality. Two revisions match only
 * when *both* are known and both observed metadata fields are equal: an unknown
 * revision on either side can never match, because "we never recorded one" and
 * "we could not observe one" must not masquerade as "unchanged".
 */
export function revisionsMatch(
  left: DiskRevision | null,
  right: DiskRevision | null,
): boolean {
  if (left === null || right === null) {
    return false;
  }

  return (
    left.size === right.size &&
    left.modifiedTimeMillis === right.modifiedTimeMillis
  );
}

/**
 * Builds the identity an `unchanged`/`changed` result reports.
 *
 * The freshly observed metadata wins, and the binding's values are the fallback
 * for the fields an inspection could not resolve (a vanished parent leaves
 * `canonicalPath`/`comparisonKey` null while still naming the same binding).
 * `kind` is always `"file"` because only a confirmed file reaches this helper.
 *
 * The result is directly usable to advance the session's adopted revision
 * without inspecting the path a second time (FR-017, FR-032).
 */
export function refreshedIdentity(
  binding: DiskBinding,
  inspection: DocumentPathInspection,
): ResolvedPathIdentity {
  return {
    requestedPath: binding.path,
    canonicalPath: inspection.canonicalPath ?? binding.identity.canonicalPath,
    comparisonKey: inspection.comparisonKey ?? binding.identity.comparisonKey,
    kind: "file",
    diskRevision: inspection.diskRevision,
  };
}

/** Whether a validation may still be applied to the binding it started from. */
function isStillCurrent(request: DiskValidationRequest): boolean {
  return request.isCurrent === undefined || request.isCurrent();
}

/**
 * Compares one document binding against the current state of its bound path.
 *
 * Stateless and side-effect free apart from the injected file-service calls, so
 * it can be driven by any trigger without coordination between callers.
 */
export class DiskValidator {
  private readonly fileService: FileService;

  constructor(deps: { fileService: FileService }) {
    this.fileService = deps.fileService;
  }

  async validate(
    request: DiskValidationRequest,
  ): Promise<DiskValidationResult> {
    const { binding } = request;

    // Stale first (rule 1): a document that was already closed or rebound must
    // not reach the file service at all, so a validation known to be
    // unapplicable never produces IPC traffic for a path this document no
    // longer owns (FR-039).
    if (!isStillCurrent(request)) {
      return { outcome: "stale" };
    }

    // Inspect, never read first (rule 2): the cheap metadata comparison decides
    // whether a full-content read is warranted. `inspect_document_path` reports
    // its own failures as explicit states instead of rejecting, so a rejection
    // here is a transport-level or programming failure that must still reach the
    // caller as an unverifiable state rather than propagate into its transition
    // logic.
    let inspection: DocumentPathInspection;
    try {
      inspection = await this.fileService.inspectDocumentPath(binding.path);
    } catch (error) {
      return {
        outcome: "unverifiable",
        error: toFileCommandError(error, "io_read"),
      };
    }

    if (!isStillCurrent(request)) {
      return { outcome: "stale" };
    }

    // Identity mismatch is stale (rule 3): the path no longer names the object
    // this binding was about — it was replaced by a different object, or the
    // caller rebound. A `null` comparison key is *not* a mismatch: a path whose
    // parent vanished cannot be resolved, and it is still the same binding.
    if (
      inspection.comparisonKey !== null &&
      inspection.comparisonKey !== binding.comparisonKey
    ) {
      return { outcome: "stale" };
    }

    switch (inspection.state) {
      case "unreadable":
        // `unreadable` is never missing (rule 4, FR-015, FR-043): a transient
        // read/permission/lock failure must never be converted into a deleted
        // document, and there is nothing safe to read yet.
        return {
          outcome: "unverifiable",
          error: {
            code: "io_read",
            message:
              inspection.message ??
              `${binding.path} could not be verified on disk.`,
          },
        };

      case "directory":
        // A bound file path that became a directory is a divergence, not an
        // absence (rule 5): the caller must not offer the missing-file
        // recreate flow for a path that is now occupied by a folder.
        return {
          outcome: "unverifiable",
          error: {
            code: "path_resolution",
            message: `${binding.path} is a folder, not a file.`,
          },
        };

      case "missing":
        // Confirmed absence (rule 6). No contents exist to read.
        return { outcome: "missing" };

      case "file":
        return await this.compareFile(request, inspection);
    }
  }

  /**
   * The `state: "file"` branch: compare revisions, then escalate to a read only
   * when the revision comparison cannot answer the question.
   */
  private async compareFile(
    request: DiskValidationRequest,
    inspection: DocumentPathInspection,
  ): Promise<DiskValidationResult> {
    const { binding } = request;
    const identity = refreshedIdentity(binding, inspection);

    // The documented fast path: a matching revision is "unchanged" for *every*
    // trigger — an idle/focus sweep of unchanged documents therefore performs
    // zero full-content reads (SC-008). `revisionsMatch` is false whenever either
    // side is null, so a match already implies the adopted revision is known.
    // 005 deliberately does not hash content in order to catch pathological
    // external edits that preserve every observed metadata field — see the spec's
    // Assumptions.
    if (revisionsMatch(binding.identity.diskRevision, inspection.diskRevision)) {
      return { outcome: "unchanged", identity };
    }

    // The revision moved, so the supported snapshot has to be read before any
    // conclusion — including for a dirty document. "The revision changed" is not
    // the same fact as "the content changed": a metadata-only touch (or a rewrite
    // with identical supported text) must not become a conflict, and only the
    // snapshot can prove which one happened (T061, spec Edge Cases).
    let content: OpenTextFileResult;
    try {
      content = await this.fileService.readTextFile(binding.path);
    } catch (error) {
      // The caller must keep the current buffer (FR-020, FR-043): a failed read
      // is unverifiable, never a change and never a missing document.
      return {
        outcome: "unverifiable",
        error: toFileCommandError(error, "io_read"),
      };
    }

    // The second await: a document closed or rebound while the read was in
    // flight must not be handed content for a path it no longer owns (FR-039).
    if (!isStillCurrent(request)) {
      return { outcome: "stale" };
    }

    // The validator deliberately does NOT compare `content` with the document's
    // saved baseline or format. Those belong to the document (Constitution II),
    // and a caller that knows them is the only one that can decide between
    // "adopt this", "this is a metadata-only touch" and "this is a conflict".
    // Doing that comparison here would give this module a second, hidden copy of
    // document state. Do not "optimize" it into this file.
    return { outcome: "changed", identity, content };
  }
}
