/**
 * The disposable many-Tab fixture (007 T009).
 *
 * SC-004 and the many-Tab acceptance run need 100 `TabSnapshot` items without
 * creating 100 real files. Tab presentation must be provable from metadata alone
 * — that is the whole point of `TabSnapshot` being a lightweight projection — so
 * this fixture produces exactly that projection and nothing else.
 */

import type { DocumentId, ExternalState, TabSnapshot } from "../document/documentSession";

/** SC-004's acceptance scale. */
export const MANY_TAB_FIXTURE_COUNT = 100;

export interface ManyTabFixtureOptions {
  count?: number;
  /** Index of the active Tab; defaults to the first. */
  activeIndex?: number;
  /** Marks every `dirtyEvery`-th Tab dirty; `0` disables dirty markers. */
  dirtyEvery?: number;
  /** Marks every `externalEvery`-th Tab as changed on disk. */
  externalEvery?: number;
  /** Sets the external state of the `missingIndex`-th Tab to `missing`. */
  missingIndex?: number;
  /** Directory spelling the generated paths use. */
  directory?: string;
  /** Characters appended to every display name, for wide-label cases. */
  namePadding?: number;
}

/** The id prefix only the disposable fixture produces (T227). */
export const FIXTURE_DOCUMENT_ID_PREFIX = "fixture-doc-";

/** Deterministic document id for the `index`-th fixture Tab. */
export function fixtureDocumentId(index: number): DocumentId {
  return `${FIXTURE_DOCUMENT_ID_PREFIX}${index}`;
}

/**
 * Whether a Tab id names a disposable fixture Tab rather than a document session.
 *
 * Real sessions are allocated as `doc-<n>` by `documentSession.createDocumentId`,
 * so the two families can never collide and UI code can route a Tab gesture by
 * identity alone. That is what keeps a fixture id from ever reaching
 * `DocumentManager`, which has no session for it (T227).
 */
export function isFixtureDocumentId(id: DocumentId): boolean {
  return id.startsWith(FIXTURE_DOCUMENT_ID_PREFIX);
}

/** The fixture Tab that is currently active, or `null`. */
export function activeFixtureTab(
  tabs: readonly TabSnapshot[],
): TabSnapshot | null {
  return tabs.find((tab) => tab.active) ?? null;
}

/**
 * Makes one fixture Tab the active one, in place of the previous active Tab.
 *
 * The fixture owns activation for its own Tabs while it is enabled, so a direct Tab
 * click and a Tab Overview selection both move exactly one fixture Tab — and,
 * because the active marker is the projection's, the strip's own reveal rule runs
 * against it (SC-004, T227).
 *
 * An id the fixture does not contain leaves the list untouched (the same array), so
 * a real document id can never be interpreted as a fixture Tab.
 */
export function activateFixtureTab(
  tabs: readonly TabSnapshot[],
  id: DocumentId,
): readonly TabSnapshot[] {
  if (!tabs.some((tab) => tab.id === id)) {
    return tabs;
  }
  return tabs.map((tab) =>
    tab.active === (tab.id === id) ? tab : { ...tab, active: tab.id === id },
  );
}

/**
 * Closes one fixture Tab, harmlessly (T227).
 *
 * The fixture is disposable and names no filesystem entry, so closing only removes
 * the Tab from the fixture list: nothing is asked of `DocumentManager`, no file is
 * touched, and there is no unsaved-changes guard to run. The neighbour that slides
 * into the closed Tab's place takes the active marker when the closed Tab was the
 * active one.
 */
export function closeFixtureTab(
  tabs: readonly TabSnapshot[],
  id: DocumentId,
): readonly TabSnapshot[] {
  const index = tabs.findIndex((tab) => tab.id === id);
  if (index < 0) {
    return tabs;
  }

  const remaining = tabs.filter((_, position) => position !== index);
  if (remaining.length === 0) {
    return remaining;
  }

  const activePosition = remaining.findIndex((tab) => tab.active);
  const nextActive = tabs[index].active
    ? Math.min(index, remaining.length - 1)
    : activePosition >= 0
      ? activePosition
      : 0;

  return remaining.map((tab, position) =>
    tab.active === (position === nextActive)
      ? tab
      : { ...tab, active: position === nextActive },
  );
}

function externalStateFor(
  index: number,
  options: Required<Pick<ManyTabFixtureOptions, "externalEvery" | "missingIndex">>,
): ExternalState {
  if (options.missingIndex === index) {
    return "missing";
  }
  if (options.externalEvery > 0 && index % options.externalEvery === 0) {
    return "modified";
  }
  return "normal";
}

/**
 * Creates `count` Tab snapshots in Tab order.
 *
 * The returned array is a plain projection: no document session, no editor state
 * and no filesystem entry is created, so a UI test can exercise zero, few, 20 and
 * 100 Tabs without the document manager.
 */
export function createManyTabSnapshots(
  options: ManyTabFixtureOptions = {},
): TabSnapshot[] {
  const count = options.count ?? MANY_TAB_FIXTURE_COUNT;
  const activeIndex = options.activeIndex ?? 0;
  const dirtyEvery = options.dirtyEvery ?? 3;
  const externalEvery = options.externalEvery ?? 0;
  const missingIndex = options.missingIndex ?? -1;
  const directory = options.directory ?? "C:\\fixture";
  const padding = (options.namePadding ?? 0) > 0
    ? "y".repeat(options.namePadding ?? 0)
    : "";

  const tabs: TabSnapshot[] = [];
  for (let index = 0; index < count; index += 1) {
    const displayName = `document-${String(index).padStart(3, "0")}${padding}.ts`;
    tabs.push({
      id: fixtureDocumentId(index),
      displayName,
      path: `${directory}\\${displayName}`,
      dirty: dirtyEvery > 0 && index % dirtyEvery === 0,
      active: index === activeIndex,
      externalState: externalStateFor(index, { externalEvery, missingIndex }),
    });
  }

  return tabs;
}

/** A fixture with the acceptance count, one active Tab and mixed markers. */
export function createHundredTabSnapshots(): TabSnapshot[] {
  return createManyTabSnapshots({
    count: MANY_TAB_FIXTURE_COUNT,
    activeIndex: 0,
    dirtyEvery: 3,
    externalEvery: 7,
  });
}
