import type { DocumentId } from "../document/documentSession";
import type {
  OpenPathOptions,
  OpenPathResult,
} from "../document/documentManager";
import type {
  ExternalOpenRequest,
  ExternalOpenService,
} from "../../services/externalOpen";

/** The part of DocumentManager external-open consumption needs. */
export interface ExternalOpenDocumentManager {
  openPath(path: string, options?: OpenPathOptions): Promise<OpenPathResult>;
  activateDocument(id: DocumentId): void;
}

export interface ExternalOpenConsumerDeps {
  service: ExternalOpenService;
  documents: ExternalOpenDocumentManager;
  isBlocked(): boolean;
  onError(error: unknown): void;
}

/**
 * Single serial consumer for application-level external-open batches.
 *
 * The listener is installed before the first peek. Events wake this one pump
 * but never carry the request itself. A stopped consumer retains the current
 * request and per-path progress so a StrictMode effect restart resumes instead
 * of replaying files.
 */
export class ExternalOpenConsumer {
  private active = false;
  private listenerReady = false;
  private lifecycle = 0;
  private startTask: Promise<void> | null = null;
  private unlisten: (() => void) | null = null;

  private pumping = false;
  private wakeRequested = false;

  private request: ExternalOpenRequest | null = null;
  private nextPathIndex = 0;
  private lastHandledDocumentId: DocumentId | null = null;
  private activationAttempted = false;
  private lastDocumentActivated = false;

  constructor(private readonly deps: ExternalOpenConsumerDeps) {}

  /** Installs the wake listener, then performs the initial authoritative peek. */
  start(): Promise<void> {
    if (this.active) {
      return this.startTask ?? Promise.resolve();
    }

    this.active = true;
    this.listenerReady = false;
    this.wakeRequested = false;
    const lifecycle = ++this.lifecycle;

    const task = this.installListener(lifecycle);
    this.startTask = task;
    void task.finally(() => {
      if (this.startTask === task) {
        this.startTask = null;
      }
    });
    return task;
  }

  /**
   * Stops this lifecycle without discarding batch or progress state.
   *
   * A listener whose async installation finishes later sees the changed
   * lifecycle and disposes itself instead of becoming a stale active listener.
   */
  stop(): void {
    this.active = false;
    this.listenerReady = false;
    this.lifecycle += 1;
    this.startTask = null;
    this.wakeRequested = false;
    this.disposeCurrentListener();
  }

  /** Retries pending work after injected modal/original-operation state changes. */
  notifyCanProcess(): void {
    this.requestPump();
  }

  private async installListener(lifecycle: number): Promise<void> {
    try {
      const unlisten = await this.deps.service.listen(() => {
        if (this.isActiveLifecycle(lifecycle) && this.listenerReady) {
          this.requestPump();
        }
      });

      if (!this.isActiveLifecycle(lifecycle)) {
        this.disposeListener(unlisten);
        return;
      }

      this.unlisten = unlisten;
      this.listenerReady = true;
      this.requestPump();
    } catch (error) {
      if (!this.isActiveLifecycle(lifecycle)) {
        return;
      }

      this.report(error);
      this.active = false;
      this.listenerReady = false;
      this.lifecycle += 1;
    }
  }

  private isActiveLifecycle(lifecycle: number): boolean {
    return this.active && lifecycle === this.lifecycle;
  }

  private canPump(lifecycle: number): boolean {
    return (
      this.isActiveLifecycle(lifecycle) &&
      this.listenerReady
    );
  }

  private requestPump(): void {
    if (!this.active || !this.listenerReady) {
      return;
    }

    if (this.pumping) {
      this.wakeRequested = true;
      return;
    }

    void this.runPump();
  }

  private async runPump(): Promise<void> {
    if (this.pumping) {
      this.wakeRequested = true;
      return;
    }

    this.pumping = true;
    const lifecycle = this.lifecycle;

    try {
      await this.pump(lifecycle);
    } catch (error) {
      this.report(error);
    } finally {
      const rerun = this.wakeRequested;
      this.pumping = false;

      if (rerun && this.active && this.listenerReady) {
        this.wakeRequested = false;
        this.requestPump();
      }
    }
  }

  private async pump(lifecycle: number): Promise<void> {
    while (this.canPump(lifecycle)) {
      if (this.isBlocked()) {
        return;
      }

      if (this.request === null) {
        this.wakeRequested = false;
        let request: ExternalOpenRequest | null;
        try {
          request = await this.deps.service.peek();
        } catch (error) {
          this.report(error);
          return;
        }

        if (!this.canPump(lifecycle)) {
          return;
        }

        if (request === null) {
          if (this.wakeRequested) {
            continue;
          }
          return;
        }

        this.adoptRequest(request);
        continue;
      }

      if (!this.activationAttempted) {
        this.activationAttempted = true;
        this.wakeRequested = false;
        try {
          await this.deps.service.activate();
        } catch (error) {
          this.report(error);
        }
        continue;
      }

      if (this.nextPathIndex < this.request.paths.length) {
        const path = this.request.paths[this.nextPathIndex];
        this.wakeRequested = false;

        let result: OpenPathResult | null = null;
        try {
          result = await this.deps.documents.openPath(path, {
            ignoreDirectories: true,
          });
        } catch (error) {
          this.report(error);
        }

        // A completed open is progress even if stop() occurred while it was in
        // flight. The next lifecycle resumes at the following path.
        this.nextPathIndex += 1;
        if (
          result?.status === "opened" ||
          result?.status === "activated-existing"
        ) {
          this.lastHandledDocumentId = result.documentId;
        }
        continue;
      }

      if (!this.lastDocumentActivated) {
        this.lastDocumentActivated = true;
        if (this.lastHandledDocumentId !== null) {
          try {
            this.deps.documents.activateDocument(
              this.lastHandledDocumentId,
            );
          } catch (error) {
            this.report(error);
          }
        }
      }

      const requestId = this.request.id;
      this.wakeRequested = false;
      let acknowledged: boolean;
      try {
        acknowledged = await this.deps.service.ack(requestId);
      } catch (error) {
        // Keep the fully processed request as pending acknowledgement. A later
        // wake retries only the ack and never reopens these paths.
        this.report(error);
        return;
      }

      if (acknowledged) {
        this.clearRequest();
      } else {
        this.wakeRequested = false;
        let currentHead: ExternalOpenRequest | null;
        try {
          currentHead = await this.deps.service.peek();
        } catch (error) {
          // The acknowledgement remains uncertain, but re-queuing files would
          // duplicate work. Keep the processed request pending and wait for the
          // next legitimate wake to verify again.
          this.report(error);
          return;
        }

        if (!this.canPump(lifecycle)) {
          return;
        }

        if (currentHead === null) {
          this.clearRequest();
          if (this.wakeRequested) {
            continue;
          }
          return;
        }

        if (currentHead.id === requestId) {
          this.report(
            new Error(
              `external-open request ${requestId} is still the queue head after acknowledgement`,
            ),
          );
          return;
        }

        // A different head proves the old acknowledgement took effect even if
        // its first IPC response was lost. Adopt the already-observed new head
        // instead of peeking a third time.
        this.clearRequest();
        this.adoptRequest(currentHead);
        continue;
      }

      if (!this.canPump(lifecycle) || !acknowledged) {
        return;
      }
    }
  }

  private isBlocked(): boolean {
    try {
      return this.deps.isBlocked();
    } catch (error) {
      this.report(error);
      return true;
    }
  }

  private clearRequest(): void {
    this.request = null;
    this.nextPathIndex = 0;
    this.lastHandledDocumentId = null;
    this.activationAttempted = false;
    this.lastDocumentActivated = false;
  }

  private adoptRequest(request: ExternalOpenRequest): void {
    this.request = request;
    this.nextPathIndex = 0;
    this.lastHandledDocumentId = null;
    this.activationAttempted = false;
    this.lastDocumentActivated = false;
  }

  private disposeCurrentListener(): void {
    const unlisten = this.unlisten;
    this.unlisten = null;
    if (unlisten !== null) {
      this.disposeListener(unlisten);
    }
  }

  private disposeListener(unlisten: () => void): void {
    try {
      unlisten();
    } catch (error) {
      this.report(error);
    }
  }

  private report(error: unknown): void {
    try {
      this.deps.onError(error);
    } catch {
      // Error presentation must not interrupt queue bookkeeping.
    }
  }
}
