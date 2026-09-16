import type { CommandId } from "./commandIds";

/** A bound application action; may be asynchronous. */
export type CommandHandler = () => void | Promise<void>;

/**
 * The single dispatch point for application commands.
 *
 * Surfaces (native menu items, accelerators, and later custom keymaps) all go
 * through `execute`, which guarantees one command invocation produces exactly
 * one handler call.
 */
export interface CommandRegistry {
  /**
   * Binds `handler` to `id`.
   *
   * Registering the same ID twice throws rather than silently stacking
   * handlers. Returns the function that removes this exact handler.
   */
  register(id: CommandId, handler: CommandHandler): () => void;
  /**
   * Invokes the active handler for `id`.
   *
   * Rejects for an unknown command, and forwards any handler failure to the
   * caller so it reaches the application error path.
   */
  execute(id: CommandId): Promise<void>;
  /** Whether `id` currently has a handler. */
  has(id: CommandId): boolean;
}

/** Creates an empty registry for one application session. */
export function createCommandRegistry(): CommandRegistry {
  const handlers = new Map<CommandId, CommandHandler>();

  return {
    register(id: CommandId, handler: CommandHandler): () => void {
      if (handlers.has(id)) {
        throw new Error(`Command "${id}" is already registered.`);
      }

      handlers.set(id, handler);

      return () => {
        if (handlers.get(id) === handler) {
          handlers.delete(id);
        }
      };
    },

    async execute(id: CommandId): Promise<void> {
      const handler = handlers.get(id);
      if (handler === undefined) {
        throw new Error(`Command "${id}" is not registered.`);
      }

      await handler();
    },

    has(id: CommandId): boolean {
      return handlers.has(id);
    },
  };
}
