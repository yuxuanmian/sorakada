import { describe, expect, it } from "vitest";
import { EditorState } from "@codemirror/state";

import type { EditorHandle } from "../../editor/editorHandle";
import type {
  FileCommandError,
  FileService,
} from "../../services/fileService";
import type { FileDialogService } from "../../services/fileDialogs";
import type {
  ReadWorkspaceDirectoryResult,
  WorkspaceDirectoryEntry,
} from "../../services/workspaceFileService";
import type { WorkspaceDialogService } from "../../services/workspaceDialogs";
import type { ResolveWorkspaceRelationResult } from "../../services/workspaceFileService";
import { DocumentManager } from "../document/documentManager";
import { NEW_DOCUMENT_FORMAT } from "../document/documentSession";
import { WorkContextManager } from "./workContextManager";
import {
  derivePathRelation,
  displayNameForWorkspaceRoot,
  isInsideRoot,
  isWithinDirectory,
  joinPath,
  pathComponents,
  relativeWithinDirectory,
  toWorkspaceRelation,
  type WorkContext,
  type WorkspaceRelation,
  type WorkspaceRelationSource,
} from "./workContext";

/* -------------------------------------------------------------------------- */
/* Test doubles                                                               */
/* -------------------------------------------------------------------------- */

/**
 * Comparison keys the way the Rust side derives them: canonical and case-folded
 * on Windows, but still spelled with the platform separator.
 */
function keyFor(path: string): string {
  return path.toLowerCase();
}

class FakeWorkspaceService {
  readonly reads: string[] = [];

  private readonly directories = new Map<string, WorkspaceDirectoryEntry[]>();
  private readonly failures = new Map<string, FileCommandError>();
  private readonly aliases = new Map<string, string>();

  /** When set, every read stays pending until `release` is called. */
  hold = false;

  private held: Array<{
    path: string;
    resolve: (result: ReadWorkspaceDirectoryResult) => void;
    reject: (error: unknown) => void;
  }> = [];

  addDirectory(path: string, entries: WorkspaceDirectoryEntry[] = []): void {
    this.directories.set(keyFor(path), entries);
  }

  /** Registers an equivalent spelling that resolves to another directory. */
  addAlias(alias: string, canonical: string): void {
    this.aliases.set(keyFor(alias), canonical);
  }

  failWith(path: string, error: FileCommandError): void {
    this.failures.set(keyFor(path), error);
  }

  readWorkspaceDirectory(
    path: string,
  ): Promise<ReadWorkspaceDirectoryResult> {
    this.reads.push(path);

    if (!this.hold) {
      return new Promise<ReadWorkspaceDirectoryResult>((resolve, reject) => {
        this.settle(path, resolve, reject);
      });
    }

    return new Promise<ReadWorkspaceDirectoryResult>((resolve, reject) => {
      this.held.push({ path, resolve, reject });
    });
  }

  /** Completes the oldest held read. */
  releaseNext(): void {
    const entry = this.held.shift();
    if (entry !== undefined) {
      this.settle(entry.path, entry.resolve, entry.reject);
    }
  }

  /** Completes the held read of one specific path. */
  releasePath(path: string): void {
    const index = this.held.findIndex(
      (held) => keyFor(held.path) === keyFor(path),
    );
    if (index === -1) {
      throw new Error(`No held read for ${path}`);
    }
    const [entry] = this.held.splice(index, 1);
    this.settle(entry.path, entry.resolve, entry.reject);
  }

  pendingReadCount(): number {
    return this.held.length;
  }

  /**
   * Resolves one read the way Rust does: equivalent spellings canonicalize to
   * the same directory identity while the requested path stays as asked.
   */
  private settle(
    path: string,
    resolve: (result: ReadWorkspaceDirectoryResult) => void,
    reject: (error: unknown) => void,
  ): void {
    const canonical = this.aliases.get(keyFor(path)) ?? path;
    const failure = this.failures.get(keyFor(canonical));
    if (failure !== undefined) {
      reject(failure);
      return;
    }

    const entries = this.directories.get(keyFor(canonical));
    if (entries === undefined) {
      reject({
        code: "io_directory",
        message: `Cannot read directory ${path}`,
      } satisfies FileCommandError);
      return;
    }

    resolve({
      requestedPath: path,
      canonicalPath: canonical,
      comparisonKey: keyFor(canonical),
      entries,
    });
  }
}

class FakeDialogs implements Pick<
  WorkspaceDialogService,
  "pickWorkspaceFolder" | "showError"
> {
  folder: string | null = null;
  pickCount = 0;
  readonly errors: string[] = [];

  /** When set, the picker stays pending until `resolvePick` is called. */
  holdPicks = false;

  private heldPicks: Array<(path: string | null) => void> = [];

  pickWorkspaceFolder(): Promise<string | null> {
    this.pickCount += 1;

    if (!this.holdPicks) {
      return Promise.resolve(this.folder);
    }

    return new Promise<string | null>((resolve) => {
      this.heldPicks.push(resolve);
    });
  }

  /** Completes the held picker at `index` with the chosen folder. */
  resolvePick(index: number, path: string | null): void {
    const [resolve] = this.heldPicks.splice(index, 1);
    resolve?.(path);
  }

  showError(text: string): Promise<void> {
    this.errors.push(text);
    return Promise.resolve();
  }
}

/**
 * A relation source backed by the same component-aware containment the Rust
 * command implements, so the derivation can be tested without a desktop shell.
 */
class FakeRelationSource implements WorkspaceRelationSource {
  readonly calls: Array<{ rootPath: string; targetPath: string }> = [];

  /** When set, resolving this exact target fails at the IPC boundary. */
  failFor: string | null = null;

  resolveWorkspaceRelation(request: {
    rootPath: string;
    targetPath: string;
  }): Promise<ResolveWorkspaceRelationResult> {
    this.calls.push(request);

    if (this.failFor !== null && this.failFor === request.targetPath) {
      return Promise.reject({
        code: "path_resolution",
        message: `Cannot resolve ${request.targetPath}`,
      } satisfies FileCommandError);
    }

    const root = components(request.rootPath);
    const target = components(request.targetPath);

    if (target.length < root.length) {
      return Promise.resolve({ type: "outside" });
    }
    for (const [index, component] of root.entries()) {
      if (component !== target[index]) {
        return Promise.resolve({ type: "outside" });
      }
    }

    return Promise.resolve({
      type: "inside",
      relativePath: target.slice(root.length).join("\\"),
    });
  }
}

/** Canonical comparison components: case-folded, split on either separator. */
function components(path: string): string[] {
  const trimmed = path.replace(/[\\/]+$/, "");
  const source = trimmed === "" ? path : trimmed;
  return source
    .toLowerCase()
    .split(/[\\/]+/)
    .filter((component) => component !== "");
}

function entry(
  path: string,
  kind: WorkspaceDirectoryEntry["kind"] = "file",
): WorkspaceDirectoryEntry {
  return {
    name: path.replace(/[\\/]+$/, "").split(/[\\/]/).pop() ?? path,
    path,
    kind,
    isSymlink: false,
  };
}

/** The WorkContext that would be active for `rootPath`. */
function context(rootPath: string): WorkContext {
  return {
    id: `workspace-${rootPath}`,
    rootPath,
    canonicalRootPath: rootPath,
    comparisonKey: keyFor(rootPath),
    displayName: displayNameForWorkspaceRoot(rootPath),
  };
}

/**
 * A document's relation to the active Workspace.
 *
 * The application derives this from the document's current path and the active
 * context's root; the helper keeps that call site readable in the tests below.
 */
function documentRelation(
  service: WorkspaceRelationSource,
  active: WorkContext | null,
  documentPath: string | null,
): Promise<WorkspaceRelation> {
  return derivePathRelation(service, active?.rootPath ?? null, documentPath);
}

const WORK_A = "C:\\work\\alpha";
const WORK_B = "C:\\work\\beta";

/**
 * A real `DocumentManager` with the smallest doubles it needs.
 *
 * It exists so the independence claim is tested against the actual document
 * lifecycle rather than against a stub that could not have been mutated anyway.
 */
function createDocumentHarness() {
  let unsavedPromptCount = 0;
  let savePath: string | null = null;

  const editor = {
    extensions: [],
    isReady: () => true,
    attach: () => {},
    detach: () => {},
    getState: () => {
      throw new Error("not used");
    },
    setState: () => {},
    captureViewState: () => ({ scrollTop: 0, scrollLeft: 0 }),
    restoreViewState: () => {},
    focus: () => {},
    undo: () => {},
    redo: () => {},
    setStateUpdateListener: () => {},
  } as unknown as EditorHandle;

  const fileService = {
    readTextFile: (path: string) =>
      Promise.resolve({
        text: `contents of ${path}`,
        format: { ...NEW_DOCUMENT_FORMAT },
      }),
    writeTextFile: () => Promise.resolve(),
    inspectFilePath: (path: string) =>
      Promise.resolve({
        requestedPath: path,
        canonicalPath: path,
        comparisonKey: path.toLowerCase(),
        kind: "file" as const,
        diskRevision: null,
      }),
  } as unknown as FileService;

  const dialogs = {
    pickOpenPath: () => Promise.resolve(null),
    pickSavePath: () => Promise.resolve(savePath),
    showError: () => Promise.resolve(),
    confirmUnsavedChanges: () => {
      unsavedPromptCount += 1;
      return Promise.resolve("cancel" as const);
    },
  } as unknown as FileDialogService;

  const manager = new DocumentManager({ editor, fileService, dialogs });

  return {
    manager,
    /** Two documents, the first one dirty. */
    openTwoDocuments(): string[] {
      const first = manager.createUntitled();
      const second = manager.createUntitled();
      manager.handleEditorStateUpdate(
        first,
        EditorState.create({ doc: "unsaved work" }),
        true,
      );
      return [first, second];
    },
    /** What the next Save As dialog answers with. */
    setSavePath(path: string | null): void {
      savePath = path;
    },
    summary() {
      return {
        ids: manager.listSessions().map((session) => session.id),
        names: manager.listSessions().map((session) => session.displayName),
        dirty: manager.listSessions().map((session) => session.dirty),
        activeDocumentId: manager.getActiveDocumentId(),
        snapshotTabCount: manager.getSnapshot().tabs.length,
      };
    },
    unsavedPromptCount: () => unsavedPromptCount,
  };
}

interface Harness {
  manager: WorkContextManager;
  service: FakeWorkspaceService;
  dialogs: FakeDialogs;
  snapshots: ReturnType<WorkContextManager["getSnapshot"]>[];
}

function createHarness(): Harness {
  const service = new FakeWorkspaceService();
  const dialogs = new FakeDialogs();
  const manager = new WorkContextManager({
    workspaceFileService: service,
    dialogs,
  });

  const snapshots: ReturnType<WorkContextManager["getSnapshot"]>[] = [];
  manager.subscribe((snapshot) => {
    snapshots.push(snapshot);
  });

  return { manager, service, dialogs, snapshots };
}

/* -------------------------------------------------------------------------- */
/* Opening                                                                    */
/* -------------------------------------------------------------------------- */

describe("WorkContextManager open (US1)", () => {
  it("commits the context only after the candidate root was read", async () => {
    const harness = createHarness();
    harness.service.addDirectory(WORK_A, [entry("C:\\work\\alpha\\src", "directory")]);
    harness.service.hold = true;

    const opening = harness.manager.openFolder(WORK_A);
    await Promise.resolve();

    // Nothing is committed while the candidate is still being prepared.
    expect(harness.manager.getContext()).toBeNull();
    expect(harness.snapshots).toHaveLength(0);

    harness.service.releaseNext();
    const result = await opening;

    expect(result.status).toBe("opened");
    const context = harness.manager.getContext();
    expect(context).not.toBeNull();
    expect(context?.rootPath).toBe(WORK_A);
    expect(context?.canonicalRootPath).toBe(WORK_A);
    expect(context?.comparisonKey).toBe(keyFor(WORK_A));
    expect(context?.displayName).toBe("alpha");
    expect(harness.manager.getGeneration()).toBe(1);
    expect(harness.snapshots).toHaveLength(1);
  });

  it("keeps the previous Workspace when a candidate cannot be read", async () => {
    const harness = createHarness();
    harness.service.addDirectory(WORK_A);
    const first = await harness.manager.openFolder(WORK_A);
    expect(first.status).toBe("opened");
    const generationBefore = harness.manager.getGeneration();

    harness.service.failWith(WORK_B, {
      code: "io_directory",
      message: "Access is denied.",
    });

    const second = await harness.manager.openFolder(WORK_B);

    expect(second.status).toBe("failed");
    expect(harness.dialogs.errors).toEqual(["Access is denied."]);
    // The working Workspace is untouched and still usable (FR-006).
    expect(harness.manager.getContext()?.rootPath).toBe(WORK_A);
    expect(harness.manager.getGeneration()).toBe(generationBefore);
  });

  it("treats reopening the same canonical root as a no-op", async () => {
    const harness = createHarness();
    harness.service.addDirectory(WORK_A);
    const first = await harness.manager.openFolder(WORK_A);
    expect(first.status).toBe("opened");
    const contextBefore = harness.manager.getContext();
    const generationBefore = harness.manager.getGeneration();
    const emissionsBefore = harness.snapshots.length;

    const second = await harness.manager.openFolder(WORK_A);

    expect(second.status).toBe("unchanged");
    // No rebuild signal reaches the Explorer for a duplicate request (FR-005).
    expect(harness.manager.getContext()).toBe(contextBefore);
    expect(harness.manager.getGeneration()).toBe(generationBefore);
    expect(harness.snapshots).toHaveLength(emissionsBefore);
  });

  it("recognizes an equivalent spelling as the same Workspace", async () => {
    const harness = createHarness();
    harness.service.addDirectory(WORK_A);
    const first = await harness.manager.openFolder(WORK_A);
    expect(first.status).toBe("opened");

    // A `..` detour resolves to the same canonical directory.
    const equivalent = "C:\\work\\alpha\\..\\alpha";
    harness.service.addAlias(equivalent, WORK_A);
    const contextBefore = harness.manager.getContext();
    const second = await harness.manager.openFolder(equivalent);

    expect(second.status).toBe("unchanged");
    expect(harness.manager.getContext()?.id).toBe(contextBefore?.id);
  });

  it("replaces only the active context when a different root is opened", async () => {
    const harness = createHarness();
    harness.service.addDirectory(WORK_A);
    harness.service.addDirectory(WORK_B);

    const first = await harness.manager.openFolder(WORK_A);
    const second = await harness.manager.openFolder(WORK_B);

    expect(first.status).toBe("opened");
    expect(second.status).toBe("opened");
    if (first.status !== "opened" || second.status !== "opened") {
      throw new Error("Both roots must open.");
    }

    expect(harness.manager.getContext()?.rootPath).toBe(WORK_B);
    expect(second.context.id).not.toBe(first.context.id);
    expect(harness.manager.getGeneration()).toBe(2);
  });

  it("continues from the dialog picker and reports a cancellation", async () => {
    const harness = createHarness();
    harness.service.addDirectory(WORK_A);
    harness.dialogs.folder = WORK_A;

    const opened = await harness.manager.openFromDialog();
    expect(opened.status).toBe("opened");

    // Reopening through the picker is the same no-op rule.
    const again = await harness.manager.openFromDialog();
    expect(again.status).toBe("unchanged");

    harness.dialogs.folder = null;
    const cancelled = await harness.manager.openFromDialog();
    expect(cancelled).toEqual({ status: "cancelled" });
    expect(harness.manager.getContext()?.rootPath).toBe(WORK_A);
  });
});

describe("WorkContextManager last-intent-wins (FR-007, SC-011)", () => {
  it("does not let an older completion replace a newer Workspace", async () => {
    const harness = createHarness();
    harness.service.addDirectory(WORK_A);
    harness.service.addDirectory(WORK_B);
    harness.service.hold = true;

    const first = harness.manager.openFolder(WORK_A);
    const second = harness.manager.openFolder(WORK_B);
    await Promise.resolve();
    expect(harness.service.pendingReadCount()).toBe(2);

    // The newer request completes first and commits.
    harness.service.releasePath(WORK_B);
    const secondResult = await second;
    expect(secondResult.status).toBe("opened");
    expect(harness.manager.getContext()?.rootPath).toBe(WORK_B);

    const generationAfterSecond = harness.manager.getGeneration();

    // The older request now completes and must change nothing.
    harness.service.releasePath(WORK_A);
    const firstResult = await first;

    expect(firstResult.status).toBe("superseded");
    expect(harness.manager.getContext()?.rootPath).toBe(WORK_B);
    expect(harness.manager.getGeneration()).toBe(generationAfterSecond);
  });

  it("ignores an older failure that arrives after a newer success", async () => {
    const harness = createHarness();
    harness.service.addDirectory(WORK_A);
    harness.service.failWith(WORK_B, {
      code: "io_directory",
      message: "Access is denied.",
    });
    harness.service.hold = true;

    const failing = harness.manager.openFolder(WORK_B);
    const succeeding = harness.manager.openFolder(WORK_A);
    await Promise.resolve();

    harness.service.releasePath(WORK_A);
    await succeeding;
    expect(harness.manager.getContext()?.rootPath).toBe(WORK_A);

    harness.service.releasePath(WORK_B);
    const failed = await failing;

    expect(failed.status).toBe("superseded");
    // The stale failure is not reported and does not disturb the Workspace.
    expect(harness.dialogs.errors).toEqual([]);
    expect(harness.manager.getContext()?.rootPath).toBe(WORK_A);
  });

  it("does not reopen a Workspace that was closed while opening", async () => {
    const harness = createHarness();
    harness.service.addDirectory(WORK_A);
    harness.service.hold = true;

    const opening = harness.manager.openFolder(WORK_A);
    await Promise.resolve();

    harness.manager.close();
    harness.service.releaseNext();

    expect((await opening).status).toBe("superseded");
    expect(harness.manager.getContext()).toBeNull();
  });

  it("does not let an earlier dialog result replace a newer Workspace", async () => {
    const harness = createHarness();
    harness.service.addDirectory(WORK_A);
    harness.service.addDirectory(WORK_B);
    harness.dialogs.holdPicks = true;

    // The intent is expressed when each dialog opens, so the token is taken
    // before the native picker is awaited (FR-007).
    const earlier = harness.manager.openFromDialog();
    const newer = harness.manager.openFromDialog();
    await Promise.resolve();

    // The newer dialog resolves first and commits its Workspace.
    harness.dialogs.resolvePick(1, WORK_B);
    expect((await newer).status).toBe("opened");
    expect(harness.manager.getContext()?.rootPath).toBe(WORK_B);
    const generationAfterNewer = harness.manager.getGeneration();

    // The earlier dialog now returns: its candidate must change nothing.
    harness.dialogs.resolvePick(0, WORK_A);
    expect((await earlier).status).toBe("superseded");
    expect(harness.manager.getContext()?.rootPath).toBe(WORK_B);
    expect(harness.manager.getGeneration()).toBe(generationAfterNewer);
  });

  it("still opens normally when only one dialog is open", async () => {
    const harness = createHarness();
    harness.service.addDirectory(WORK_B);
    harness.dialogs.holdPicks = true;

    const opening = harness.manager.openFromDialog();
    await Promise.resolve();
    harness.dialogs.resolvePick(0, WORK_B);

    expect((await opening).status).toBe("opened");
    expect(harness.manager.getContext()?.rootPath).toBe(WORK_B);
  });
});

/* -------------------------------------------------------------------------- */
/* Closing and availability                                                   */
/* -------------------------------------------------------------------------- */

describe("WorkContextManager close (US1)", () => {
  it("closes the Workspace and reports a new generation", async () => {
    const harness = createHarness();
    harness.service.addDirectory(WORK_A);
    await harness.manager.openFolder(WORK_A);
    const generationBefore = harness.manager.getGeneration();

    harness.manager.close();

    expect(harness.manager.getContext()).toBeNull();
    expect(harness.manager.getGeneration()).toBe(generationBefore + 1);
    expect(harness.snapshots[harness.snapshots.length - 1].context).toBeNull();
  });

  it("is a no-op when no Workspace is open", () => {
    const harness = createHarness();
    const generationBefore = harness.manager.getGeneration();

    harness.manager.close();

    expect(harness.manager.getGeneration()).toBe(generationBefore);
    expect(harness.snapshots).toHaveLength(0);
  });
});

describe("WorkContextManager root availability (FR-088)", () => {
  it("keeps the Workspace active when its root becomes unavailable", async () => {
    const harness = createHarness();
    harness.service.addDirectory(WORK_A);
    await harness.manager.openFolder(WORK_A);
    const context = harness.manager.getContext();
    const generationBefore = harness.manager.getGeneration();
    const emissionsBefore = harness.snapshots.length;

    // The Explorer reports the failed root read; the context survives it.
    harness.manager.setRootUnavailable(true);

    expect(harness.manager.getContext()).toBe(context);
    expect(harness.manager.getGeneration()).toBe(generationBefore);
    expect(harness.manager.isRootUnavailable()).toBe(true);
    expect(harness.snapshots).toHaveLength(emissionsBefore + 1);
  });

  it("clears the unavailable state when the root reads successfully again", async () => {
    const harness = createHarness();
    harness.service.addDirectory(WORK_A);
    await harness.manager.openFolder(WORK_A);

    harness.manager.setRootUnavailable(true);
    expect(harness.manager.isRootUnavailable()).toBe(true);

    // Refresh retries the read, and the Explorer clears the flag on success.
    harness.manager.setRootUnavailable(false);

    expect(harness.manager.isRootUnavailable()).toBe(false);
    expect(harness.manager.getContext()?.rootPath).toBe(WORK_A);
  });

  it("clears the unavailable state when the same root is reopened", async () => {
    const harness = createHarness();
    harness.service.addDirectory(WORK_A);
    await harness.manager.openFolder(WORK_A);
    harness.manager.setRootUnavailable(true);

    const reopened = await harness.manager.openFolder(WORK_A);

    expect(reopened.status).toBe("unchanged");
    expect(harness.manager.isRootUnavailable()).toBe(false);
  });

  it("ignores availability changes without an active Workspace", () => {
    const harness = createHarness();

    harness.manager.setRootUnavailable(true);

    expect(harness.manager.isRootUnavailable()).toBe(false);
    expect(harness.snapshots).toHaveLength(0);
  });
});

/* -------------------------------------------------------------------------- */
/* Workspace / document independence (FR-003, FR-008, FR-010)                  */
/* -------------------------------------------------------------------------- */

describe("Workspace lifecycle and open documents (T090)", () => {
  it("opens, replaces and closes a Workspace without touching any document", async () => {
    const documentHarness = createDocumentHarness();
    const documentIds = documentHarness.openTwoDocuments();

    const harness = createHarness();
    harness.service.addDirectory(WORK_A);
    harness.service.addDirectory(WORK_B);

    const before = documentHarness.summary();
    expect(before.ids).toEqual(documentIds);
    expect(before.dirty).toEqual([true, false]);

    await harness.manager.openFolder(WORK_A);
    expect(documentHarness.summary()).toEqual(before);

    // Replacing the Workspace discards no document and prompts for nothing.
    await harness.manager.openFolder(WORK_B);
    expect(documentHarness.summary()).toEqual(before);

    harness.manager.close();
    expect(documentHarness.summary()).toEqual(before);

    // A document outside the Workspace is still an ordinary document (FR-010).
    expect(harness.manager.getContext()).toBeNull();
    expect(documentHarness.unsavedPromptCount()).toBe(0);
  });
});

/* -------------------------------------------------------------------------- */
/* Path-relation helpers (FR-041..FR-043)                                     */
/* -------------------------------------------------------------------------- */

describe("Workspace path-relation helpers", () => {
  it("derives a display name from a root path", () => {
    expect(displayNameForWorkspaceRoot("C:\\work\\alpha")).toBe("alpha");
    expect(displayNameForWorkspaceRoot("C:\\work\\alpha\\")).toBe("alpha");
    expect(displayNameForWorkspaceRoot("/home/dev/project")).toBe("project");
  });

  it("decides containment component by component", () => {
    const root = keyFor("C:\\work\\project");
    const inside = keyFor("C:\\work\\project\\src\\a.ts");
    const sibling = keyFor("C:\\work\\project-old\\a.ts");
    const elsewhere = keyFor("D:\\other\\a.ts");

    expect(isWithinDirectory(root, inside)).toBe(true);
    expect(isWithinDirectory(root, root)).toBe(true);
    // A shared name prefix is not containment.
    expect(isWithinDirectory(root, sibling)).toBe(false);
    expect(isWithinDirectory(root, elsewhere)).toBe(false);
  });

  it("reports the relative suffix of a contained path", () => {
    const root = keyFor("C:\\work\\project");

    expect(
      relativeWithinDirectory(root, keyFor("C:\\work\\project\\src\\a.ts")),
    ).toBe("src\\a.ts");
    expect(relativeWithinDirectory(root, root)).toBe("");
    expect(
      relativeWithinDirectory(root, keyFor("C:\\work\\project-old\\a.ts")),
    ).toBeNull();
  });

  it("splits canonical keys into components", () => {
    expect(pathComponents(keyFor("C:\\work\\project\\"))).toEqual([
      "c:",
      "work",
      "project",
    ]);
    expect(pathComponents(keyFor("C:\\work\\project\\src\\a.ts"))).toEqual([
      "c:",
      "work",
      "project",
      "src",
      "a.ts",
    ]);
  });

  it("joins a suffix with the separator style of the base", () => {
    expect(joinPath("C:\\work\\project", "src\\a.ts")).toBe(
      "C:\\work\\project\\src\\a.ts",
    );
    expect(joinPath("/home/dev", "a.ts")).toBe("/home/dev/a.ts");
    expect(joinPath("C:\\work", "")).toBe("C:\\work");
  });

  it("maps the Rust relation result onto the model type", () => {
    expect(
      toWorkspaceRelation({ type: "inside", relativePath: "src\\a.ts" }),
    ).toEqual({ type: "inside", relativePath: "src\\a.ts" });
    expect(toWorkspaceRelation({ type: "outside" })).toEqual({
      type: "outside",
    });
  });
});

/* -------------------------------------------------------------------------- */
/* Runtime relation derivation (FR-041, FR-042)                                */
/* -------------------------------------------------------------------------- */

describe("Workspace relation derivation (T100)", () => {
  it("returns unbound for a document with no disk path and never calls the IPC", async () => {
    const relation = new FakeRelationSource();

    await expect(
      documentRelation(relation, context(WORK_A), null),
    ).resolves.toEqual({ type: "unbound" });
    expect(relation.calls).toEqual([]);
  });

  it("returns outside without a Workspace and never calls the IPC", async () => {
    const relation = new FakeRelationSource();

    await expect(
      documentRelation(relation, null, `${WORK_A}\\a.ts`),
    ).resolves.toEqual({ type: "outside" });
    expect(relation.calls).toEqual([]);
  });

  it("maps an inside answer with its Workspace-relative path", async () => {
    const relation = new FakeRelationSource();

    await expect(
      documentRelation(relation, context(WORK_A), `${WORK_A}\\src\\a.ts`),
    ).resolves.toEqual({ type: "inside", relativePath: "src\\a.ts" });
    expect(relation.calls).toEqual([
      { rootPath: WORK_A, targetPath: `${WORK_A}\\src\\a.ts` },
    ]);
  });

  it("maps an outside answer for a sibling root and for a disjoint root", async () => {
    const relation = new FakeRelationSource();

    await expect(
      documentRelation(
        relation,
        context(WORK_A),
        "C:\\work\\alpha-old\\a.ts",
      ),
    ).resolves.toEqual({ type: "outside" });
    await expect(
      documentRelation(relation, context(WORK_A), "D:\\elsewhere\\a.ts"),
    ).resolves.toEqual({ type: "outside" });
  });

  it("propagates a resolution failure instead of answering outside", async () => {
    const relation = new FakeRelationSource();
    relation.failFor = `${WORK_A}\\a.ts`;

    // Containment callers act on this answer (Delete must not lose the
    // unsaved-work warning), so an unanswerable question must be surfaced.
    await expect(
      documentRelation(relation, context(WORK_A), `${WORK_A}\\a.ts`),
    ).rejects.toEqual({
      code: "path_resolution",
      message: `Cannot resolve ${WORK_A}\\a.ts`,
    });
    await expect(
      isInsideRoot(relation, WORK_A, `${WORK_A}\\a.ts`),
    ).rejects.toEqual({
      code: "path_resolution",
      message: `Cannot resolve ${WORK_A}\\a.ts`,
    });
  });

  it("answers directory containment with canonical components", async () => {
    const relation = new FakeRelationSource();

    await expect(
      isInsideRoot(relation, `${WORK_A}\\src`, `${WORK_A}\\src\\a.ts`),
    ).resolves.toBe(true);
    await expect(
      isInsideRoot(relation, `${WORK_A}\\src`, `${WORK_A}\\src2\\a.ts`),
    ).resolves.toBe(false);
    await expect(
      isInsideRoot(relation, `${WORK_A}\\src`, `${WORK_A}\\src`),
    ).resolves.toBe(true);
  });

  it("changes with Save As without reopening the document", async () => {
    const documents = createDocumentHarness();
    const relation = new FakeRelationSource();
    const workspace = context(WORK_A);
    const inside = `${WORK_A}\\notes.txt`;
    const outside = "D:\\elsewhere\\notes.txt";

    const opened = await documents.manager.openPath(inside);
    if (opened.status !== "opened") {
      throw new Error("The fixture must open.");
    }
    const id = opened.documentId;
    const stateBefore = documents.manager.getSession(id)!.editorState;

    await expect(
      documentRelation(
        relation,
        workspace,
        documents.manager.getSession(id)!.path,
      ),
    ).resolves.toEqual({ type: "inside", relativePath: "notes.txt" });

    // Save As moves the document outside the Workspace.
    documents.setSavePath(outside);
    await documents.manager.saveDocumentAs(id);

    await expect(
      documentRelation(
        relation,
        workspace,
        documents.manager.getSession(id)!.path,
      ),
    ).resolves.toEqual({ type: "outside" });

    // Saving back inside flips it again, and the document was never reopened.
    documents.setSavePath(inside);
    await documents.manager.saveDocumentAs(id);

    await expect(
      documentRelation(
        relation,
        workspace,
        documents.manager.getSession(id)!.path,
      ),
    ).resolves.toEqual({ type: "inside", relativePath: "notes.txt" });

    const session = documents.manager.getSession(id)!;
    expect(session.id).toBe(id);
    expect(session.editorState).toBe(stateBefore);
    expect(documents.manager.listSessions()).toHaveLength(1);
  });

  it("keeps a renamed document inside with an updated relative path", async () => {
    const documents = createDocumentHarness();
    const relation = new FakeRelationSource();
    const workspace = context(WORK_A);
    const sourceDirectory = `${WORK_A}\\src`;
    const file = `${sourceDirectory}\\a.ts`;

    const opened = await documents.manager.openPath(file);
    if (opened.status !== "opened") {
      throw new Error("The fixture must open.");
    }
    const id = opened.documentId;

    documents.manager.handleEditorStateUpdate(
      id,
      EditorState.create({ doc: "unsaved" }),
      true,
    );
    const stateBefore = documents.manager.getSession(id)!.editorState;

    const affected = documents.manager.commitRenamedPath({
      sourceIdentity: {
        canonicalPath: sourceDirectory,
        comparisonKey: sourceDirectory.toLowerCase(),
      },
      newPath: `${WORK_A}\\lib`,
      newIdentity: {
        requestedPath: `${WORK_A}\\lib`,
        canonicalPath: `${WORK_A}\\lib`,
        comparisonKey: `${WORK_A}\\lib`.toLowerCase(),
        kind: "directory",
        diskRevision: null,
      },
    });

    expect(affected).toEqual([id]);
    const session = documents.manager.getSession(id)!;
    expect(session.path).toBe(`${WORK_A}\\lib\\a.ts`);
    // The document's identity, editor state and dirty flag are preserved.
    expect(session.editorState).toBe(stateBefore);
    expect(session.dirty).toBe(true);

    await expect(
      documentRelation(relation, workspace, session.path),
    ).resolves.toEqual({ type: "inside", relativePath: "lib\\a.ts" });
  });
});

/* -------------------------------------------------------------------------- */
/* Untouched dialog surface                                                   */
/* -------------------------------------------------------------------------- */

describe("WorkContextManager dependencies", () => {
  it("reports every candidate failure through the error dialog", async () => {
    const harness = createHarness();
    harness.service.failWith(WORK_A, {
      code: "io_directory",
      message: "The folder is not available.",
    });

    await harness.manager.openFolder(WORK_A);

    expect(harness.dialogs.errors).toEqual(["The folder is not available."]);
  });
});
