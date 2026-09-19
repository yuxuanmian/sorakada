/**
 * T066/T067: the Explorer context-menu grouping and targeting rules.
 *
 * These are the 003/004 contracts that must survive the move to the shared
 * context-menu wrapper: a file's menu offers file-local actions only, while root
 * and directory contexts keep creation and Refresh; and every entry still names
 * the same command id it always did.
 */

import { describe, expect, it } from "vitest";

import type { CommandId } from "../commands/commandIds";
import { COMMAND_IDS } from "../commands/commandIds";
import type { WorkContext } from "../workspace/workContext";
import { deriveFileOperationContext } from "./explorerActions";
import type { ExplorerNode } from "./explorerModel";
import { allMenuItems } from "../../ui/menu/menuModel";
import {
  EXPLORER_MENU_ACTIONS,
  buildExplorerMenuModel,
} from "./explorerMenuModel";

const workContext: WorkContext = {
  id: "workspace-1",
  rootPath: "C:\\work",
  canonicalRootPath: "c:\\work",
  comparisonKey: "c:\\work",
  displayName: "work",
};

function fileNode(path = "C:\\work\\src\\a.ts"): ExplorerNode {
  return {
    name: path.slice(path.lastIndexOf("\\") + 1),
    path,
    kind: "file",
    isSymlink: false,
    objectIdentity: null,
  };
}

function directoryNode(path = "C:\\work\\src"): ExplorerNode {
  return {
    name: path.slice(path.lastIndexOf("\\") + 1),
    path,
    kind: "directory",
    isSymlink: false,
    objectIdentity: null,
    expanded: true,
    loadState: "loaded",
  };
}

const everythingEnabled = (): boolean => true;

function actionIds(context: ReturnType<typeof deriveFileOperationContext>) {
  return allMenuItems(
    buildExplorerMenuModel(context, { isEnabled: everythingEnabled }),
  ).map((item) => item.id);
}

describe("Explorer context menu grouping", () => {
  it("offers creation, entry actions and Refresh for the root context", () => {
    expect(actionIds(deriveFileOperationContext(workContext, null))).toEqual([
      "explorer.newFile",
      "explorer.newFolder",
      "explorer.refresh",
    ]);
  });

  it("offers creation and Refresh for a directory context", () => {
    expect(
      actionIds(deriveFileOperationContext(workContext, directoryNode())),
    ).toEqual([
      "explorer.newFile",
      "explorer.newFolder",
      "explorer.rename",
      "explorer.delete",
      "explorer.refresh",
    ]);
  });

  it("omits New File/New Folder for a file context (004 rule, T067)", () => {
    expect(actionIds(deriveFileOperationContext(workContext, fileNode()))).toEqual(
      ["explorer.rename", "explorer.delete"],
    );
  });

  it("keeps the context menu Refresh-free for a file even though the command is available", () => {
    const context = deriveFileOperationContext(workContext, fileNode());
    expect(actionIds(context)).not.toContain("explorer.refresh");
    // The command itself is untouched: SR-002 de-emphasises its placement only.
    expect(COMMAND_IDS).toContain("explorer.refresh");
  });

  it("offers nothing without a Workspace", () => {
    expect(actionIds(deriveFileOperationContext(null, null))).toEqual([]);
  });

  it("separates creation, entry actions and Refresh into their own sections", () => {
    const model = buildExplorerMenuModel(
      deriveFileOperationContext(workContext, directoryNode()),
      { isEnabled: everythingEnabled },
    );
    expect(model.map((section) => section.id)).toEqual([
      "create",
      "entry",
      "refresh",
    ]);
  });
});

describe("Explorer context menu command identity", () => {
  it("names the same command id as the action it represents", () => {
    const model = buildExplorerMenuModel(
      deriveFileOperationContext(workContext, directoryNode()),
      { isEnabled: everythingEnabled },
    );
    for (const item of allMenuItems(model)) {
      expect(item.commandId).toBe(item.id);
      expect(EXPLORER_MENU_ACTIONS).toContain(item.id);
      expect(COMMAND_IDS).toContain(item.commandId as CommandId);
    }
  });

  it("disables exactly the entries the registry refuses (FR-022, FR-030)", () => {
    const model = buildExplorerMenuModel(
      deriveFileOperationContext(workContext, directoryNode()),
      { isEnabled: (id) => id !== "explorer.delete" },
    );
    const disabled = allMenuItems(model)
      .filter((item) => item.disabled === true)
      .map((item) => item.id);
    expect(disabled).toEqual(["explorer.delete"]);
  });

  it("keeps an entry listed but disabled when it applies but is unavailable", () => {
    const model = buildExplorerMenuModel(
      deriveFileOperationContext(workContext, fileNode()),
      { isEnabled: () => false },
    );
    expect(allMenuItems(model).map((item) => item.id)).toEqual([
      "explorer.rename",
      "explorer.delete",
    ]);
    expect(allMenuItems(model).every((item) => item.disabled === true)).toBe(
      true,
    );
  });
});
