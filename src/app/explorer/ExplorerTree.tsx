/**
 * Explorer tree rendering.
 *
 * Presentation and interaction only: the tree renders the state it is handed and
 * reports the path the user acted on. It never reads the filesystem and never
 * decides which document becomes active.
 *
 * Three interaction rules are deliberate:
 *
 * - single-clicking a **file** selects it without opening it (FR-035);
 * - single-clicking a **directory** selects it *and* toggles its expansion,
 *   while the chevron toggles expansion alone (FR-037, US3 acceptance 3);
 * - clicking a row moves keyboard focus into the Explorer, which is what scopes
 *   the F2/Delete handler to the Explorer (FR-079).
 */

import type { KeyboardEvent, MouseEvent, ReactNode } from "react";

import { AppIcon, type AppIconName } from "../shell/AppIcon";
import type {
  ExplorerDirectoryNode,
  ExplorerNode,
  ExplorerState,
  InlineEditState,
} from "./explorerModel";

/** Where a context menu was requested. */
export interface MenuPosition {
  x: number;
  y: number;
}

export interface ExplorerTreeProps {
  /** The controller's current tree state. */
  state: ExplorerState;
  /** Selects a row without opening anything. */
  onSelect(path: string): void;
  /** Expands/collapses a directory; loads it the first time. */
  onToggleDirectory(path: string): void;
  /** Opens a file through the shared document pipeline. */
  onOpenFile(path: string): void;
  /** Requests the context menu for `node`, or for blank space when `null`. */
  onContextMenu(node: ExplorerNode | null, position: MenuPosition): void;
  /** Records an inline editor keystroke. */
  onInlineDraftChange(name: string): void;
  /** Commits the inline editor (Enter). */
  onInlineCommit(): void;
  /** Cancels the inline editor (Escape). */
  onInlineCancel(): void;
}

/** The glyph for one visible node. */
function iconFor(node: ExplorerNode): AppIconName {
  if (node.kind === "directory") {
    return node.expanded ? "folder-open" : "folder";
  }
  return "file";
}

/** The indentation of one depth level. */
const INDENT = 14;

/** Renders the single-root tree. */
export function ExplorerTree(props: ExplorerTreeProps) {
  const root = props.state.root;
  if (root === null) {
    return null;
  }

  return (
    // Right-clicking blank space is handled by the Explorer body, which owns
    // the whole scrollable area; a row stops propagation and opens the menu for
    // its own node instead.
    <div className="explorer-tree" role="tree" aria-label="Workspace files">
      <NodeRow node={root} depth={0} {...props} />
    </div>
  );
}

/** Renders one file, directory or special entry row, plus its subtree. */
function NodeRow({
  node,
  depth,
  ...props
}: ExplorerTreeProps & { node: ExplorerNode; depth: number }) {
  const { state } = props;
  const selected = state.selectedPath === node.path;

  const edit = state.inlineEdit;
  const renaming =
    edit !== null && edit.type === "rename" && edit.sourcePath === node.path
      ? edit
      : null;

  const rowClasses = ["explorer-row"];
  if (selected) {
    rowClasses.push("explorer-row--selected");
  }
  if (node.isSymlink) {
    rowClasses.push("explorer-row--link");
  }

  return (
    <>
      <div
        className={rowClasses.join(" ")}
        style={{ paddingLeft: `${depth * INDENT + 8}px` }}
        role="treeitem"
        aria-selected={selected}
        aria-expanded={node.kind === "directory" ? node.expanded : undefined}
        // Roving focus: clicking a row moves keyboard focus into the Explorer.
        tabIndex={-1}
        // FR-033: the complete path stays available even when the row truncates
        // a long name.
        title={node.path}
        onClick={(event: MouseEvent<HTMLDivElement>) => {
          event.currentTarget.focus();
          props.onSelect(node.path);
          // A directory toggles from the row as well as from its chevron.
          if (node.kind === "directory") {
            props.onToggleDirectory(node.path);
          }
        }}
        onDoubleClick={() => {
          if (node.kind === "file") {
            props.onOpenFile(node.path);
          }
        }}
        onContextMenu={(event) => {
          event.preventDefault();
          event.stopPropagation();
          props.onContextMenu(node, { x: event.clientX, y: event.clientY });
        }}
      >
        {node.kind === "directory" ? (
          <button
            type="button"
            className="explorer-row__chevron"
            aria-label={node.expanded ? `Collapse ${node.name}` : `Expand ${node.name}`}
            onClick={(event: MouseEvent) => {
              // The chevron toggles expansion only; selection is unchanged.
              event.stopPropagation();
              props.onToggleDirectory(node.path);
            }}
          >
            <AppIcon name={node.expanded ? "chevron-down" : "chevron-right"} />
          </button>
        ) : (
          <span className="explorer-row__chevron explorer-row__chevron--empty" />
        )}

        <AppIcon name={iconFor(node)} className="explorer-row__icon" />

        {renaming === null ? (
          <span className="explorer-row__label">{node.name}</span>
        ) : (
          <InlineEditorInput
            edit={renaming}
            label={`Rename ${renaming.originalName}`}
            {...props}
          />
        )}

        {node.isSymlink ? (
          <AppIcon name="link" className="explorer-row__badge" title="Link" />
        ) : null}
      </div>

      {node.kind === "directory" && node.expanded ? (
        <DirectoryChildren node={node} depth={depth} {...props} />
      ) : null}
    </>
  );
}

/**
 * Renders the rows *inside* an expanded directory.
 *
 * Any load notice is rendered in addition to cached children, so a failed
 * refresh shows a localized error without hiding what was already loaded
 * (FR-029).
 */
function DirectoryChildren({
  node,
  depth,
  ...props
}: ExplorerTreeProps & { node: ExplorerDirectoryNode; depth: number }) {
  const rows: ReactNode[] = [];
  const edit = props.state.inlineEdit;

  if (edit !== null && edit.type !== "rename" && edit.parentPath === node.path) {
    rows.push(
      <div
        key="inline-create"
        className="explorer-row explorer-row--editing"
        style={{ paddingLeft: `${(depth + 1) * INDENT + 8}px` }}
      >
        <span className="explorer-row__chevron explorer-row__chevron--empty" />
        <AppIcon
          name={edit.type === "create-file" ? "new-file" : "new-folder"}
          className="explorer-row__icon"
        />
        <InlineEditorInput
          edit={edit}
          label={edit.type === "create-file" ? "New file name" : "New folder name"}
          {...props}
        />
      </div>,
    );
  }

  if (node.loadState === "loading" && node.children === undefined) {
    rows.push(
      <div
        key="loading"
        className="explorer-row explorer-row--notice"
        style={{ paddingLeft: `${(depth + 1) * INDENT + 8}px` }}
      >
        <span className="explorer-row__label">Loading...</span>
      </div>,
    );
  } else if (node.errorMessage !== undefined) {
    rows.push(
      <div
        key="notice"
        className="explorer-row explorer-row--notice"
        style={{ paddingLeft: `${(depth + 1) * INDENT + 8}px` }}
      >
        <span className="explorer-row__label">{node.errorMessage}</span>
      </div>,
    );
  }

  for (const child of node.children ?? []) {
    rows.push(
      <NodeRow key={child.path} node={child} depth={depth + 1} {...props} />,
    );
  }

  return <>{rows}</>;
}

/** The shared inline text editor used by both create and rename. */
function InlineEditorInput({
  edit,
  label,
  onInlineDraftChange,
  onInlineCommit,
  onInlineCancel,
}: {
  edit: InlineEditState;
  label: string;
} & Pick<
  ExplorerTreeProps,
  "onInlineDraftChange" | "onInlineCommit" | "onInlineCancel"
>) {
  return (
    <input
      className="explorer-inline-input"
      // Exactly one inline editor exists at a time, so it always takes focus.
      autoFocus
      value={edit.draftName}
      aria-label={label}
      spellCheck={false}
      onClick={(event: MouseEvent) => {
        event.stopPropagation();
      }}
      onDoubleClick={(event: MouseEvent) => {
        event.stopPropagation();
      }}
      onChange={(event) => {
        onInlineDraftChange(event.target.value);
      }}
      onKeyDown={(event: KeyboardEvent<HTMLInputElement>) => {
        // The Explorer's F2/Delete handler must not see keys typed into the
        // editor, and Enter/Escape are the only commit/cancel gestures (FR-054).
        event.stopPropagation();
        if (event.key === "Enter") {
          event.preventDefault();
          onInlineCommit();
        } else if (event.key === "Escape") {
          event.preventDefault();
          onInlineCancel();
        }
      }}
    />
  );
}
