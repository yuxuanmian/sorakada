/**
 * The Explorer container.
 *
 * It owns no filesystem or document state: it renders the controller's state,
 * resolves every action through the shared command registry, and scopes the
 * plain `F2`/`Delete` keys and the direct type-to-search trigger to itself.
 *
 * 007 adds three things on top of 004's Tree interactions:
 *
 * - a Header whose right-hand actions never move, with `Locate`/`Collapse`/`More`
 *   replacing the old primary New File/New Folder/Refresh buttons (FR-027..FR-030,
 *   SR-002);
 * - a transient type-to-search over the visible projection only, whose results are
 *   addressed by logical row key (FR-046..FR-049);
 * - one controlled operation target for the whole Tree, so no recyclable row owns
 *   menu state (T069, T102).
 */

import { useCallback, useEffect, useMemo, useState, type KeyboardEvent } from "react";

import type { CommandId } from "../commands/commandIds";
import { AppIcon, IconGlyph } from "../shell/AppIcon";
import type { DensityMetrics } from "../shell/density";
import type { UiDebugOptions } from "../shell/uiDebugState";
import { uiIcon } from "../icons/uiIconProvider";
import { SoraMenu } from "../../ui/menu/SoraMenu";
import type { SoraContextTarget } from "../../ui/context-menu/SoraContextMenu";
import { activateMenuItem } from "../menu/menuActivation";
import type { ExplorerActions } from "./explorerActions";
import type { ExplorerController } from "./explorerController";
import { ExplorerContextMenu, type ExplorerMenuAction } from "./ExplorerContextMenu";
import { rowPathFromTarget } from "./explorerContextTarget";
import { ExplorerHeader } from "./ExplorerHeader";
import {
  buildExplorerMoreMenuModel,
  explorerHeaderActions,
  isMoreAvailable,
  type ExplorerHeaderState,
} from "./explorerHeaderActions";
import type { ExplorerNode, ExplorerState } from "./explorerModel";
import { flattenVisibleExplorerRows } from "./explorerProjection";
import { typeToSearchSeed, selectableMatchPath } from "./explorerQuickSearch";
import { ExplorerVirtualTree, type ExplorerVirtualRange } from "./ExplorerVirtualTree";
import { useExplorerQuickSearch } from "./useExplorerQuickSearch";
import {
  fixtureExplorerProjection,
  isFixtureExplorerState,
  routeExplorerSelection,
} from "../performance/treeFixtures";

import "../../styles/explorer.css";

export interface ExplorerProps {
  /** The controller's current projection. */
  state: ExplorerState;
  /** The controller that owns selection, expansion and the inline editor. */
  controller: ExplorerController;
  /** Display name of the active Workspace, or `null` when none is open. */
  workspaceName: string | null;
  /** Operation targeting and filesystem orchestration. */
  actions: ExplorerActions;
  /** The active density metrics the Tree lays out with (FR-080, T089). */
  metrics: DensityMetrics;
  /** The Workspace/document facts the Header actions depend on (T114, T124). */
  headerState: ExplorerHeaderState;
  /**
   * Development diagnostics; never affects production behaviour (T181).
   */
  debugOptions?: UiDebugOptions;
  /**
   * A development-only Tree fixture to inspect instead of the real state.
   *
   * It is an *isolated harness*, not a second Tree owner (T182, T229). The fixture's
   * nodes do not exist in the controller, so while it is rendered the Explorer reads
   * it, keeps selection and the operation target in its own UI state, and offers no
   * filesystem operation — no fixture path can be written into the controller or
   * reach an Explorer action.
   *
   * The value must be a state carrying the fixture's own context marker
   * (`isFixtureExplorerState`); anything else is ignored and the real Tree renders.
   */
  debugState?: ExplorerState | null;
  /**
   * A pending request to reveal one logical row, produced by Locate Current File.
   *
   * It is expressed as a logical key, not an index (FR-048).
   */
  revealRequest?: { key: string } | null;
  /** Reports that the pending reveal was serviced. */
  onRevealHandled?(): void;
  /** Opens a folder as the Workspace (the no-Workspace entry point). */
  onOpenFolder(): void;
  /** Dispatches a command through the shared registry. */
  onCommand(id: CommandId): void;
  /**
   * The shared registry's availability decision.
   *
   * The Explorer asks the same authority every other surface asks, so a menu item
   * can never be enabled for a command the registry would refuse (FR-022, FR-030).
   */
  isCommandEnabled(id: CommandId): boolean;
}

/** Whether a keyboard event's target is a control that owns text input. */
function isTextControlTarget(target: unknown): boolean {
  if (target === null || typeof target !== "object") {
    return false;
  }
  const candidate = target as { closest?: unknown };
  if (typeof candidate.closest !== "function") {
    return false;
  }
  return (
    (candidate as { closest(selector: string): unknown }).closest(
      "input, textarea, [contenteditable='true']",
    ) !== null
  );
}

/** Renders the Explorer for the active Workspace, or the no-Workspace state. */
export function Explorer({
  state,
  controller,
  workspaceName,
  actions,
  metrics,
  headerState,
  debugOptions,
  debugState,
  revealRequest,
  onRevealHandled,
  onOpenFolder,
  onCommand,
  isCommandEnabled,
}: ExplorerProps) {
  /**
   * The path the menu currently targets.
   *
   * `undefined` means "no gesture has targeted anything", which is how a closed
   * menu forgets its target; `null` means the gesture landed on blank space and
   * the target is the Workspace root.
   */
  const [menuTargetPath, setMenuTargetPath] = useState<
    string | null | undefined
  >(undefined);

  /**
   * A token that asks the Tree viewport to take keyboard focus.
   *
   * The viewport — not a row — is the stable focus owner, so closing the
   * transient search or revealing a located file has to *ask* for focus rather
   * than set it on an element that may be recycled (T096, T109).
   */
  const [focusToken, setFocusToken] = useState(0);

  /**
   * The development-only fixture, or `null` when the real Tree is rendered.
   *
   * While it is present the Explorer is a *fixture of itself* (T182, T229): it
   * renders the fixture projection, keeps the operation target and the selection in
   * fixture-local UI state, offers no filesystem operation, and never hands a
   * fixture path to the controller or to an Explorer action. The fixture's own
   * context marker decides this, so the harness cannot disagree with what renders.
   */
  const fixture = isFixtureExplorerState(debugState) ? debugState : null;
  const readOnly = fixture !== null;

  /**
   * The fixture's own selection.
   *
   * The fixture's nodes do not exist in `ExplorerController`, so the selection that
   * belongs to them is UI state owned here: a click, a right-click target and a
   * quick-search match all move *this* marker, and the controller's real selection is
   * left exactly as it was (T229, Constitution II).
   */
  const [fixtureSelection, setFixtureSelection] = useState<string | null>(null);

  /**
   * The flattening is derived from the controller state and nothing else, so it
   * can never become a second Tree model (FR-031, FR-033).
   *
   * In the development harness the fixture state replaces it, but only for
   * rendering: the controller is never asked to adopt it.
   */
  const renderedState = useMemo(
    () =>
      fixture === null
        ? state
        : fixtureExplorerProjection(fixture, fixtureSelection),
    [fixture, fixtureSelection, state],
  );
  const rows = useMemo(
    () => flattenVisibleExplorerRows(renderedState),
    [renderedState],
  );

  /**
   * Applies one selection gesture to whichever owner can act on it (T229).
   *
   * Every selection path in this component goes through here — a row click, a
   * right-click target and the current quick-search match — so "a fixture path never
   * reaches the controller" is one decision rather than three guards.
   */
  const applySelection = useCallback(
    (path: string | null): void => {
      const route = routeExplorerSelection({ fixture, path });
      if (route === null) {
        return;
      }
      if (route.owner === "fixture") {
        setFixtureSelection(route.selection);
        return;
      }
      controller.selectPath(route.path);
    },
    [controller, fixture],
  );

  const search = useExplorerQuickSearch(rows);

  /**
   * The logical selection a search match carries (US3/AC3, T226).
   *
   * Revealing a match scrolls to it; selecting it is what gives arrow-key result
   * navigation a real anchor, so the current match is identifiable rather than
   * being only a scroll offset. Sentinels and the inline-create row have no
   * selectable path, so they are revealed without changing the selection.
   */
  const matchPath = selectableMatchPath(rows, search.currentKey);

  useEffect(() => {
    if (matchPath !== null) {
      // The current match is selected through the same route a click takes, so the
      // fixture keeps it in fixture-local state (T226, T229).
      applySelection(matchPath);
    }
  }, [applySelection, matchPath]);

  // A WorkContext replacement invalidates any open menu and its captured target,
  // and closes a transient search that described the previous Workspace.
  useEffect(() => {
    setMenuTargetPath(undefined);
    search.close();
    // `search.close` is stable; `state.contextId` is the actual trigger.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.contextId]);

  // Enabling or disabling the disposable fixture replaces the whole rendered Tree,
  // so a target or a selection that described the previous one is dropped.
  useEffect(() => {
    setFixtureSelection(null);
    setMenuTargetPath(undefined);
  }, [debugState]);

  const [virtualRange, setVirtualRange] = useState<ExplorerVirtualRange | null>(
    null,
  );

  const requestFocus = useCallback(() => {
    setFocusToken((token) => token + 1);
  }, []);

  const closeSearch = useCallback(() => {
    search.close();
    // FR-049/T109: closing the transient input returns the Header to `Files` and
    // hands keyboard scope back to the stable Tree viewport.
    requestFocus();
  }, [requestFocus, search]);

  const moreModel = useMemo(
    () =>
      readOnly
        ? []
        : buildExplorerMoreMenuModel(actions.contextFor(), {
            isEnabled: isCommandEnabled,
          }),
    // The context is derived from represented state, so it is rebuilt whenever
    // that state changes.
    [actions, isCommandEnabled, readOnly, state],
  );

  // The fixture is not a Workspace, so it renders without one: its own root name
  // stands in for the Workspace name, and the real Workspace's state only decides
  // whether the *real* Tree is available (T229).
  if (renderedState.contextId === null) {
    // Without a Workspace the Explorer offers no filesystem mutation context
    // menu at all; its only action is opening a folder (FR-053, US8 acceptance 5).
    return (
      <div className="explorer explorer--empty">
        <p className="explorer__hint">No folder is open.</p>
        <button type="button" className="shell-button" onClick={onOpenFolder}>
          Open Folder
        </button>
      </div>
    );
  }

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    // Explorer-local triggers: F2/Delete are deliberately absent from the global
    // keymap, so pressing Delete while the editor has focus still deletes text.
    // Whether the command is *available* is left to the registry, which is the
    // single availability authority (FR-079, FR-080).
    //
    // The disposable fixture holds no entry that a filesystem operation could
    // target, so those two keys dispatch nothing while it is rendered (T229).
    if (event.key === "F2") {
      event.preventDefault();
      if (!readOnly) {
        onCommand("explorer.rename");
      }
      return;
    }
    if (event.key === "Delete") {
      event.preventDefault();
      if (!readOnly) {
        onCommand("explorer.delete");
      }
      return;
    }

    /*
     * Direct type-to-search (FR-046, T108).
     *
     * The triggering character seeds the transient input, which then owns the
     * rest of the typing. Shortcuts, IME composition and any control that already
     * owns text are excluded, so this can never steal a keystroke from an editor,
     * a menu or a dialog (FR-050, T105).
     */
    const seed = typeToSearchSeed(event, {
      inlineEditorFocused: renderedState.inlineEdit !== null,
      searchInputFocused: search.query !== null,
      otherTextControlFocused: isTextControlTarget(event.target),
    });
    if (seed !== null) {
      event.preventDefault();
      search.start(seed);
    }
  };

  const nodeForTarget = (path: string | null): ExplorerNode | null =>
    path === null ? null : (controller.getNode(path) ?? null);

  const onTarget = (target: SoraContextTarget): void => {
    const path = rowPathFromTarget(target.element);
    if (readOnly) {
      // The fixture owns the gesture: the targeted row becomes the fixture's own
      // selection, and no operation context is derived from the real controller
      // (T229).
      applySelection(path);
      setMenuTargetPath(undefined);
      return;
    }
    // Right-click selects the logical row first, so the menu and the command
    // registry resolve the same operation context (FR-076, FR-080).
    actions.handleContextMenu(nodeForTarget(path));
    setMenuTargetPath(path);
  };

  const menuContext =
    readOnly || menuTargetPath === undefined
      ? null
      : actions.contextFor(nodeForTarget(menuTargetPath));

  // The Header's actions all describe the *real* Workspace — Locate resolves the
  // active document against it and Collapse All collapses its Tree — so they are
  // not offered while a different Tree is on screen (T229).
  const headerActions = readOnly ? null : (
    <>
      {explorerHeaderActions(headerState).map((action) => (
        <button
          key={action.commandId}
          type="button"
          className="explorer__action"
          title={action.label}
          aria-label={action.label}
          disabled={!action.enabled}
          data-sora-interactive=""
          onClick={() => {
            onCommand(action.commandId);
          }}
        >
          <IconGlyph descriptor={uiIcon(action.icon)} />
        </button>
      ))}

      {isMoreAvailable(headerState) ? (
        <SoraMenu
          model={moreModel}
          triggerLabel="More Explorer actions"
          triggerClassName="explorer__action"
          trigger={<AppIcon name="more" />}
          align="end"
          onAction={(item) => {
            activateMenuItem(item, onCommand);
          }}
        />
      ) : null}
    </>
  );

  const searchSlot =
    search.query === null
      ? null
      : {
          query: search.query,
          matchCount: search.matchCount,
          onQueryChange: search.update,
          onClose: closeSearch,
          onStep: search.step,
        };

  // An explicit Locate request wins over the transient search's current match;
  // both are one-shot reveal intents addressed by logical key (T110, T120).
  const revealKey = revealRequest?.key ?? search.currentKey ?? null;

  return (
    <div
      className="explorer"
      // The Tree viewport, not this region, is the stable focus owner (T096);
      // the key handler stays here so F2/Delete and the direct-type trigger work
      // from the Tree and from any control inside the Explorer.
      role="group"
      aria-label="Explorer"
      onKeyDown={onKeyDown}
    >
      <ExplorerHeader
        workspaceName={readOnly ? (fixture.root?.name ?? null) : workspaceName}
        search={searchSlot}
        actions={headerActions}
      />

      {renderedState.rootUnavailable ? (
        <p className="explorer__error" role="alert">
          This folder could not be read. Use Refresh to try again.
        </p>
      ) : null}

      {/*
        Development-only counters (T180, T181). The strip is not rendered at all
        when the diagnostic is off, so it cannot alter Tree geometry, and it never
        carries application state.
      */}
      {debugOptions?.showVirtualRange === true ? (
        <div className="explorer__debug" aria-live="off">
          {virtualRange === null ? (
            <span>no rows</span>
          ) : (
            <>
              <span>visible {virtualRange.visibleRowCount}</span>
              <span>rendered {virtualRange.renderedRowCount}</span>
              <span>
                range {virtualRange.virtualStart}–{virtualRange.virtualEnd}
              </span>
            </>
          )}
          {readOnly ? <span>fixture</span> : null}
        </div>
      ) : null}

      <ExplorerContextMenu
        context={menuContext}
        onTarget={onTarget}
        isEnabled={isCommandEnabled}
        suppressPopup={readOnly}
        onAction={(action: ExplorerMenuAction) => {
          setMenuTargetPath(undefined);
          onCommand(action);
        }}
        onOpenChange={(open) => {
          if (!open) {
            // A closed menu forgets its target, so the next gesture captures a
            // fresh one instead of acting on a recycled row.
            setMenuTargetPath(undefined);
          }
        }}
      >
        <ExplorerVirtualTree
          state={renderedState}
          rows={rows}
          metrics={metrics}
          revealKey={revealKey}
          focusToken={focusToken}
          debugOptions={debugOptions}
          onVirtualRangeChange={setVirtualRange}
          onRevealHandled={() => {
            if (revealRequest != null) {
              onRevealHandled?.();
            }
          }}
          onSelect={(path) => {
            // The controller's selection is only ever written on this path, which
            // routes a fixture row to the fixture instead (T229).
            applySelection(path);
          }}
          onToggleDirectory={(path) => {
            if (!readOnly) {
              // The fixture's shape is fixed by design: expansion is not a UI
              // operation there, so the fixture Tree stays fully materialized.
              void controller.toggleDirectory(path);
            }
          }}
          onOpenFile={(path) => {
            if (!readOnly) {
              void actions.openFile(path);
            }
          }}
          onInlineDraftChange={(name) => {
            if (!readOnly) {
              controller.updateInlineDraft(name);
            }
          }}
          onInlineCommit={() => {
            if (readOnly) {
              return Promise.resolve("retained" as const);
            }
            // The commit result travels back to the inline input: that is what
            // lets a retained draft become editable and focused again (FR-016).
            return actions.commitInlineEdit();
          }}
          onInlineCancel={() => {
            if (!readOnly) {
              controller.cancelInlineEdit();
            }
          }}
        />
      </ExplorerContextMenu>
    </div>
  );
}
