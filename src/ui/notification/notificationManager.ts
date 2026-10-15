import type { OperationErrorContext } from "../../services/errorContext";

export type NotificationLevel = "info" | "success" | "warning" | "error";
export const NOTIFICATION_LIMITS = {
  entries: 12,
  visible: 3,
  details: 8,
  diagnosticChars: 2048,
  contextChars: 512,
  cooldownRecords: 64,
  watermarkRecords: 64,
  cooldownMs: 5000,
  aggregateMs: 1200,
  durationMs: 5000,
} as const;

export interface NotificationDetail {
  identity: string;
  docIdentity?: string;
  pathIdentity?: string;
  cause: string;
  context: OperationErrorContext;
  raw: string;
  truncated: boolean;
  occurrences: number;
}

export interface NotificationEntry {
  id: number;
  level: NotificationLevel;
  message?: string;
  operation: OperationErrorContext["operation"];
  group: string;
  critical: boolean;
  details: readonly NotificationDetail[];
  occurrences: number;
  repeats: number;
  omitted: number;
  updatedAt: number;
  remainingMs: number;
}

export interface NotificationSnapshot {
  entries: readonly NotificationEntry[];
  omittedEntries: number;
}

interface DismissCooldownRecord {
  operation: OperationErrorContext["operation"];
  identity: string;
  docIdentity?: string;
  pathIdentity?: string;
  cause: string;
  generation?: number;
  expiresAt: number;
}

/** Fixed-size identity for transient records; the full diagnostic is never a map key. */
function fingerprint(value: string): string {
  let a = 2166136261;
  let b = 5381;
  for (let i = 0; i < value.length; i++) {
    a = Math.imul(a ^ value.charCodeAt(i), 16777619);
    b = Math.imul(b, 33) ^ value.charCodeAt(i);
  }
  return `${value.length}:${a >>> 0}:${b >>> 0}`;
}

/**
 * Distinguishes different target paths for the same document (e.g. Save As to path B vs path C).
 * Repeated attempts on the same document and same target path still deduplicate.
 */
function targetIdentity(context: OperationErrorContext): {
  primary: string | null;
  docIdentity?: string;
  pathIdentity?: string;
} {
  const docIdentity = context.documentId ? `doc:${fingerprint(context.documentId)}` : undefined;
  const pathIdentity = context.path ? `path:${fingerprint(context.path)}` : undefined;

  let primary: string | null = null;
  if (docIdentity && pathIdentity) {
    primary = `${docIdentity}:${pathIdentity}`;
  } else if (docIdentity) {
    primary = docIdentity;
  } else if (pathIdentity) {
    primary = pathIdentity;
  }

  return { primary, docIdentity, pathIdentity };
}

function matchesResolve(
  item: {
    operation: OperationErrorContext["operation"];
    docIdentity?: string;
    pathIdentity?: string;
  },
  context: OperationErrorContext
): boolean {
  if (item.operation !== context.operation) return false;

  const expectedDoc = context.documentId ? `doc:${fingerprint(context.documentId)}` : undefined;
  const expectedPath = context.path ? `path:${fingerprint(context.path)}` : undefined;

  if (expectedDoc && expectedPath) {
    return item.docIdentity === expectedDoc && item.pathIdentity === expectedPath;
  }
  if (expectedPath) {
    return item.pathIdentity === expectedPath;
  }
  if (expectedDoc) {
    if (item.operation === "saveAs" && item.pathIdentity) {
      return false;
    }
    return item.docIdentity === expectedDoc;
  }

  return false;
}

const count = (n: number, delta = 1): number => Math.min(Number.MAX_SAFE_INTEGER, n + delta);

export class NotificationManager {
  private entries: NotificationEntry[] = [];
  private cooldowns = new Map<string, DismissCooldownRecord>();
  private resolvedWatermarks = new Map<string, number>();
  private listeners = new Set<() => void>();
  private nextId = 1;
  private omittedEntries = 0;
  private snapshot: NotificationSnapshot = { entries: [], omittedEntries: 0 };

  constructor(private readonly now: () => number = Date.now) {}

  getSnapshot = (): NotificationSnapshot => this.snapshot;
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };
  visible(): readonly NotificationEntry[] {
    return this.snapshot.entries.slice(0, NOTIFICATION_LIMITS.visible);
  }

  /** Ordinary errors register synchronously; closing a Toast is never an awaited decision. */
  report(raw: string, context: OperationErrorContext = { operation: "unknown" }): void {
    const now = this.now();
    this.pruneCooldown(now);

    const { primary: target, docIdentity, pathIdentity } = targetIdentity(context);

    // Drop late-arriving older failures if a newer generation has already succeeded
    if (target && context.generation !== undefined) {
      const watermarkKey = `${target}:${context.operation}`;
      const watermark = this.resolvedWatermarks.get(watermarkKey);
      if (watermark !== undefined && context.generation <= watermark) {
        return;
      }
    }

    const cause = fingerprint(`${context.operation}\0${context.code ?? ""}\0${raw}`);
    const cooldownKey = `${target ?? "anonymous"}:${cause}`;
    const cooldownRecord = this.cooldowns.get(cooldownKey);
    if (target && cooldownRecord && cooldownRecord.expiresAt > now) {
      return;
    }

    const critical = context.critical ?? (context.operation === "save" || context.operation === "saveAs");
    const group = context.batchId ? `batch:${fingerprint(context.batchId)}:${cause}` : cause;

    let entry = target
      ? this.entries.find(
          e =>
            e.level === "error" &&
            e.group === group &&
            (e.details.some(d => d.identity === target && d.cause === cause) ||
              !!context.batchId ||
              now - e.updatedAt <= NOTIFICATION_LIMITS.aggregateMs)
        )
      : undefined;

    if (!entry) {
      entry = {
        id: this.nextId++,
        level: "error",
        operation: context.operation,
        group,
        critical,
        details: [],
        occurrences: 0,
        repeats: 0,
        omitted: 0,
        updatedAt: now,
        remainingMs: NOTIFICATION_LIMITS.durationMs,
      };
      this.entries.push(entry);
    }

    const existing = entry.details.find(d => d.identity === target && d.cause === cause);
    const clipped = (s: string | undefined) => s?.slice(0, NOTIFICATION_LIMITS.contextChars);
    const isTruncated =
      raw.length > NOTIFICATION_LIMITS.diagnosticChars ||
      (context.path?.length ?? 0) > NOTIFICATION_LIMITS.contextChars ||
      (context.documentId?.length ?? 0) > NOTIFICATION_LIMITS.contextChars ||
      (context.code?.length ?? 0) > NOTIFICATION_LIMITS.contextChars;

    const detail: NotificationDetail = {
      identity: target ?? `anonymous:${entry.id}`,
      docIdentity,
      pathIdentity,
      cause,
      context: {
        ...context,
        path: clipped(context.path),
        documentId: clipped(context.documentId),
        code: clipped(context.code),
        batchId: undefined,
      },
      raw: raw.slice(0, NOTIFICATION_LIMITS.diagnosticChars),
      truncated: isTruncated,
      occurrences: existing ? count(existing.occurrences) : 1,
    };

    if (existing) {
      if ((existing.context.generation ?? -1) > (context.generation ?? -1)) {
        detail.context.generation = existing.context.generation;
      }
      entry.repeats = count(entry.repeats);
    }

    let details = entry.details.filter(d => d !== existing);
    if (details.length >= NOTIFICATION_LIMITS.details) {
      entry.omitted = count(entry.omitted, details[0].occurrences);
      details = details.slice(1);
    }

    entry.details = [...details, detail];
    entry.occurrences = count(entry.occurrences);
    entry.critical ||= critical;
    entry.updatedAt = now;
    entry.remainingMs = NOTIFICATION_LIMITS.durationMs;
    this.boundEntries();
    this.publish();
  }

  notify(level: Exclude<NotificationLevel, "error">, message: string): void {
    this.entries.push({
      id: this.nextId++,
      level,
      message: message.slice(0, NOTIFICATION_LIMITS.diagnosticChars),
      operation: "unknown",
      group: "",
      critical: false,
      details: [],
      occurrences: 1,
      repeats: 0,
      omitted: 0,
      updatedAt: this.now(),
      remainingMs: NOTIFICATION_LIMITS.durationMs,
    });
    this.boundEntries();
    this.publish();
  }

  /**
   * Resolves errors for the matching operation and target through the given generation.
   * Clears matching dismiss cooldowns even if the notification was already dismissed.
   * Does NOT clear newer failures. Records a bounded watermark to prevent older failures
   * from overwriting this success if they finish late.
   */
  resolve(context: OperationErrorContext): void {
    const { primary: target } = targetIdentity(context);

    // Update watermark for this target and operation
    if (target && context.generation !== undefined) {
      const watermarkKey = `${target}:${context.operation}`;
      const prev = this.resolvedWatermarks.get(watermarkKey) ?? -1;
      this.resolvedWatermarks.set(watermarkKey, Math.max(prev, context.generation));
      while (this.resolvedWatermarks.size > NOTIFICATION_LIMITS.watermarkRecords) {
        this.resolvedWatermarks.delete(this.resolvedWatermarks.keys().next().value!);
      }
    }

    for (const entry of this.entries) {
      if (entry.level !== "error") continue;

      const removed = entry.details.filter(
        d =>
          matchesResolve(
            { operation: d.context.operation, docIdentity: d.docIdentity, pathIdentity: d.pathIdentity },
            context
          ) &&
          (context.generation === undefined || (d.context.generation ?? -1) <= context.generation)
      );

      if (removed.length > 0) {
        const removedOccurrences = removed.reduce((n, d) => n + d.occurrences, 0);
        const removedRepeats = removed.reduce((n, d) => n + Math.max(0, d.occurrences - 1), 0);
        entry.details = entry.details.filter(d => !removed.includes(d));
        entry.occurrences = Math.max(0, entry.occurrences - removedOccurrences);
        entry.repeats = Math.max(0, entry.repeats - removedRepeats);
        if (entry.occurrences <= 1) {
          entry.repeats = 0;
        } else if (entry.repeats >= entry.occurrences) {
          entry.repeats = Math.max(0, entry.occurrences - entry.details.length);
        }
      }
    }

    this.entries = this.entries.filter(e => e.level !== "error" || e.details.length > 0 || e.omitted > 0);

    // Targeted cooldown removal: does not depend on entry still existing in this.entries
    for (const [key, record] of Array.from(this.cooldowns.entries())) {
      if (
        matchesResolve(
          { operation: record.operation, docIdentity: record.docIdentity, pathIdentity: record.pathIdentity },
          context
        ) &&
        (context.generation === undefined || (record.generation ?? -1) <= context.generation)
      ) {
        this.cooldowns.delete(key);
      }
    }

    this.publish();
  }

  dismiss(id: number): void {
    const entry = this.entries.find(e => e.id === id);
    if (!entry) return;
    const now = this.now();
    this.pruneCooldown(now);

    for (const d of entry.details) {
      const key = `${d.identity}:${d.cause}`;
      this.cooldowns.set(key, {
        operation: d.context.operation,
        identity: d.identity,
        docIdentity: d.docIdentity,
        pathIdentity: d.pathIdentity,
        cause: d.cause,
        generation: d.context.generation,
        expiresAt: now + NOTIFICATION_LIMITS.cooldownMs,
      });
    }

    while (this.cooldowns.size > NOTIFICATION_LIMITS.cooldownRecords) {
      this.cooldowns.delete(this.cooldowns.keys().next().value!);
    }

    this.entries = this.entries.filter(e => e.id !== id);
    this.publish();
  }

  elapse(ms: number, paused: ReadonlySet<number>): void {
    const visible = new Set(this.visible().map(e => e.id));
    for (const entry of this.entries) {
      if (!entry.critical && visible.has(entry.id) && !paused.has(entry.id)) {
        entry.remainingMs -= Math.max(0, ms);
      }
    }
    const expired = this.entries.filter(e => !e.critical && e.remainingMs <= 0);
    if (expired.length) {
      this.entries = this.entries.filter(e => !expired.includes(e));
      this.publish();
    }
  }

  diagnostics(): { entries: number; cooldown: number; details: number; watermarks: number } {
    return {
      entries: this.entries.length,
      cooldown: this.cooldowns.size,
      details: this.entries.reduce((n, e) => n + e.details.length, 0),
      watermarks: this.resolvedWatermarks.size,
    };
  }

  private pruneCooldown(now: number): void {
    for (const [key, record] of this.cooldowns) {
      if (record.expiresAt <= now) this.cooldowns.delete(key);
    }
  }

  private boundEntries(): void {
    while (this.entries.length > NOTIFICATION_LIMITS.entries) {
      const oldest = this.entries.reduce((a, b) => (a.updatedAt <= b.updatedAt ? a : b));
      this.omittedEntries = count(this.omittedEntries, oldest.occurrences);
      this.entries = this.entries.filter(e => e !== oldest);
    }
  }

  private publish(): void {
    this.snapshot = {
      entries: this.entries
        .map(e => ({ ...e, details: [...e.details] }))
        .sort(
          (a, b) =>
            Number(b.critical) - Number(a.critical) ||
            b.updatedAt - a.updatedAt ||
            b.id - a.id
        ),
      omittedEntries: this.omittedEntries,
    };
    for (const listener of this.listeners) listener();
  }
}
export const notificationManager = new NotificationManager();
