export interface DialogValidity { isValid(): boolean }
export interface DialogButton { value: string; label(): string; dangerous?: boolean }
export interface DialogRequest {
  title(): string;
  message(): string;
  buttons: readonly DialogButton[];
  cancelValue: string;
  validity?: DialogValidity;
}
export interface ActiveDialog extends DialogRequest {
  id: number;
  returnFocus: HTMLElement | null;
}
interface Pending extends ActiveDialog { resolve(value: string): void }

/** Owns decisions only. Document and filesystem state remain with their existing owners. */
export class DialogManager {
  private active: Pending | null = null;
  private queue: Pending[] = [];
  private listeners = new Set<() => void>();
  private hosts = 0;
  private sequence = 0;

  getSnapshot = (): ActiveDialog | null => this.active;
  isActive = (): boolean => this.active !== null || this.queue.length > 0;
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  attach(): () => void {
    this.hosts++;
    let attached = true;
    return () => {
      if (!attached) return;
      attached = false;
      if (--this.hosts === 0) this.cancelAll();
    };
  }

  request(request: DialogRequest): Promise<string> {
    if (this.hosts === 0 || this.queue.length >= 64 || !this.valid(request)) {
      return Promise.resolve(request.cancelValue);
    }
    const focused =
      typeof document !== "undefined" &&
      document.activeElement instanceof HTMLElement &&
      document.activeElement !== document.body &&
      !document.activeElement.closest?.(".sora-dialog")
        ? document.activeElement
        : null;

    return new Promise(resolve => {
      this.queue.push({
        ...request,
        id: ++this.sequence,
        returnFocus: this.active?.returnFocus ?? focused,
        resolve,
      });
      this.advance();
    });
  }

  choose(id: number, value: string): void {
    if (this.active?.id !== id) return;
    const pending = this.active;
    const allowed = pending.buttons.some(b => b.value === value);
    this.active = null;
    this.publish();
    pending.resolve(allowed && this.valid(pending) ? value : pending.cancelValue);
    queueMicrotask(() => {
      this.advance();
    });
  }

  cancel(): void {
    if (this.active) this.choose(this.active.id, this.active.cancelValue);
  }

  cancelAll(): void {
    const all = this.active ? [this.active, ...this.queue] : [...this.queue];
    this.active = null;
    this.queue = [];
    for (const request of all) {
      request.resolve(request.cancelValue);
    }
    this.publish();
  }

  private valid(request: DialogRequest): boolean {
    try {
      return request.validity?.isValid() ?? true;
    } catch {
      return false;
    }
  }

  private advance(): void {
    while (!this.active && this.queue.length) {
      const next = this.queue.shift()!;
      if (this.valid(next)) {
        this.active = next;
      } else {
        next.resolve(next.cancelValue);
      }
    }
    this.publish();
  }

  private publish(): void {
    for (const listener of this.listeners) listener();
  }
}
export const dialogManager = new DialogManager();
