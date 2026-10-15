import { t } from "./index";

/** Path association is the fact that distinguishes a real filename from UntitledN. */
export function localizedDocumentName(document: { path: string | null; displayName: string }): string {
  if (document.path !== null) return document.displayName;
  // This is the manager's internal monotonic name, never a user filename.
  const number = document.displayName.startsWith("Untitled")
    ? document.displayName.slice("Untitled".length)
    : "";
  return t("core.untitled", { number });
}
