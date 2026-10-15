/**
 * The window-capability contract (007 T041, and the regression behind
 * `window.set_title not allowed on window "main"`).
 *
 * A Tauri capability that grants a `core:window:*` permission but omits
 * `windows`/`webviews` resolves to a command with **empty** window and webview
 * patterns, and the ACL check is:
 *
 * ```text
 * resolved.webviews.any(matches(webview)) || resolved.windows.any(matches(window))
 * ```
 *
 * so both sides are `false` and *every* window permission in that capability is
 * denied — including the ones the unsaved-work guard depends on. The bundled
 * `gen/schemas/capabilities.json` shows the resolved form, which is how this was
 * diagnosed, and this test pins the source form so a future edit cannot silently
 * drop the scope again.
 */

import { describe, expect, it } from "vitest";

import capabilityFile from "../../../src-tauri/capabilities/default.json";

interface CapabilityFile {
  identifier: string;
  windows?: string[];
  webviews?: string[];
  local?: boolean;
  permissions: (string | { identifier: string })[];
}

const capability = capabilityFile as CapabilityFile;

/** The permission identifiers, flattening the `{ identifier, scope }` form. */
function permissionIds(): string[] {
  return capability.permissions.map((entry) =>
    typeof entry === "string" ? entry : entry.identifier,
  );
}

describe("main window capability", () => {
  it("targets the main window explicitly", () => {
    // This is the line whose absence denied every window command.
    expect(capability.windows).toContain("main");
  });

  it("keeps the window webview scope either explicit or implicit through windows", () => {
    // `windows` alone is enough (it covers all webviews of that window), but at
    // least one of the two must be present.
    const scoped =
      (capability.windows?.length ?? 0) > 0 ||
      (capability.webviews?.length ?? 0) > 0;
    expect(scoped).toBe(true);
  });

  it("stays a local-URL capability", () => {
    // Absent means `true`, which is what the packaged application needs.
    expect(capability.local ?? true).toBe(true);
  });

  it("keeps the permissions the window lifecycle depends on", () => {
    const ids = permissionIds();

    // Title synchronisation and the approved forced destroy (001/002 lifecycle).
    expect(ids).toContain("core:window:allow-set-title");
    expect(ids).toContain("core:window:allow-destroy");
    // 007 custom chrome: normal close, minimize, maximize/restore, state query
    // and the explicit drag surface (FR-007, FR-008).
    expect(ids).toContain("core:window:allow-close");
    expect(ids).toContain("core:window:allow-minimize");
    expect(ids).toContain("core:window:allow-toggle-maximize");
    expect(ids).toContain("core:window:allow-is-maximized");
    expect(ids).toContain("core:window:allow-start-dragging");
    // Dialogs are the only other plugin surface the application uses.
    expect(ids).toContain("dialog:default");
  });

  it("grants no window permission the application does not use", () => {
    const windowPermissions = permissionIds().filter((id) =>
      id.startsWith("core:window:"),
    );
    expect(windowPermissions.sort()).toEqual([
      "core:window:allow-close",
      "core:window:allow-destroy",
      "core:window:allow-is-maximized",
      "core:window:allow-minimize",
      "core:window:allow-set-title",
      "core:window:allow-start-dragging",
      "core:window:allow-toggle-maximize",
    ]);
  });
});
