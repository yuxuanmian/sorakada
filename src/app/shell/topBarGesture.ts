/**
 * TopBar drag/gesture decisions (007 T036, T042, FR-006, FR-007).
 *
 * Two behaviours have to be provable without a DOM:
 *
 * - a pointer press on the *non-interactive* TopBar surface starts a native
 *   window move, while a press on App Menu / window controls / any other
 *   interactive descendant does not (FR-006);
 * - double-clicking that same non-interactive surface dispatches the canonical
 *   maximize/restore command **exactly once**, and never for an interactive
 *   descendant (FR-007).
 *
 * The decision is therefore a pure function over the event target's ability to
 * match a selector, which is all the gesture needs and all a test has to fake.
 */

/**
 * Marks an element and its subtree as interactive.
 *
 * The explicit attribute is what lets a non-button interactive region opt out of
 * both dragging and the double-click gesture, in addition to the native
 * interactive elements below.
 */
export const INTERACTIVE_SELECTOR =
  "[data-sora-interactive], button, input, select, textarea, a[href], [role='button'], [role='menuitem'], [role='tab']";

/** The minimal element surface the gesture has to ask about. */
export interface ClosestMatchable {
  closest(selector: string): unknown;
}

function asMatchable(target: unknown): ClosestMatchable | null {
  if (target === null || typeof target !== "object") {
    return null;
  }
  const candidate = target as { closest?: unknown };
  if (typeof candidate.closest !== "function") {
    return null;
  }
  return candidate as ClosestMatchable;
}

/**
 * Whether a gesture on `target` belongs to an interactive control.
 *
 * A target that cannot answer the question is treated as interactive: refusing a
 * drag is the safe answer, because starting one would swallow the user's click.
 */
export function isInteractiveTarget(target: unknown): boolean {
  const matchable = asMatchable(target);
  if (matchable === null) {
    return true;
  }
  return matchable.closest(INTERACTIVE_SELECTOR) !== null;
}

/** What a TopBar gesture does when it belongs to the window chrome. */
export interface TopBarGestureHandlers {
  /** Starts the native window move. */
  startDrag(): void;
  /** Dispatches the canonical maximize/restore command. */
  toggleMaximize(): void;
}

/**
 * Handles a pointer press on the TopBar surface.
 *
 * Returns whether a drag was started, which is what makes the "interactive
 * descendants never drag" rule directly assertable.
 */
export function requestTopBarDrag(
  target: unknown,
  handlers: TopBarGestureHandlers,
): boolean {
  if (isInteractiveTarget(target)) {
    return false;
  }
  handlers.startDrag();
  return true;
}

/**
 * Handles a double-click on the TopBar surface.
 *
 * Returns whether the maximize/restore command was dispatched. The gesture is
 * dispatched from the browser's single `dblclick` event, so one double-click
 * produces exactly one command.
 */
export function requestTopBarToggleMaximize(
  target: unknown,
  handlers: TopBarGestureHandlers,
): boolean {
  if (isInteractiveTarget(target)) {
    return false;
  }
  handlers.toggleMaximize();
  return true;
}
