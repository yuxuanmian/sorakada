import type { OperationErrorContext } from "../../services/errorContext";

export interface ExitCoordinatorDeps {
  hasDirtyDocuments(): boolean;
  prepareCloseAll(): Promise<boolean>;
  destroyWindow?(): Promise<void>;
  isModalActive?(): boolean;
  onError?(error: unknown, context?: OperationErrorContext): void;
}

export class ExitCoordinator {
  private inFlight: Promise<boolean> | null = null;
  private listeners = new Set<() => void>();

  constructor(private readonly deps: ExitCoordinatorDeps) {}

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getSnapshot = (): boolean => {
    return this.inFlight !== null;
  };

  /**
   * Coordinates application exit and window close requests.
   * - If an exit request is already in-flight, joins the existing Promise without creating another chain.
   * - If an unrelated modal Dialog is active, ignores the exit request safely.
   * - Destroys window only if prepareCloseAll approves.
   */
  requestExit(): Promise<boolean> {
    if (this.inFlight !== null) {
      return this.inFlight;
    }

    if (this.deps.isModalActive?.()) {
      return Promise.resolve(false);
    }

    let resolvePromise!: (value: boolean) => void;
    const exitPromise = new Promise<boolean>((resolve) => {
      resolvePromise = resolve;
    });

    this.inFlight = exitPromise;
    this.notify();

    (async () => {
      try {
        let approved = false;
        try {
          if (!this.deps.hasDirtyDocuments()) {
            approved = true;
          } else {
            approved = await this.deps.prepareCloseAll();
          }
        } catch (error) {
          this.deps.onError?.(error, {
            operation: "window",
            code: "exit_guard_failed",
          });
          resolvePromise(false);
          return;
        }

        if (approved) {
          if (this.deps.destroyWindow) {
            try {
              await this.deps.destroyWindow();
            } catch (error) {
              this.deps.onError?.(error, {
                operation: "window",
                code: "destroy_failed",
              });
              resolvePromise(false);
              return;
            }
          }
          resolvePromise(true);
          return;
        }

        resolvePromise(false);
      } finally {
        this.inFlight = null;
        this.notify();
      }
    })();

    return exitPromise;
  }

  isExiting(): boolean {
    return this.inFlight !== null;
  }

  private notify(): void {
    for (const listener of this.listeners) {
      listener();
    }
  }
}
