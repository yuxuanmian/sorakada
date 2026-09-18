# Contract: Command Availability

003 extends the existing application command registry without introducing a generic context-key framework.

## Registration

```ts
interface CommandRegistration {
  execute(): void | Promise<void>;
  isEnabled?(): boolean;
}
```

## Registry behavior

```ts
interface CommandRegistry {
  register(id: CommandId, registration: CommandRegistration): () => void;
  execute(id: CommandId): Promise<void>;
  isEnabled(id: CommandId): boolean;
  has(id: CommandId): boolean;
}
```

- Omitted `isEnabled` -> enabled.
- `execute(id)` checks availability at execution time.
- Executing a disabled command does not call its handler.
- Unknown command behavior remains an error as in 002.

## Required 003 command identities

Existing document/editor commands remain. Add stable ids for:

```text
workspace.openFolder
workspace.closeFolder
explorer.newFile
explorer.newFolder
explorer.rename
explorer.delete
explorer.refresh
view.toggleExplorer
```

## Availability rules

- `file.new`, `file.open`, `workspace.openFolder`, `app.exit`, `view.toggleExplorer`: generally enabled.
- `file.save`, `file.saveAs`, `file.close`, `editor.undo`, `editor.redo`: enabled only when an active document/editor exists.
- `workspace.closeFolder`: enabled only with an active WorkContext.
- `explorer.newFile`, `explorer.newFolder`, `explorer.refresh`: enabled only with an active WorkContext and valid operation context.
- `explorer.rename`, `explorer.delete`: enabled only for a selected non-root entry with a valid operation target.

Explorer focus is not part of Rename/Delete's general command validity because context-menu activation moves focus. Instead, F2/Delete are only *triggered* by the Explorer-local keyboard handler when Explorer has keyboard focus.

## Shortcut consumption

For globally recognized document shortcuts such as Ctrl+S, the page-level dispatcher consumes the key even when the command is disabled, then performs no action. This prevents a recognized Sorakada shortcut from leaking to a second handler.

Plain editor keys such as Delete are not globally recognized as Explorer commands.
