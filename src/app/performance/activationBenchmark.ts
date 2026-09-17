/**
 * SC-005 Tab-activation timing marks.
 *
 * Benchmark only: these marks measure Tab switching and change no behaviour. The
 * measured interval is exactly the success criterion's definition — from the
 * Tab-selection event to the first animation frame after the target editor state
 * is bound to the shared view and the editor is focused. Time the user spends
 * between two selections is not part of it.
 *
 * Only *user* Tab selections are measured. Opening a file, creating a document
 * and handling a dropped path activate documents too, but those are not the
 * interaction SC-005 describes.
 */

import type { DocumentId } from "../document/documentSession";

/** One activation measurement. */
export interface ActivationMeasurement {
  documentId: DocumentId;
  durationMillis: number;
}

/** The SC-005 verdict derived from a set of measurements. */
export interface ActivationSummary {
  count: number;
  slowestMillis: number | null;
  medianFirst10: number | null;
  medianFinal10: number | null;
  driftRatio: number | null;
  /** Every activation was within the per-activation budget. */
  withinBudget: boolean;
  /** The final ten activations were not more than 25% slower than the first ten. */
  withinDrift: boolean;
}

/** SC-005: every one of the 40 activations must be within this many milliseconds. */
export const SC005_MAX_ACTIVATION_MILLIS = 500;
/** SC-005: `medianFinal10 / medianFirst10` must not exceed this ratio. */
export const SC005_MAX_DRIFT_RATIO = 1.25;

/** The recorder `DocumentManager.selectDocument` drives. */
export interface ActivationBenchmark {
  /** Records the moment the user selected a Tab. */
  begin(documentId: DocumentId): void;
  /** Records that the target state is bound and focused; the interval closes on the next frame. */
  complete(): void;
  /** The measurements taken so far, in activation order. */
  results(): readonly ActivationMeasurement[];
  /** Computes (and logs) the SC-005 verdict. */
  summarize(): ActivationSummary;
  /** Discards every measurement, for a cycle that has to be repeated. */
  reset(): void;
}

/** The time and frame sources the benchmark needs, injectable for tests. */
export interface ActivationBenchmarkClock {
  now(): number;
  requestFrame(callback: () => void): void;
}

function defaultClock(): ActivationBenchmarkClock {
  return {
    now: () => performance.now(),
    requestFrame: (callback) => {
      requestAnimationFrame(() => {
        callback();
      });
    },
  };
}

/**
 * The median of `values`.
 *
 * An even count averages the two central values, which is what the SC-005
 * ten-value medians expect.
 */
export function median(values: readonly number[]): number | null {
  if (values.length === 0) {
    return null;
  }

  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);

  if (sorted.length % 2 === 1) {
    return sorted[middle];
  }

  return (sorted[middle - 1] + sorted[middle]) / 2;
}

/** Compares a measurement set against SC-005. */
export function summarizeActivationMeasurements(
  measurements: readonly ActivationMeasurement[],
): ActivationSummary {
  const durations = measurements.map((entry) => entry.durationMillis);
  const medianFirst10 = median(durations.slice(0, 10));
  // "The final five cycles" are the last ten of the forty measurements.
  const medianFinal10 = median(durations.slice(-10));

  const driftRatio =
    medianFirst10 === null || medianFinal10 === null || medianFirst10 <= 0
      ? null
      : medianFinal10 / medianFirst10;

  return {
    count: durations.length,
    slowestMillis: durations.length === 0 ? null : Math.max(...durations),
    medianFirst10,
    medianFinal10,
    driftRatio,
    withinBudget:
      durations.length > 0 &&
      durations.every((value) => value <= SC005_MAX_ACTIVATION_MILLIS),
    withinDrift: driftRatio !== null && driftRatio <= SC005_MAX_DRIFT_RATIO,
  };
}

/** Creates the process-wide activation recorder. */
export function createActivationBenchmark(
  clock: ActivationBenchmarkClock = defaultClock(),
  log: (message: string) => void = (message) => {
    console.log(message);
  },
): ActivationBenchmark {
  const measurements: ActivationMeasurement[] = [];

  /**
   * The selection currently being measured. A new selection replaces it, which
   * is how an interrupted activation ends up recording nothing at all rather
   * than a duration that spans two different Tabs.
   */
  let pending: { documentId: DocumentId; startedAt: number } | null = null;

  const format = (value: number | null): string =>
    value === null ? "n/a" : value.toFixed(2);

  return {
    begin(documentId: DocumentId): void {
      pending = { documentId, startedAt: clock.now() };
    },

    complete(): void {
      const current = pending;
      if (current === null) {
        return;
      }

      clock.requestFrame(() => {
        if (pending !== current) {
          // Superseded before the frame arrived: nothing is recorded.
          return;
        }
        pending = null;

        const durationMillis = clock.now() - current.startedAt;
        measurements.push({ documentId: current.documentId, durationMillis });
        log(
          `[sorakada-benchmark] activation ${current.documentId} ${durationMillis.toFixed(2)} ms`,
        );
      });
    },

    results(): readonly ActivationMeasurement[] {
      return [...measurements];
    },

    summarize(): ActivationSummary {
      const summary = summarizeActivationMeasurements(measurements);
      log(
        `[sorakada-benchmark] summary count=${summary.count}` +
          ` slowest=${format(summary.slowestMillis)}` +
          ` medianFirst10=${format(summary.medianFirst10)}` +
          ` medianFinal10=${format(summary.medianFinal10)}` +
          ` drift=${format(summary.driftRatio)}`,
      );
      return summary;
    },

    reset(): void {
      measurements.length = 0;
      pending = null;
    },
  };
}

declare global {
  interface Window {
    /** Benchmark-only namespace; see `specs/002-multi-document-tabs/quickstart.md` §12. */
    sorakada?: { benchmark?: ActivationBenchmark };
  }
}

/**
 * Publishes the benchmark on `window.sorakada.benchmark` so the measurements can
 * be read from the webview console after a manual switching run.
 */
export function installActivationBenchmark(
  benchmark: ActivationBenchmark,
  target: Window = window,
): ActivationBenchmark {
  target.sorakada = { ...target.sorakada, benchmark };
  return benchmark;
}
