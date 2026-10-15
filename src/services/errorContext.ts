/** Presentation-only context; does not change Rust errors or business results. */
export interface OperationErrorContext {
  operation: "save" | "saveAs" | "open" | "reload" | "delete" | "rename" | "create" | "workspace" | "window" | "unknown";
  documentId?: string;
  path?: string;
  code?: string;
  generation?: number;
  batchId?: string;
  critical?: boolean;
}
