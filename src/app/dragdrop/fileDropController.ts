/**
 * Dropped-path orchestration.
 *
 * This module deliberately knows nothing about Tauri: it takes a list of paths
 * and the document manager, and drives the *same* open pipeline `File > Open`
 * uses. Drag/drop therefore has no separate file-opening implementation, no
 * separate duplicate detection and no separate decoding rules.
 */

import type {
  OpenPathOptions,
  OpenPathResult,
} from "../document/documentManager";
import type { DocumentId } from "../document/documentSession";

/** The part of the manager a dropped batch needs. */
export interface FileDropManager {
  openPath(path: string, options?: OpenPathOptions): Promise<OpenPathResult>;
  activateDocument(id: DocumentId): void;
}

/**
 * Opens every dropped path in the order it was dropped.
 *
 * Paths are awaited one at a time, which keeps the resulting Tab order
 * deterministic and makes duplicates within one batch resolve naturally. A
 * failure is already reported by the open pipeline, so it only skips that entry
 * rather than aborting the batch. Directories are skipped without workspace
 * behaviour. The last document that was actually opened or activated becomes
 * active; a batch that handled nothing leaves the active document alone.
 *
 * Returns the id of that last handled document, or `null` when none was.
 */
export async function processDroppedPaths(
  paths: readonly string[],
  manager: FileDropManager,
): Promise<DocumentId | null> {
  let lastHandledId: DocumentId | null = null;

  for (const path of paths) {
    const result = await manager.openPath(path, { ignoreDirectories: true });

    if (result.status === "opened" || result.status === "activated-existing") {
      lastHandledId = result.documentId;
    }
    // `failed`, `cancelled` and `ignored-directory` continue the batch.
  }

  if (lastHandledId !== null) {
    manager.activateDocument(lastHandledId);
  }

  return lastHandledId;
}
