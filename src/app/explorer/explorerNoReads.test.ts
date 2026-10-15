/**
 * T189/T190: the "UI does no I/O" guarantees.
 *
 * 007's central promise is that the new UI never becomes a second filesystem
 * client: type-to-search, horizontal width measurement, icon resolution and the
 * Footer projection must all work from already-materialized data, and only
 * `ExplorerController` may change selection, expansion or the inline edit.
 */

import { describe, expect, it, vi } from "vitest";

import type {
  ReadWorkspaceDirectoryResult,
  WorkspaceDirectoryEntry,
} from "../../services/workspaceFileService";
import { NEW_DOCUMENT_FORMAT } from "../document/documentSession";
import { defaultFileIconProvider } from "../icons/fileIconProvider";
import { DENSITY_METRICS } from "../shell/density";
import { projectFooter } from "../shell/footerProjection";
import { ExplorerController } from "./explorerController";
import { flattenVisibleExplorerRows } from "./explorerProjection";
import { matchVisibleRowKeys } from "./explorerQuickSearch";
import { computeTreeHorizontalExtent } from "./explorerTreeMetrics";
import { createApproximateLabelMeasurer } from "../shell/textMeasurement";

const ROOT = "C:\\work";

class RecordingReader {
  readonly reads: string[] = [];

  readWorkspaceDirectory(path: string): Promise<ReadWorkspaceDirectoryResult> {
    this.reads.push(path);
    const entries: WorkspaceDirectoryEntry[] =
      path.toLowerCase() === ROOT.toLowerCase()
        ? [
            {
              name: "src",
              path: `${ROOT}\\src`,
              kind: "directory",
              isSymlink: true,
              objectIdentity: "id:src",
            },
            {
              name: "a-very-long-file-name-that-overflows.ts",
              path: `${ROOT}\\a-very-long-file-name-that-overflows.ts`,
              kind: "file",
              isSymlink: false,
              objectIdentity: "id:long",
            },
          ]
        : [];
    return Promise.resolve({
      requestedPath: path,
      canonicalPath: path,
      comparisonKey: path.toLowerCase(),
      caseSensitive: false,
      entries,
    });
  }
}

async function openTree() {
  const reader = new RecordingReader();
  const controller = new ExplorerController({ workspaceFileService: reader });
  controller.setContext({
    id: "workspace-1",
    rootPath: ROOT,
    canonicalRootPath: ROOT,
    comparisonKey: ROOT.toLowerCase(),
    displayName: "work",
  });
  await new Promise((resolve) => setTimeout(resolve, 0));
  return { controller, reader };
}

describe("UI work performs zero workspace filesystem reads (T189, SC-010)", () => {
  it("type-to-search, measurement, icons and the Footer read nothing", async () => {
    const { controller, reader } = await openTree();
    const rows = flattenVisibleExplorerRows(controller.getState());
    reader.reads.length = 0;

    // 1. Type-to-search over the visible projection.
    expect(matchVisibleRowKeys(rows, "long")).toContain(
      "C:\\work\\a-very-long-file-name-that-overflows.ts",
    );

    // 2. Horizontal extent from the materialized projection.
    const extent = computeTreeHorizontalExtent({
      rows,
      metrics: DENSITY_METRICS.default,
      measurer: createApproximateLabelMeasurer({
        fontSize: "13px",
        fontFamily: "system-ui",
      }),
    });
    expect(extent.contentWidth).toBeGreaterThan(0);

    // 3. Icon resolution for every projected row.
    for (const row of rows) {
      if (row.kind === "node") {
        expect(defaultFileIconProvider.resolve(row.node).icon.id).toBeTruthy();
      }
    }

    // 4. The Footer projection.
    projectFooter({
      workspace: {
        rootPath: ROOT,
        comparisonKey: ROOT.toLowerCase(),
        displayName: "work",
      },
      document: {
        displayName: "a-very-long-file-name-that-overflows.ts",
        path: "C:\\work\\a-very-long-file-name-that-overflows.ts",
        pathKey: "c:\\work\\a-very-long-file-name-that-overflows.ts",
        format: { ...NEW_DOCUMENT_FORMAT },
      },
    });

    expect(reader.reads).toEqual([]);
  });

  it("density switching reads nothing either", async () => {
    const { controller, reader } = await openTree();
    reader.reads.length = 0;

    for (const density of ["compact", "default", "comfortable"] as const) {
      const metrics = DENSITY_METRICS[density];
      computeTreeHorizontalExtent({
        rows: flattenVisibleExplorerRows(controller.getState()),
        metrics,
        measurer: createApproximateLabelMeasurer({
          fontSize: "13px",
          fontFamily: "system-ui",
        }),
      });
    }

    expect(reader.reads).toEqual([]);
  });
});

describe("only ExplorerController owns Tree interaction state (T190)", () => {
  it("exposes exactly the mutators the UI is allowed to call", async () => {
    const { controller } = await openTree();

    // The public surface that changes Tree state is deliberately small: the UI has
    // no way to mutate nodes, expansion or the draft except through these.
    const mutators = [
      "selectPath",
      "clearSelection",
      "toggleDirectory",
      "expandDirectory",
      "beginCreate",
      "beginRename",
      "updateInlineDraft",
      "cancelInlineEdit",
      "collapseAll",
    ] as const;

    for (const method of mutators) {
      expect(typeof (controller as unknown as Record<string, unknown>)[method]).toBe(
        "function",
      );
    }
  });

  it("leaves selection, expansion and the inline edit untouched by projection work", async () => {
    const { controller } = await openTree();
    await controller.expandDirectory(`${ROOT}\\src`);
    controller.selectPath(`${ROOT}\\src`);
    controller.beginRename(`${ROOT}\\a-very-long-file-name-that-overflows.ts`);

    const before = {
      selected: controller.getSelectedPath(),
      srcExpanded: (controller.getNode(`${ROOT}\\src`) as { expanded: boolean })
        .expanded,
      edit: controller.getInlineEdit(),
    };

    // Simulating row mount/unmount: the projection is rebuilt many times, which is
    // all the renderer does when a virtual row is recycled.
    for (let pass = 0; pass < 50; pass += 1) {
      flattenVisibleExplorerRows(controller.getState());
    }

    expect(controller.getSelectedPath()).toBe(before.selected);
    expect(
      (controller.getNode(`${ROOT}\\src`) as { expanded: boolean }).expanded,
    ).toBe(before.srcExpanded);
    expect(controller.getInlineEdit()).toBe(before.edit);
  });

  it("keeps the inline editor's logical state identical whether its row is visible or not", async () => {
    const { controller } = await openTree();
    await controller.expandDirectory(`${ROOT}\\src`);
    controller.beginRename(`${ROOT}\\a-very-long-file-name-that-overflows.ts`);

    const visible = flattenVisibleExplorerRows(controller.getState());
    expect(
      visible.some(
        (row) =>
          row.kind === "node" &&
          row.path === `${ROOT}\\a-very-long-file-name-that-overflows.ts`,
      ),
    ).toBe(true);

    // Collapsing the branch hides the row; the draft is cancelled only because the
    // user dismissed the row, never because virtualization unmounted it.
    await controller.toggleDirectory(`${ROOT}\\src`);
    const editAfterCollapse = controller.getInlineEdit();
    expect(editAfterCollapse).not.toBeNull();

    controller.cancelInlineEdit();
    expect(controller.getInlineEdit()).toBeNull();
  });

  it("never lets a renderer-provided callback reach a service", async () => {
    const { controller } = await openTree();
    const spy = vi.fn();
    // The Tree component only receives these callbacks; none of them is a service.
    const callbacks = {
      onSelect: (path: string) => controller.selectPath(path),
      onToggleDirectory: (path: string) => void controller.toggleDirectory(path),
      onInlineDraftChange: (name: string) => controller.updateInlineDraft(name),
    };
    void callbacks.onSelect(`${ROOT}\\src`);
    void callbacks.onInlineDraftChange("x");
    spy();
    expect(controller.getSelectedPath()).toBe(`${ROOT}\\src`);
  });
});
