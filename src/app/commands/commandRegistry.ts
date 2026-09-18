import type { CommandId } from "./commandIds";

/** A bound application action; may be asynchronous. */
export type CommandHandler = () => void | Promise<void>;

/**
 * One command's behaviour plus its availability.
 *
 * `isEnabled` is optional and defaults to "available", so a command that can
 * always run does not have to spell that out. Commands whose validity depends on
 * state — an active document, an active Workspace, a selected Explorer entry —
 * express it here instead of duplicating checks in every surface.
 */
export interface CommandRegistration {
  /** Runs the command. Only called while the command is enabled. */
  execute: CommandHandler;
  /**
   * Whether the command may run right now.
   *
   * Called at execution time and by every UI surface, so menu state and
   * shortcut behaviour cannot disagree.
   */
  isEnabled?(): boolean;
}

/**
 * The single dispatch point for application commands.
 *
 * Surfaces (native menu items, accelerators, Explorer context menu and the
 * Explorer-local key handler) all go through `execute`, which guarantees one
 * command invocation produces exactly one handler call — or none at all when the
 * command is disabled.
 */
export interface CommandRegistry {
  /**
   * Binds `registration` to `id`.
   *
   * Registering the same ID twice throws rather than silently stacking
   * handlers. Returns the function that removes this exact registration.
   */
  register(id: CommandId, registration: CommandRegistration): () => void;
  /**
   * Invokes the active handler for `id`.
   *
   * Rejects for an unknown command, and forwards any handler failure to the
   * caller so it reaches the application error path. A command that is
   * registered but currently disabled resolves without calling its handler and
   * without throwing.
   */
  execute(id: CommandId): Promise<void>;
  /**
   * Whether `id` is currently available.
   *
   * An unregistered command is never available, so a surface can ask this
   * without first checking `has`.
   */
  isEnabled(id: CommandId): boolean;
  /** Whether `id` currently has a registration. */
  has(id: CommandId): boolean;
}

/** Creates an empty registry for one application session. */
export function createCommandRegistry(): CommandRegistry {
  const registrations = new Map<CommandId, CommandRegistration>();

  const isEnabled = (id: CommandId): boolean => {
    const registration = registrations.get(id);
    if (registration === undefined) {
      return false;
    }
    // A missing predicate means the command has no disabled state.
    return registration.isEnabled?.() ?? true;
  };

  return {
    register(id: CommandId, registration: CommandRegistration): () => void {
      if (registrations.has(id)) {
        throw new Error(`Command "${id}" is already registered.`);
      }

      registrations.set(id, registration);

      return () => {
        if (registrations.get(id) === registration) {
          registrations.delete(id);
        }
      };
    },

    async execute(id: CommandId): Promise<void> {
      const registration = registrations.get(id);
      if (registration === undefined) {
        throw new Error(`Command "${id}" is not registered.`);
      }

      // Availability is re-read here, at execution time, so a stale menu item or
      // a shortcut for a command that just became invalid cannot run it.
      if (!isEnabled(id)) {
        return;
      }

      await registration.execute();
    },

    isEnabled,

    has(id: CommandId): boolean {
      return registrations.has(id);
    },
  };
}
