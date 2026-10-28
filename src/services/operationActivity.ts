/**
 * Small nested operation counter for external-open blocking.
 *
 * It marks user operations that may present a dialog or must retain ownership
 * until their post-dialog work settles. Ordinary save I/O does not acquire it.
 */
export interface OperationActivity {
  getSnapshot(): number;
  isActive(): boolean;
  subscribe(listener: () => void): () => void;
  begin(): () => void;
  run<T>(operation: () => T | Promise<T>): Promise<T>;
}

export class OperationActivityCounter implements OperationActivity {
  private count = 0;
  private readonly listeners = new Set<() => void>();

  getSnapshot = (): number => this.count;
  isActive = (): boolean => this.count > 0;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  begin = (): (() => void) => {
    this.count += 1;
    this.notify();
    let released = false;

    return () => {
      if (released) {
        return;
      }
      released = true;
      this.count -= 1;
      this.notify();
    };
  };

  async run<T>(operation: () => T | Promise<T>): Promise<T> {
    const release = this.begin();
    try {
      return await operation();
    } finally {
      release();
    }
  }

  private notify(): void {
    for (const listener of this.listeners) {
      listener();
    }
  }
}

export const appOperationActivity = new OperationActivityCounter();
