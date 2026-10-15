# Contract: Application Commands, Menu, and Keymap

## Stable command IDs

```ts
type CommandId =
  | "file.new"
  | "file.open"
  | "file.save"
  | "file.saveAs"
  | "app.exit"
  | "editor.undo"
  | "editor.redo";
```

Every application surface invokes behavior through these IDs. Menu code must not call document/file functions directly.

## Registry contract

```ts
interface CommandRegistry {
  register(id: CommandId, handler: () => void | Promise<void>): () => void;
  execute(id: CommandId): Promise<void>;
}
```

Expected behavior:

- duplicate registration of the same command ID is rejected or explicitly replaces only through a deliberate API; silent multiple handlers are not allowed
- one `execute(id)` call invokes at most one active handler
- execution errors are surfaced to the caller/application error path rather than swallowed

## IDEA M1 keymap profile

```ts
const ideaKeymap = {
  "file.new": "Ctrl+N",
  "file.open": "Ctrl+O",
  "file.save": "Ctrl+S",
  "file.saveAs": "Ctrl+Shift+S",
  "editor.undo": "Ctrl+Z",
  "editor.redo": "Ctrl+Shift+Z",
} as const;
```

`app.exit` has no required shortcut in M1.

## Native menu contract

```text
File
├─ New          Ctrl+N       -> file.new
├─ Open...      Ctrl+O       -> file.open
├─ Save         Ctrl+S       -> file.save
├─ Save As...   Ctrl+Shift+S -> file.saveAs
└─ Exit                      -> app.exit

Edit
├─ Undo         Ctrl+Z       -> editor.undo
└─ Redo         Ctrl+Shift+Z -> editor.redo
```

### Dispatch rule

For M1, the native menu accelerator is the shortcut dispatcher for these commands. Do not additionally install a global DOM `keydown` handler for the same bindings. Menu clicks and accelerators both call `registry.execute(commandId)`, satisfying one-command/one-execution behavior.

## Editor command contract

`editor.undo` and `editor.redo` operate on the currently mounted `EditorView` through `EditorHandle` and use CodeMirror's command functions. They do not manipulate React text state.

## Lifecycle command contract

`file.new`, `file.open`, and `app.exit` all invoke the same unsaved-work guard before they discard/replace the active document. `file.open` first selects and successfully reads/decodes its target. Picker cancellation or read/decode failure never invokes the guard or changes the current session; a successful guard decision then permits installing the validated target.

`file.save` and `file.saveAs` return a logical success/cancel/failure result to callers that need to decide whether a destructive operation may continue.
