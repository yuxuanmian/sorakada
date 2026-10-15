import { describe, expect, it } from "vitest";

import type {
  DiskRevision,
  DocumentPathInspection,
  FileCommandError,
  FileService,
  OpenTextFileResult,
  ResolvedPathIdentity,
  WriteTextFileRequest,
} from "../../services/fileService";
import { NEW_DOCUMENT_FORMAT, type TextFormat } from "./documentSession";
import {
  DiskValidator,
  refreshedIdentity,
  revisionsMatch,
  type DiskBinding,
  type DiskValidationRequest,
  type DiskValidationTrigger,
} from "./diskValidation";

/* -------------------------------------------------------------------------- */
/* Test doubles                                                               */
/* -------------------------------------------------------------------------- */

const DEFAULT_FORMAT: TextFormat = { ...NEW_DOCUMENT_FORMAT };

/** Comparison key the fake resolves a path to. */
function keyFor(path: string): string {
  return path.replace(/\\/g, "/");
}

interface FakeEntry {
  revision: DiskRevision | null;
  text: string;
  format: TextFormat;
}

/**
 * Stands in for the Rust-backed file service.
 *
 * It models exactly what `diskValidation` is allowed to observe: a registered
 * file with a chosen revision, a directory, a path that cannot be verified, and
 * a path that is gone. Reads and inspections can be held open so an in-flight
 * asynchronous completion can be observed without any OS or filesystem timing.
 */
class FakeFileService implements FileService {
  /** Every `inspectDocumentPath` argument, in call order. */
  readonly inspections: string[] = [];
  /** Every `readTextFile` argument, in call order. */
  readonly reads: string[] = [];

  /** Rejection injected into `inspectDocumentPath`; `unknown` so a raw Error can be used too. */
  inspectError: unknown = null;
  /** Rejection injected into `readTextFile`; `unknown` so a raw Error can be used too. */
  readError: unknown = null;
  holdReads = false;
  holdInspections = false;

  private readonly files = new Map<string, FakeEntry>();
  private readonly directories = new Set<string>();
  /** Paths that currently exist but cannot be verified; value is the inspection message. */
  private readonly unreadable = new Map<string, string | null>();
  /** Reported comparison key overrides, to model a path naming a different object. */
  private readonly comparisonKeys = new Map<string, string>();

  private pendingReads: Array<() => void> = [];
  private pendingInspections: Array<() => void> = [];

  /* -------- fixtures -------- */

  addFile(
    path: string,
    revision: DiskRevision | null,
    text = "",
    format: TextFormat = DEFAULT_FORMAT,
  ): void {
    this.files.set(keyFor(path), { revision, text, format: { ...format } });
  }

  /** Changes the observed revision of a registered file, as an external edit would. */
  setRevision(path: string, revision: DiskRevision | null): void {
    const entry = this.files.get(keyFor(path));
    if (entry === undefined) {
      throw new Error(`No fixture registered for ${path}`);
    }
    entry.revision = revision;
  }

  /** Models an external delete (or rename/move away from the bound path). */
  removeFile(path: string): void {
    this.files.delete(keyFor(path));
  }

  /** Models the bound path becoming a folder. */
  addDirectory(path: string): void {
    this.files.delete(keyFor(path));
    this.directories.add(keyFor(path));
  }

  /** Models a locked/permission-denied path that still exists. */
  addUnreadable(path: string, message: string | null): void {
    this.files.delete(keyFor(path));
    this.unreadable.set(keyFor(path), message);
  }

  /** Makes the inspection of `path` report an unrelated object's comparison key. */
  setComparisonKey(path: string, comparisonKey: string): void {
    this.comparisonKeys.set(keyFor(path), comparisonKey);
  }

  /* -------- FileService -------- */

  inspectDocumentPath(path: string): Promise<DocumentPathInspection> {
    this.inspections.push(path);

    if (this.inspectError !== null) {
      return Promise.reject(this.inspectError);
    }

    const inspection = this.inspectionFor(path);
    if (!this.holdInspections) {
      return Promise.resolve(inspection);
    }

    return new Promise<DocumentPathInspection>((resolve) => {
      this.pendingInspections.push(() => resolve(inspection));
    });
  }

  /**
   * Validation never creates anything, so a call here is a test bug.
   */
  createTextFileIfAbsent(): Promise<void> {
    return Promise.reject(new Error("not used by these tests"));
  }
  readTextFile(path: string): Promise<OpenTextFileResult> {
    this.reads.push(path);

    if (this.readError !== null) {
      return Promise.reject(this.readError);
    }

    const entry = this.files.get(keyFor(path));
    if (entry === undefined) {
      return Promise.reject({
        code: "io_read",
        message: `No fixture registered for ${path}`,
      } satisfies FileCommandError);
    }

    const result: OpenTextFileResult = {
      text: entry.text,
      format: { ...entry.format },
    };
    if (!this.holdReads) {
      return Promise.resolve(result);
    }

    return new Promise<OpenTextFileResult>((resolve) => {
      this.pendingReads.push(() => resolve(result));
    });
  }

  /**
   * Unused by `diskValidation`: the validator owns inspection and reading only.
   * Failing loudly is the point — a validation that started writing or
   * resolving Save As destinations would be a contract breach, not a test
   * inconvenience.
   */
  inspectFilePath(
    _path: string,
    _allowMissing: boolean,
  ): Promise<ResolvedPathIdentity> {
    return Promise.reject(
      new Error("diskValidation must not call inspectFilePath."),
    );
  }

  writeTextFile(_request: WriteTextFileRequest): Promise<void> {
    return Promise.reject(
      new Error("diskValidation must not call writeTextFile."),
    );
  }

  /* -------- test control -------- */

  releaseReads(): void {
    const pending = this.pendingReads;
    this.pendingReads = [];
    for (const resolve of pending) {
      resolve();
    }
  }

  releaseInspections(): void {
    const pending = this.pendingInspections;
    this.pendingInspections = [];
    for (const resolve of pending) {
      resolve();
    }
  }

  pendingReadCount(): number {
    return this.pendingReads.length;
  }

  pendingInspectionCount(): number {
    return this.pendingInspections.length;
  }

  /* -------- internals -------- */

  private inspectionFor(path: string): DocumentPathInspection {
    const key = keyFor(path);
    const comparisonKey = this.comparisonKeys.get(key) ?? key;

    if (this.unreadable.has(key)) {
      return {
        requestedPath: path,
        canonicalPath: null,
        comparisonKey: null,
        state: "unreadable",
        diskRevision: null,
        message: this.unreadable.get(key) ?? null,
      };
    }

    if (this.directories.has(key)) {
      return {
        requestedPath: path,
        canonicalPath: key,
        comparisonKey,
        state: "directory",
        diskRevision: null,
        message: null,
      };
    }

    const entry = this.files.get(key);
    if (entry === undefined) {
      return {
        requestedPath: path,
        canonicalPath: null,
        comparisonKey: null,
        state: "missing",
        diskRevision: null,
        message: null,
      };
    }

    return {
      requestedPath: path,
      canonicalPath: key,
      comparisonKey,
      state: "file",
      diskRevision: entry.revision,
      message: null,
    };
  }
}

/* -------------------------------------------------------------------------- */
/* Fixtures and helpers                                                       */
/* -------------------------------------------------------------------------- */

const PATH = "D:\\project\\notes.txt";
const KEY = "D:/project/notes.txt";
const DOCUMENT_ID = "doc-1";
/** The binding's 006 object token, carried through every refreshed identity. */
const OBJECT_IDENTITY = "win:12345678:00000000000000ab";

const REVISION_A: DiskRevision = {
  size: 12,
  modifiedTimeMillis: 1_700_000_000_000,
};
const REVISION_B: DiskRevision = {
  size: 34,
  modifiedTimeMillis: 1_700_000_100_000,
};
const TEXT_A = "alpha\n";
const TEXT_B = "beta\ngamma\n";

/** The identity a `changed`/`unchanged` result for `PATH` must report. */
function expectedIdentity(revision: DiskRevision | null): ResolvedPathIdentity {
  return {
    requestedPath: PATH,
    canonicalPath: KEY,
    comparisonKey: KEY,
    kind: "file",
    diskRevision: revision,
    // 005's inspection carries no object token, so the validator reports the
    // binding's own continuity evidence rather than inventing one.
    objectIdentity: OBJECT_IDENTITY,
  };
}

/** The binding the session would hold after adopting `revision`. */
function bindingFor(
  revision: DiskRevision | null,
  overrides: Partial<DiskBinding> = {},
): DiskBinding {
  return {
    documentId: DOCUMENT_ID,
    path: PATH,
    comparisonKey: KEY,
    generation: 1,
    identity: expectedIdentity(revision),
    ...overrides,
  };
}

function requestFor(
  binding: DiskBinding,
  trigger: DiskValidationTrigger = "watcher-hint",
  isCurrent?: () => boolean,
): DiskValidationRequest {
  return { binding, trigger, isCurrent };
}

function setup(): { files: FakeFileService; validator: DiskValidator } {
  const files = new FakeFileService();
  return { files, validator: new DiskValidator({ fileService: files }) };
}

/** Lets every already-queued microtask run, so an in-flight validation reaches its next await. */
async function flushMicrotasks(): Promise<void> {
  for (let step = 0; step < 10; step += 1) {
    await Promise.resolve();
  }
}

/* -------------------------------------------------------------------------- */
/* Unchanged documents (SC-008)                                               */
/* -------------------------------------------------------------------------- */

describe("DiskValidator unchanged documents", () => {
  const triggers: readonly DiskValidationTrigger[] = [
    "window-focus",
    "tab-activate",
    "watcher-hint",
  ];

  for (const trigger of triggers) {
    // FR-012, SC-008: an idle/focus sweep of unchanged documents performs zero
    // full-content reads — for every trigger, including a watcher hint. The
    // revision fast path is the reason a burst of hints stays cheap.
    it(`reports unchanged for a ${trigger} trigger without reading the file`, async () => {
      const { files, validator } = setup();
      files.addFile(PATH, REVISION_A, TEXT_A);

      const result = await validator.validate(
        requestFor(bindingFor(REVISION_A), trigger),
      );

      expect(result).toEqual({
        outcome: "unchanged",
        identity: expectedIdentity(REVISION_A),
      });
      expect(files.reads).toEqual([]);
      expect(files.inspections).toEqual([PATH]);
    });
  }

  it("reports unchanged for a dirty caller with matching metadata", async () => {
    // FR-009: dirty and external state are independent; a dirty document whose
    // disk revision still matches has nothing external to report.
    const { files, validator } = setup();
    files.addFile(PATH, REVISION_A, TEXT_A);

    const result = await validator.validate(
      requestFor(bindingFor(REVISION_A), "pre-save"),
    );

    expect(result).toEqual({
      outcome: "unchanged",
      identity: expectedIdentity(REVISION_A),
    });
    expect(files.reads).toEqual([]);
  });
});

/* -------------------------------------------------------------------------- */
/* Changed documents                                                          */
/* -------------------------------------------------------------------------- */

describe("DiskValidator changed documents", () => {
  it("reports changed with content for a clean caller and reads exactly once", async () => {
    // FR-016: a clean document may adopt the disk version, so the caller needs
    // the content and pays for exactly one read.
    const { files, validator } = setup();
    files.addFile(PATH, REVISION_A, TEXT_B);
    files.setRevision(PATH, REVISION_B);

    const result = await validator.validate(
      requestFor(bindingFor(REVISION_A), "watcher-hint"),
    );

    expect(result).toEqual({
      outcome: "changed",
      identity: expectedIdentity(REVISION_B),
      content: { text: TEXT_B, format: DEFAULT_FORMAT },
    });
    expect(files.reads).toEqual([PATH]);
    expect(files.inspections).toEqual([PATH]);
  });

  it("reads the snapshot for a dirty caller too, so the caller can tell a touch from a divergence (T061)", async () => {
    // FR-021, FR-022 with T061: a dirty document must not be auto-reloaded, but
    // "the revision moved" is not "the content changed". Only the snapshot can
    // distinguish a metadata-only touch — which must leave the document dirty and
    // external `normal` — from a real divergence, so the validator has to read it.
    // What the caller may *do* with it stays a document-state decision.
    const { files, validator } = setup();
    files.addFile(PATH, REVISION_B, TEXT_B);

    const result = await validator.validate(requestFor(bindingFor(REVISION_A)));

    expect(result).toEqual({
      outcome: "changed",
      identity: expectedIdentity(REVISION_B),
      content: { text: TEXT_B, format: DEFAULT_FORMAT },
    });
    expect(files.reads).toEqual([PATH]);
  });

  it("reads when the adopted revision is unknown, even if the observation looks equal", async () => {
    // Rule 9: an unknown adopted revision can never be treated as "unchanged".
    // A document whose baseline revision was never recorded has to escalate to
    // a read, and the caller then compares the returned text with its baseline.
    const { files, validator } = setup();
    files.addFile(PATH, REVISION_A, TEXT_A);

    const result = await validator.validate(
      requestFor(bindingFor(null), "tab-activate"),
    );

    expect(result).toEqual({
      outcome: "changed",
      identity: expectedIdentity(REVISION_A),
      content: { text: TEXT_A, format: DEFAULT_FORMAT },
    });
    expect(files.reads).toEqual([PATH]);
  });

  it("returns an identity a caller can adopt so the next validation stays cheap", async () => {
    // FR-017: the refreshed identity carries the freshly observed revision, so
    // adopting it makes the next pass report `unchanged` with no read.
    const { files, validator } = setup();
    files.addFile(PATH, REVISION_B, TEXT_B);

    const first = await validator.validate(
      requestFor(bindingFor(REVISION_A), "watcher-hint"),
    );
    if (first.outcome !== "changed") {
      throw new Error(`Expected a changed result, received ${first.outcome}.`);
    }

    const adopted: DiskBinding = {
      ...bindingFor(REVISION_A),
      identity: first.identity,
      generation: 2,
    };
    const second = await validator.validate(
      requestFor(adopted, "window-focus"),
    );

    expect(second).toEqual({
      outcome: "unchanged",
      identity: expectedIdentity(REVISION_B),
    });
    expect(files.reads).toEqual([PATH]);
  });

  it("is stateless: two identical calls behave identically", async () => {
    // Rule 12: no cache, no attempt counter, no per-document memory.
    const { files, validator } = setup();
    files.addFile(PATH, REVISION_B, TEXT_B);

    const first = await validator.validate(
      requestFor(bindingFor(REVISION_A), "watcher-hint"),
    );
    const second = await validator.validate(
      requestFor(bindingFor(REVISION_A), "watcher-hint"),
    );

    expect(second).toEqual(first);
    expect(files.reads).toEqual([PATH, PATH]);
  });
});

/* -------------------------------------------------------------------------- */
/* Missing, unreadable and directory states                                   */
/* -------------------------------------------------------------------------- */

describe("DiskValidator non-file states", () => {
  it("reports missing without reading when the bound file is gone", async () => {
    // FR-014: a confirmed absence becomes `missing`, and there is nothing to read.
    const { files, validator } = setup();
    files.addFile(PATH, REVISION_A, TEXT_A);
    files.removeFile(PATH);

    const result = await validator.validate(
      requestFor(bindingFor(REVISION_A), "watcher-hint"),
    );

    expect(result).toEqual({ outcome: "missing" });
    expect(files.reads).toEqual([]);
  });

  it("reports unverifiable, not missing, when the read fails", async () => {
    // FR-015, FR-043: a transient read failure preserves the current buffer and
    // must never be converted into a deleted document.
    const { files, validator } = setup();
    files.addFile(PATH, REVISION_B, TEXT_B);
    files.readError = {
      code: "io_read",
      message: "The file is locked by another process.",
    } satisfies FileCommandError;

    const failed = await validator.validate(
      requestFor(bindingFor(REVISION_A), "watcher-hint"),
    );

    expect(failed).toEqual({
      outcome: "unverifiable",
      error: {
        code: "io_read",
        message: "The file is locked by another process.",
      },
    });
    expect(failed.outcome).not.toBe("missing");

    // A transport-level rejection is normalized to the same contract shape
    // rather than propagating into the caller.
    files.readError = new Error("EBUSY: sharing violation");
    const normalized = await validator.validate(
      requestFor(bindingFor(REVISION_A), "watcher-hint"),
    );

    expect(normalized).toEqual({
      outcome: "unverifiable",
      error: { code: "io_read", message: "EBUSY: sharing violation" },
    });
    expect(files.reads).toEqual([PATH, PATH]);
  });

  it("reports unverifiable with the inspection message when the path is unreadable", async () => {
    // Rule 4: `unreadable` is never missing, and the file is not read.
    const { files, validator } = setup();
    files.addUnreadable(PATH, "Access is denied.");

    const result = await validator.validate(
      requestFor(bindingFor(REVISION_A), "window-focus"),
    );

    expect(result).toEqual({
      outcome: "unverifiable",
      error: { code: "io_read", message: "Access is denied." },
    });
    expect(result.outcome).not.toBe("missing");
    expect(files.reads).toEqual([]);
  });

  it("describes an unreadable path itself when the inspection carries no message", async () => {
    const { files, validator } = setup();
    files.addUnreadable(PATH, null);

    const result = await validator.validate(
      requestFor(bindingFor(REVISION_A), "window-focus"),
    );

    expect(result.outcome).toBe("unverifiable");
    if (result.outcome !== "unverifiable") {
      throw new Error(`Expected unverifiable, received ${result.outcome}.`);
    }
    expect(result.error.code).toBe("io_read");
    expect(result.error.message).toContain(PATH);
    expect(files.reads).toEqual([]);
  });

  it("reports a folder, never missing, when the bound path became a directory", async () => {
    // Rule 5: the caller must not offer the missing-file recreate flow for a
    // path that a folder now occupies.
    const { files, validator } = setup();
    files.addDirectory(PATH);

    const result = await validator.validate(
      requestFor(bindingFor(REVISION_A), "watcher-hint"),
    );

    expect(result).toEqual({
      outcome: "unverifiable",
      error: {
        code: "path_resolution",
        message: `${PATH} is a folder, not a file.`,
      },
    });
    expect(result.outcome).not.toBe("missing");
    expect(files.reads).toEqual([]);
  });
});

/* -------------------------------------------------------------------------- */
/* Reappearance (FR-033, FR-034)                                              */
/* -------------------------------------------------------------------------- */

describe("DiskValidator reappearance", () => {
  it("turns a clean missing document into a changed result once the path reappears", async () => {
    // FR-033: the coordinator drives this by validating the same binding again
    // after a `missing` result, so the input it gets is pinned here.
    const { files, validator } = setup();
    const binding = bindingFor(REVISION_A);

    const before = await validator.validate(
      requestFor(binding, "reappearance"),
    );
    expect(before).toEqual({ outcome: "missing" });

    files.addFile(PATH, REVISION_B, TEXT_B);
    const after = await validator.validate(
      requestFor(binding, "reappearance"),
    );

    expect(after).toEqual({
      outcome: "changed",
      identity: expectedIdentity(REVISION_B),
      content: { text: TEXT_B, format: DEFAULT_FORMAT },
    });
    expect(files.reads).toEqual([PATH]);
  });

  it("hands a dirty missing document the reappeared snapshot for comparison (T061)", async () => {
    // FR-034 with T061: the dirty buffer is preserved, and the caller receives the
    // reappeared snapshot so it can tell whether the reappeared file merely holds
    // the baseline (nothing diverged) or really diverged from it.
    const { files, validator } = setup();
    const binding = bindingFor(REVISION_A);

    const before = await validator.validate(
      requestFor(binding, "reappearance"),
    );
    expect(before).toEqual({ outcome: "missing" });

    files.addFile(PATH, REVISION_B, TEXT_B);
    const after = await validator.validate(
      requestFor(binding, "reappearance"),
    );

    expect(after).toEqual({
      outcome: "changed",
      identity: expectedIdentity(REVISION_B),
      content: { text: TEXT_B, format: DEFAULT_FORMAT },
    });
    expect(files.reads).toEqual([PATH]);
  });
});

/* -------------------------------------------------------------------------- */
/* Staleness (FR-039)                                                         */
/* -------------------------------------------------------------------------- */

describe("DiskValidator staleness", () => {
  it("rejects a path that now names a different object without reading it", async () => {
    // Rule 3: the inspection reports another comparison key, so the result no
    // longer describes this binding and must never be applied.
    const { files, validator } = setup();
    files.addFile(PATH, REVISION_B, TEXT_B);
    files.setComparisonKey(PATH, "D:/elsewhere/notes.txt");

    const result = await validator.validate(
      requestFor(bindingFor(REVISION_A), "watcher-hint"),
    );

    expect(result).toEqual({ outcome: "stale" });
    expect(files.reads).toEqual([]);
  });

  it("short-circuits before any file-service call when the binding is already stale", async () => {
    // FR-039: a closed or rebound document must not produce IPC traffic at all.
    const { files, validator } = setup();
    files.addFile(PATH, REVISION_B, TEXT_B);

    const result = await validator.validate(
      requestFor(bindingFor(REVISION_A), "watcher-hint", () => false),
    );

    expect(result).toEqual({ outcome: "stale" });
    expect(files.inspections).toEqual([]);
    expect(files.reads).toEqual([]);
  });

  it("reports stale when the binding is invalidated while its read is in flight", async () => {
    // FR-039: the async-completion case — the path may have been closed or
    // rebound between the inspection and the read returning.
    const { files, validator } = setup();
    files.addFile(PATH, REVISION_B, TEXT_B);
    files.holdReads = true;

    let current = true;
    const pending = validator.validate(
      requestFor(bindingFor(REVISION_A), "pre-save", () => current),
    );

    await flushMicrotasks();
    expect(files.pendingReadCount()).toBe(1);

    current = false;
    files.releaseReads();

    expect(await pending).toEqual({ outcome: "stale" });
    expect(files.reads).toEqual([PATH]);
  });

  it("reports stale when the binding is invalidated while its inspection is in flight", async () => {
    const { files, validator } = setup();
    files.addFile(PATH, REVISION_B, TEXT_B);
    files.holdInspections = true;

    let current = true;
    const pending = validator.validate(
      requestFor(bindingFor(REVISION_A), "post-subscription", () => current),
    );

    await flushMicrotasks();
    expect(files.pendingInspectionCount()).toBe(1);

    current = false;
    files.releaseInspections();

    expect(await pending).toEqual({ outcome: "stale" });
    expect(files.reads).toEqual([]);
  });

  it("still validates when the predicate stays current across both awaits", async () => {
    const { files, validator } = setup();
    files.addFile(PATH, REVISION_B, TEXT_B);

    const result = await validator.validate(
      requestFor(bindingFor(REVISION_A), "pre-save", () => true),
    );

    expect(result.outcome).toBe("changed");
    expect(files.reads).toEqual([PATH]);
  });
});

/* -------------------------------------------------------------------------- */
/* Inspection rejection                                                       */
/* -------------------------------------------------------------------------- */

describe("DiskValidator inspection failures", () => {
  it("normalizes an inspection rejection instead of propagating it", async () => {
    // Rule 2: `inspect_document_path` does not reject by contract, so a
    // rejection is a transport/programming failure that must still reach the
    // caller as an unverifiable result.
    const { files, validator } = setup();
    files.addFile(PATH, REVISION_A, TEXT_A);
    files.inspectError = new Error("The IPC channel closed.");

    const transportFailure = await validator.validate(
      requestFor(bindingFor(REVISION_A), "watcher-hint"),
    );

    expect(transportFailure).toEqual({
      outcome: "unverifiable",
      error: { code: "io_read", message: "The IPC channel closed." },
    });

    const contractError: FileCommandError = {
      code: "path_resolution",
      message: "The path could not be resolved.",
    };
    files.inspectError = contractError;
    const structured = await validator.validate(
      requestFor(bindingFor(REVISION_A), "watcher-hint"),
    );

    expect(structured).toEqual({ outcome: "unverifiable", error: contractError });
    expect(files.reads).toEqual([]);
  });
});

/* -------------------------------------------------------------------------- */
/* Pure helpers                                                               */
/* -------------------------------------------------------------------------- */

describe("revisionsMatch", () => {
  it("never matches when either revision is unknown", () => {
    expect(revisionsMatch(null, null)).toBe(false);
    expect(revisionsMatch(null, REVISION_A)).toBe(false);
    expect(revisionsMatch(REVISION_A, null)).toBe(false);
  });

  it("matches only equal size and modification time", () => {
    expect(revisionsMatch(REVISION_A, { ...REVISION_A })).toBe(true);
    expect(
      revisionsMatch(
        { size: 5, modifiedTimeMillis: null },
        { size: 5, modifiedTimeMillis: null },
      ),
    ).toBe(true);
  });

  it("does not match when the size differs", () => {
    expect(
      revisionsMatch(REVISION_A, {
        ...REVISION_A,
        size: REVISION_A.size + 1,
      }),
    ).toBe(false);
  });

  it("does not match when the modification time differs", () => {
    expect(revisionsMatch(REVISION_A, REVISION_B)).toBe(false);
    expect(
      revisionsMatch(REVISION_A, { ...REVISION_A, modifiedTimeMillis: null }),
    ).toBe(false);
  });
});

describe("refreshedIdentity", () => {
  it("keeps the binding fallbacks and always reports kind file", () => {
    // Rule 10: a path whose parent vanished resolves to null keys, and the
    // binding's own identity is still the right answer.
    const binding = bindingFor(REVISION_A);
    const inspection: DocumentPathInspection = {
      requestedPath: PATH,
      canonicalPath: null,
      comparisonKey: null,
      state: "file",
      diskRevision: REVISION_B,
      message: null,
    };

    expect(refreshedIdentity(binding, inspection)).toEqual({
      requestedPath: PATH,
      canonicalPath: KEY,
      comparisonKey: KEY,
      kind: "file",
      diskRevision: REVISION_B,
      objectIdentity: OBJECT_IDENTITY,
    });
  });

  it("prefers freshly resolved fields but always keeps the bound path", () => {
    const binding = bindingFor(REVISION_A);
    const inspection: DocumentPathInspection = {
      requestedPath: "D:\\alias\\notes.txt",
      canonicalPath: "D:/real/notes.txt",
      comparisonKey: "D:/real/notes.txt",
      state: "file",
      diskRevision: REVISION_B,
      message: null,
    };

    expect(refreshedIdentity(binding, inspection)).toEqual({
      requestedPath: PATH,
      canonicalPath: "D:/real/notes.txt",
      comparisonKey: "D:/real/notes.txt",
      kind: "file",
      diskRevision: REVISION_B,
      // 005's inspection carries no object token, so the binding's own
      // continuity evidence is carried through instead of being invented.
      objectIdentity: OBJECT_IDENTITY,
    });
  });

  it("reports the observed revision even when the inspection cannot provide one", () => {
    const binding = bindingFor(REVISION_A);
    const inspection: DocumentPathInspection = {
      requestedPath: PATH,
      canonicalPath: KEY,
      comparisonKey: KEY,
      state: "file",
      diskRevision: null,
      message: null,
    };

    const identity = refreshedIdentity(binding, inspection);

    expect(identity.diskRevision).toBeNull();
    expect(revisionsMatch(identity.diskRevision, REVISION_A)).toBe(false);
  });
});

/* -------------------------------------------------------------------------- */
/* Forced validation after an external relocation (006)                        */
/* -------------------------------------------------------------------------- */

describe("DiskValidator external relocation", () => {
  it("reads the snapshot even when the revision matches the adopted baseline", async () => {
    // FR-061 / plan §11: a confirmed external relocation adopts the *destination's*
    // current metadata as the new baseline, so comparing that same revision back
    // would report "unchanged" for content the move rewrote. The forced trigger
    // therefore reads the supported snapshot instead of trusting the fast path.
    const { files, validator } = setup();
    files.addFile(PATH, REVISION_A, TEXT_B);

    const result = await validator.validate(
      requestFor(bindingFor(REVISION_A), "external-relocation"),
    );

    expect(result.outcome).toBe("changed");
    expect(files.reads).toEqual([PATH]);
  });

  it("still reports unchanged for the ordinary triggers with the same revision", async () => {
    // The fast path must stay intact for every other trigger: a focus sweep of
    // unchanged documents still performs zero full-content reads (SC-008).
    const { files, validator } = setup();
    files.addFile(PATH, REVISION_A, TEXT_B);

    const result = await validator.validate(
      requestFor(bindingFor(REVISION_A), "post-subscription"),
    );

    expect(result).toEqual({
      outcome: "unchanged",
      identity: expectedIdentity(REVISION_A),
    });
    expect(files.reads).toEqual([]);
  });

  it("reports missing at the new binding without inventing content", async () => {
    const { files, validator } = setup();
    files.removeFile(PATH);

    const result = await validator.validate(
      requestFor(bindingFor(REVISION_A), "external-relocation"),
    );

    // A relocated binding whose destination vanished again is simply missing:
    // 005's missing rules stay authoritative, and the forced read must not turn
    // absence into a change.
    expect(result).toEqual({ outcome: "missing" });
    expect(files.reads).toEqual([]);
  });
});
