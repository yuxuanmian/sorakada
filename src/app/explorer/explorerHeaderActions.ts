/**
 * Explorer Header action model (007 T106, T114, T121, T122, T124, FR-026..FR-030).
 *
 * The Header's actions are described as data so their availability is decided
 * once, by the same rules the command registry uses, and can be tested without a
 * rendered Header:
 *
 * - **Locate** is available from *document and Workspace state*, never from DOM
 *   focus (T114): an untitled document, no Workspace, or a file outside the
 *   Workspace all refuse it without any filesystem work (FR-051, FR-053).
 * - **Collapse All** is available exactly when represented expansion exists
 *   (FR-054).
 * - **More** carries the low-frequency actions — New File/New Folder when the
 *   shared operation context permits them, plus Refresh, which is no longer a
 *   primary Header button (FR-029, FR-030, SR-002).
 */

import type { CommandId } from "../commands/commandIds";
import type { UiIconId } from "../icons/iconTypes";
import { isWithinDirectory } from "../workspace/workContext";
import { isCreateAvailable, isRefreshAvailable, type FileOperationContext } from "./explorerActions";
import type { SoraMenuModel } from "../../ui/menu/menuModel";
import type { AppTranslator } from "../../i18n";
import { t } from "../../i18n";

/** The operation context and Workspace facts the Header actions depend on. */
export interface ExplorerHeaderState {
  /** Whether a Workspace is open. */
  hasWorkspace: boolean;
  /** Whether represented expansion exists below the root. */
  hasExpandedDirectories: boolean;
  /** The active document's canonical path key, or `null` (untitled/outside/no doc). */
  activeDocumentPathKey: string | null;
  /** The active Workspace's canonical comparison key, or `null`. */
  workspaceComparisonKey: string | null;
}

/**
 * Whether Locate Current File can do anything meaningful.
 *
 * Containment is decided by canonical components, so a document in
 * `D:\project-old` is not "inside" `D:\project` (FR-051, T118).
 */
export function isLocateAvailable(state: ExplorerHeaderState): boolean {
  if (
    state.workspaceComparisonKey === null ||
    state.activeDocumentPathKey === null
  ) {
    return false;
  }
  return isWithinDirectory(
    state.workspaceComparisonKey,
    state.activeDocumentPathKey,
  );
}

/** One Header action. */
export interface ExplorerHeaderAction {
  commandId: CommandId;
  label: string;
  icon: UiIconId;
  enabled: boolean;
}

/**
 * The Header's command actions, in display order.
 *
 * `More` is deliberately *not* here: it opens a popup rather than running a
 * command, so the component owns its trigger and this list stays exactly the set
 * of commands whose availability must be decided from state (T121).
 */
export function explorerHeaderActions(
  state: ExplorerHeaderState,
  translate: AppTranslator = t,
): ExplorerHeaderAction[] {
  return [
    {
      commandId: "explorer.locateCurrentFile",
      label: translate("ui.explorer.header.locate"),
      icon: "locate",
      enabled: isLocateAvailable(state),
    },
    {
      commandId: "explorer.collapseAll",
      label: translate("ui.explorer.header.collapseAll"),
      icon: "collapse-all",
      enabled: state.hasWorkspace && state.hasExpandedDirectories,
    },
  ];
}

/**
 * Whether the `More` region is shown at all.
 *
 * It exists whenever a Workspace is open: it is the stable home of the
 * low-frequency actions, so it must not appear and disappear with selection.
 */
export function isMoreAvailable(state: ExplorerHeaderState): boolean {
  return state.hasWorkspace;
}

/**
 * The `More` popup: creation when the shared target rule permits it, plus the
 * de-emphasised Refresh (FR-029, FR-030, T121, T122).
 */
export interface BuildExplorerMoreMenuModelOptions {
  isEnabled(commandId: CommandId): boolean;
  t?: AppTranslator;
}

export function buildExplorerMoreMenuModel(
  context: FileOperationContext,
  options: BuildExplorerMoreMenuModelOptions,
): SoraMenuModel {
  const { isEnabled, t: translate = t } = options;
  const sections: {
    id: string;
    items: { id: string; label: string; commandId: CommandId; disabled?: boolean }[];
  }[] = [];

  if (isCreateAvailable(context)) {
    sections.push({
      id: "create",
      items: [
        {
          id: "explorer.newFile",
          label: translate("ui.explorer.contextMenu.newFile"),
          commandId: "explorer.newFile",
          ...(isEnabled("explorer.newFile") ? {} : { disabled: true }),
        },
        {
          id: "explorer.newFolder",
          label: translate("ui.explorer.contextMenu.newFolder"),
          commandId: "explorer.newFolder",
          ...(isEnabled("explorer.newFolder") ? {} : { disabled: true }),
        },
      ],
    });
  }

  if (isRefreshAvailable(context)) {
    sections.push({
      id: "refresh",
      items: [
        {
          id: "explorer.refresh",
          label: translate("ui.explorer.contextMenu.refresh"),
          commandId: "explorer.refresh",
          ...(isEnabled("explorer.refresh") ? {} : { disabled: true }),
        },
      ],
    });
  }

  return sections;
}
