/**
 * The single disposable large-Tree fixture (007 T008).
 *
 * SC-001 asks for 10,000 *materialized* visible Explorer rows without touching
 * the real filesystem, and both the performance acceptance run and the
 * development-only debug harness must build that state the same way. This module
 * is therefore the one owner of the fixture: it constructs an in-memory
 * `ExplorerState` whose directories are already loaded and expanded, so the
 * visible projection contains the requested number of rows while no directory
 * read, watcher subscription or disk access is involved.
 *
 * The fixture is deliberately pure and deterministic: the same options always
 * produce the same paths, names and row count, which is what makes a rendered-row
 * assertion meaningful.
 */

import {
  createDirectoryNode,
  sortExplorerEntries,
  type ExplorerDirectoryNode,
  type ExplorerNode,
  type ExplorerState,
} from "../explorer/explorerModel";

/** SC-001's acceptance scale: at least this many visible rows. */
export const LARGE_TREE_TARGET_ROWS = 10_000;

/**
 * The context id only the disposable fixture uses (T229).
 *
 * A real Workspace's state carries `workspace-<something>`; this marker is what lets
 * UI code decide "the fixture is on screen" from the state itself, instead of from a
 * flag that could disagree with what is rendered.
 */
export const FIXTURE_WORKSPACE_CONTEXT_ID = "fixture-workspace";

/** The root entry name the fixture presents, so the Header never claims a real folder. */
export const FIXTURE_WORKSPACE_NAME = "fixture";

/** The row height the 1200x780 acceptance window is evaluated with. */
export const LARGE_TREE_ACCEPTANCE_VIEWPORT_PX = 780;

export interface LargeTreeFixtureOptions {
  /**
   * Raise the shape until at least this many rows are materialized.
   *
   * Omitted, the explicit `directoryCount`/`filesPerDirectory`/`depth` shape is
   * used exactly as given; the defaults already exceed
   * {@link LARGE_TREE_TARGET_ROWS}.
   */
  targetRows?: number;
  /** Materialized top-level directories directly under the root. */
  directoryCount?: number;
  /** Materialized files inside each top-level directory. */
  filesPerDirectory?: number;
  /**
   * Extra directory levels nested under each top-level directory. Files are
   * materialized at the deepest level, so the fixture can prove that deep rows
   * receive correct depth/ancestor metadata.
   */
  depth?: number;
  /**
   * Extra characters appended to every file name, so the fixture can produce a
   * row that is wider than the Sidebar (T200) without mounting it.
   */
  namePadding?: number;
  /** Root path spelling used for every generated node. */
  rootPath?: string;
}

interface ResolvedFixtureOptions {
  directoryCount: number;
  filesPerDirectory: number;
  depth: number;
  namePadding: number;
  rootPath: string;
}

const DEFAULT_OPTIONS: ResolvedFixtureOptions = {
  directoryCount: 100,
  filesPerDirectory: 99,
  depth: 1,
  namePadding: 0,
  rootPath: "C:\\fixture",
};

function resolveOptions(
  options: LargeTreeFixtureOptions,
): ResolvedFixtureOptions {
  return {
    directoryCount: options.directoryCount ?? DEFAULT_OPTIONS.directoryCount,
    filesPerDirectory:
      options.filesPerDirectory ?? DEFAULT_OPTIONS.filesPerDirectory,
    depth: options.depth ?? DEFAULT_OPTIONS.depth,
    namePadding: options.namePadding ?? DEFAULT_OPTIONS.namePadding,
    rootPath: options.rootPath ?? DEFAULT_OPTIONS.rootPath,
  };
}

/** Builds one loaded, expanded directory node around the given children. */
function loadedDirectory(
  name: string,
  path: string,
  children: readonly ExplorerNode[],
): ExplorerDirectoryNode {
  const node = createDirectoryNode(
    { name, path },
    { expanded: true, resolvedCanonicalPath: path },
  );
  node.loadState = "loaded";
  node.children = sortExplorerEntries([...children]);
  return node;
}

/**
 * Creates a materialized Explorer tree with at least `targetRows` visible rows.
 *
 * Each top-level directory contributes a chain of `depth` directory rows plus
 * `filesPerDirectory` file rows, so the visible row count is
 * `1 + directoryCount * (depth + filesPerDirectory)`. With `targetRows` the
 * directory count is raised until that total reaches the target; without it the
 * caller's explicit shape is used unchanged.
 */
export function createLargeExplorerTree(
  options: LargeTreeFixtureOptions = {},
): ExplorerState {
  const base = resolveOptions(options);

  // One row per directory in the chain plus one row per file.
  const rowsPerDirectory = base.depth + base.filesPerDirectory;
  const directoryCount =
    options.targetRows === undefined
      ? Math.max(1, base.directoryCount)
      : Math.max(
          1,
          Math.ceil((options.targetRows - 1) / Math.max(1, rowsPerDirectory)),
        );

  const padding =
    base.namePadding === 0 ? "" : "x".repeat(base.namePadding);

  const topLevel: ExplorerDirectoryNode[] = [];
  for (let directory = 0; directory < directoryCount; directory += 1) {
    const segments = [
      `dir-${String(directory).padStart(5, "0")}`,
      ...Array.from({ length: Math.max(0, base.depth - 1) }, (_, index) =>
        `nested-${index + 1}`,
      ),
    ];
    const pathFor = (segmentIndex: number): string =>
      `${base.rootPath}\\${segments.slice(0, segmentIndex + 1).join("\\")}`;

    const files: ExplorerNode[] = [];
    for (let file = 0; file < base.filesPerDirectory; file += 1) {
      const name = `file-${String(file).padStart(4, "0")}${padding}.ts`;
      files.push({
        name,
        path: `${pathFor(segments.length - 1)}\\${name}`,
        kind: "file",
        isSymlink: false,
        objectIdentity: null,
      });
    }

    // Built deepest first, so the top-level row is the first chain segment and
    // every parent is the directory that actually contains the next one.
    let current = loadedDirectory(
      segments[segments.length - 1],
      pathFor(segments.length - 1),
      files,
    );
    for (let level = segments.length - 2; level >= 0; level -= 1) {
      current = loadedDirectory(segments[level], pathFor(level), [current]);
    }

    topLevel.push(current);
  }

  const root = loadedDirectory(
    FIXTURE_WORKSPACE_NAME,
    base.rootPath,
    topLevel,
  );

  return {
    contextId: FIXTURE_WORKSPACE_CONTEXT_ID,
    generation: 1,
    root,
    selectedPath: null,
    inlineEdit: null,
    rootUnavailable: false,
  };
}

/**
 * Whether a Tree state is the disposable fixture rather than a real Workspace
 * projection (T229).
 *
 * The fixture names no filesystem entry and its rows do not exist in
 * `ExplorerController`, so everything that would otherwise reach the controller or
 * an Explorer action is decided by this one predicate.
 */
export function isFixtureExplorerState(
  state: ExplorerState | null | undefined,
): state is ExplorerState {
  return (
    state !== null &&
    state !== undefined &&
    state.contextId === FIXTURE_WORKSPACE_CONTEXT_ID
  );
}

/**
 * The fixture projection the Tree renders while the harness is enabled (T229).
 *
 * The fixture's own selection is UI state passed in, never written into the fixture:
 * the returned projection differs from the fixture in at most `selectedPath`, so the
 * harness cannot accumulate state that a later real render would inherit, and the
 * fixture object itself stays exactly as the scale fixture built it.
 */
export function fixtureExplorerProjection(
  fixture: ExplorerState,
  selection: string | null,
): ExplorerState {
  return { ...fixture, selectedPath: selection };
}

/** The owner a Tree selection gesture belongs to (T229). */
export type ExplorerSelectionRoute =
  | { owner: "fixture"; selection: string | null }
  | { owner: "controller"; path: string };

/**
 * Routes a selection gesture to the owner that can act on it (T229).
 *
 * While the fixture is rendered its rows are not in `ExplorerController`, so the
 * gesture becomes fixture-local UI state — a click, a right-click target and a
 * quick-search match all take this path, and the controller is never handed a fixture
 * path. `null` means there is nothing to select: no fixture is rendered and no path
 * was targeted.
 */
export function routeExplorerSelection(input: {
  fixture: ExplorerState | null | undefined;
  path: string | null;
}): ExplorerSelectionRoute | null {
  if (isFixtureExplorerState(input.fixture)) {
    return { owner: "fixture", selection: input.path };
  }
  return input.path === null ? null : { owner: "controller", path: input.path };
}

/**
 * Counts the rows the projection would materialize for `state`.
 *
 * It walks the loaded/expanded model exactly as the visible-row projection does,
 * so the fixture can prove its own scale without importing the projection (which
 * would make the fixture depend on the code it is meant to exercise).
 */
export function countMaterializedRows(state: ExplorerState): number {
  const root = state.root;
  if (root === null) {
    return 0;
  }

  let count = 0;
  const walk = (node: ExplorerNode): void => {
    count += 1;
    if (node.kind !== "directory" || !node.expanded) {
      return;
    }
    for (const child of node.children ?? []) {
      walk(child);
    }
  };

  walk(root);
  return count;
}

/** The fixture the SC-001 acceptance run and the debug harness both use. */
export function createTenThousandRowExplorerTree(): ExplorerState {
  return createLargeExplorerTree({ targetRows: LARGE_TREE_TARGET_ROWS });
}
