import { describe, expect, it } from "vitest";
import { defaultKeymap, historyKeymap } from "@codemirror/commands";
import type { KeyBinding } from "@codemirror/view";

import { COMMAND_IDS } from "./commandIds";
import { IDEA_M1_KEYMAP, acceleratorFor, commandForKeyboardEvent } from "./ideaKeymap";

/**
 * Canonicalises both accelerator spellings to one comparable form, so
 * CodeMirror's `Mod-Shift-S` and the profile's `Ctrl+Shift+S` can be compared.
 */
function canonical(accelerator: string): string {
  const parts = accelerator.split("-").flatMap((part) => part.split("+"));
  const key = parts.pop() ?? "";
  const modifiers = new Set(
    parts.map((modifier) => (modifier === "Mod" ? "Ctrl" : modifier)),
  );

  return [...["Ctrl", "Shift", "Alt"].filter((m) => modifiers.has(m)), key.toUpperCase()].join(
    "+",
  );
}

function editorWindowsAccelerators(): Set<string> {
  const keys = new Set<string>();
  for (const binding of [...defaultKeymap, ...historyKeymap] as KeyBinding[]) {
    const key = binding.win ?? binding.key;
    if (typeof key === "string") {
      keys.add(canonical(key));
    }
  }
  return keys;
}

describe("IDEA M1 keymap profile", () => {
  it("maps the six M1 shortcuts to exactly the required accelerators", () => {
    expect(IDEA_M1_KEYMAP).toEqual({
      "file.new": "Ctrl+N",
      "file.open": "Ctrl+O",
      "file.save": "Ctrl+S",
      "file.saveAs": "Ctrl+Shift+S",
      "editor.undo": "Ctrl+Z",
      "editor.redo": "Ctrl+Shift+Z",
    });
  });

  it("binds only six of the seven command IDs", () => {
    expect(Object.keys(IDEA_M1_KEYMAP)).toHaveLength(6);
    expect(Object.keys(IDEA_M1_KEYMAP).sort()).toEqual(
      COMMAND_IDS.filter((id) => id !== "app.exit")
        .slice()
        .sort(),
    );
  });

  it("gives Exit no M1 accelerator", () => {
    expect(acceleratorFor("app.exit")).toBeUndefined();
  });

  it("resolves each bound accelerator by command id", () => {
    expect(acceleratorFor("file.new")).toBe("Ctrl+N");
    expect(acceleratorFor("file.open")).toBe("Ctrl+O");
    expect(acceleratorFor("file.save")).toBe("Ctrl+S");
    expect(acceleratorFor("file.saveAs")).toBe("Ctrl+Shift+S");
    expect(acceleratorFor("editor.undo")).toBe("Ctrl+Z");
    expect(acceleratorFor("editor.redo")).toBe("Ctrl+Shift+Z");
  });

  it("never binds one accelerator to two commands", () => {
    const accelerators = Object.values(IDEA_M1_KEYMAP);
    expect(new Set(accelerators).size).toBe(accelerators.length);
  });

  /**
   * Single-dispatcher regression check (FR-032, US4/AC4).
   *
   * A CodeMirror keymap binding that collides with an application shortcut is
   * exactly how a double dispatch could creep back in. `Ctrl+Z` is the one
   * overlap: `basicSetup` installs `historyKeymap`'s `Mod-z`, but the
   * application `keydown` dispatcher in `App.tsx` matches the profile first and
   * calls `stopPropagation`, so only `editor.undo` runs. If this list ever
   * grows, an application shortcut has gained a second route and one keypress
   * would fire two commands.
   */
  it("overlaps the editor keymap only where the application dispatcher wins", () => {
    const editorKeys = editorWindowsAccelerators();
    const collisions = Object.values(IDEA_M1_KEYMAP)
      .map(canonical)
      .filter((key) => editorKeys.has(key))
      .sort();

    expect(collisions).toEqual(["Ctrl+Z"]);
  });
});

describe("CommandId catalogue", () => {
  it("exposes exactly the seven M1 command identifiers", () => {
    expect(COMMAND_IDS).toEqual([
      "file.new",
      "file.open",
      "file.save",
      "file.saveAs",
      "app.exit",
      "editor.undo",
      "editor.redo",
    ]);
  });
});

describe("commandForKeyboardEvent", () => {
  const event = (
    key: string,
    modifiers: Partial<{
      ctrlKey: boolean;
      metaKey: boolean;
      shiftKey: boolean;
      altKey: boolean;
    }> = {},
  ) => ({
    key,
    ctrlKey: false,
    metaKey: false,
    shiftKey: false,
    altKey: false,
    ...modifiers,
  });

  it("resolves every shortcut in the IDEA profile", () => {
    expect(commandForKeyboardEvent(event("n", { ctrlKey: true }))).toBe("file.new");
    expect(commandForKeyboardEvent(event("o", { ctrlKey: true }))).toBe("file.open");
    expect(commandForKeyboardEvent(event("s", { ctrlKey: true }))).toBe("file.save");
    expect(
      commandForKeyboardEvent(event("S", { ctrlKey: true, shiftKey: true })),
    ).toBe("file.saveAs");
    expect(commandForKeyboardEvent(event("z", { ctrlKey: true }))).toBe("editor.undo");
    expect(
      commandForKeyboardEvent(event("Z", { ctrlKey: true, shiftKey: true })),
    ).toBe("editor.redo");
  });

  it("does not intercept unbound keys or plain typing", () => {
    for (const typed of ["a", "s", "n", "z", "Enter", "Backspace", "Tab", " "]) {
      expect(commandForKeyboardEvent(event(typed))).toBeUndefined();
    }
    expect(commandForKeyboardEvent(event("k", { ctrlKey: true }))).toBeUndefined();
    expect(
      commandForKeyboardEvent(event("s", { ctrlKey: true, altKey: true })),
    ).toBeUndefined();
  });

  it("ignores extra modifiers that the profile does not bind", () => {
    // Ctrl+S is Save; Ctrl+Shift+S is Save As. Adding Alt must match neither,
    // so AltGr combinations on non-US layouts are left alone.
    expect(
      commandForKeyboardEvent(event("s", { ctrlKey: true, altKey: true })),
    ).toBeUndefined();
  });

  it("never maps the same accelerator to two commands", () => {
    const seen = new Map<string, string>();
    for (const id of COMMAND_IDS) {
      const accelerator = acceleratorFor(id);
      if (!accelerator) {
        continue;
      }
      expect(seen.has(accelerator)).toBe(false);
      seen.set(accelerator, id);
    }
  });
});
