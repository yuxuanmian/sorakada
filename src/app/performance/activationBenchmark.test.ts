import { describe, expect, it } from "vitest";

import {
  SC005_MAX_ACTIVATION_MILLIS,
  SC005_MAX_DRIFT_RATIO,
  createActivationBenchmark,
  median,
  summarizeActivationMeasurements,
  type ActivationBenchmarkClock,
  type ActivationMeasurement,
} from "./activationBenchmark";

/* -------------------------------------------------------------------------- */
/* Test double                                                                */
/* -------------------------------------------------------------------------- */

/** A clock whose frames only run when the test says so. */
class FakeClock implements ActivationBenchmarkClock {
  private time = 0;
  private frames: Array<() => void> = [];

  now(): number {
    return this.time;
  }

  requestFrame(callback: () => void): void {
    this.frames.push(callback);
  }

  advance(millis: number): void {
    this.time += millis;
  }

  /** Runs the oldest pending frame. */
  runFrame(): void {
    this.frames.shift()?.();
  }

  pendingFrames(): number {
    return this.frames.length;
  }
}

function createBenchmark() {
  const clock = new FakeClock();
  const lines: string[] = [];
  const benchmark = createActivationBenchmark(clock, (message) => {
    lines.push(message);
  });
  return { clock, lines, benchmark };
}

function measurements(
  first: readonly number[],
  middle: readonly number[],
  final: readonly number[],
): ActivationMeasurement[] {
  const all = [...first, ...middle, ...final];
  return all.map((durationMillis, index) => ({
    documentId: `doc-${index + 1}`,
    durationMillis,
  }));
}

/* -------------------------------------------------------------------------- */
/* Measurement interval                                                       */
/* -------------------------------------------------------------------------- */

describe("createActivationBenchmark", () => {
  it("closes the interval on the frame after the state is bound", () => {
    const { clock, benchmark } = createBenchmark();

    benchmark.begin("doc-1");
    clock.advance(10);
    // The target state is bound and the editor focused at t=10.
    benchmark.complete();
    clock.advance(5);
    // The first animation frame arrives at t=15.
    clock.runFrame();

    expect(benchmark.results()).toEqual([
      { documentId: "doc-1", durationMillis: 15 },
    ]);
  });

  it("does not record at activation time", () => {
    const { clock, benchmark } = createBenchmark();

    benchmark.begin("doc-1");
    clock.advance(10);
    benchmark.complete();

    expect(benchmark.results()).toEqual([]);
    expect(clock.pendingFrames()).toBe(1);
  });

  it("records nothing for an activation superseded before its frame", () => {
    const { clock, benchmark } = createBenchmark();

    benchmark.begin("doc-1");
    benchmark.complete();
    clock.advance(2);

    // A second selection arrives before the first frame ran.
    benchmark.begin("doc-2");
    clock.runFrame();

    expect(benchmark.results()).toEqual([]);

    clock.advance(3);
    benchmark.complete();
    clock.runFrame();

    // Measured from doc-2's own selection at t=2 to its frame at t=5.
    expect(benchmark.results()).toEqual([
      { documentId: "doc-2", durationMillis: 3 },
    ]);
  });

  it("ignores a completion that was never started", () => {
    const { clock, benchmark } = createBenchmark();

    benchmark.complete();
    clock.runFrame();

    expect(benchmark.results()).toEqual([]);
  });

  it("keeps the measurements in activation order", () => {
    const { clock, benchmark } = createBenchmark();

    for (const id of ["doc-a", "doc-b", "doc-c"]) {
      benchmark.begin(id);
      clock.advance(1);
      benchmark.complete();
      clock.runFrame();
    }

    expect(benchmark.results().map((entry) => entry.documentId)).toEqual([
      "doc-a",
      "doc-b",
      "doc-c",
    ]);
  });

  it("logs one line per activation and a summary line", () => {
    const { clock, lines, benchmark } = createBenchmark();

    benchmark.begin("doc-2");
    clock.advance(43.1);
    benchmark.complete();
    clock.runFrame();

    expect(lines[0]).toBe("[sorakada-benchmark] activation doc-2 43.10 ms");

    benchmark.summarize();
    expect(lines[1]).toContain("[sorakada-benchmark] summary count=1");
    expect(lines[1]).toContain("medianFirst10=43.10");
  });

  it("clears every recorded measurement on reset", () => {
    const { clock, benchmark } = createBenchmark();

    benchmark.begin("doc-1");
    benchmark.complete();
    clock.runFrame();
    expect(benchmark.results()).toHaveLength(1);

    benchmark.reset();

    expect(benchmark.results()).toEqual([]);
    expect(benchmark.summarize().count).toBe(0);
  });
});

/* -------------------------------------------------------------------------- */
/* SC-005 arithmetic                                                          */
/* -------------------------------------------------------------------------- */

describe("median", () => {
  it("returns null for no values", () => {
    expect(median([])).toBeNull();
  });

  it("returns the middle value for an odd count", () => {
    expect(median([3, 1, 2])).toBe(2);
  });

  it("averages the two central values for an even count", () => {
    expect(median([1, 2, 3, 4])).toBe(2.5);
    expect(median([10, 10, 12, 12])).toBe(11);
  });

  it("does not mutate the input order", () => {
    const values = [5, 1, 3];
    median(values);
    expect(values).toEqual([5, 1, 3]);
  });
});

describe("summarizeActivationMeasurements", () => {
  it("compares the first ten and the final ten measurements", () => {
    const summary = summarizeActivationMeasurements(
      measurements(
        [10, 10, 10, 10, 10, 10, 10, 10, 10, 10],
        Array.from({ length: 20 }, () => 10),
        [11, 11, 11, 11, 11, 11, 11, 11, 11, 11],
      ),
    );

    expect(summary.count).toBe(40);
    expect(summary.slowestMillis).toBe(11);
    expect(summary.medianFirst10).toBe(10);
    expect(summary.medianFinal10).toBe(11);
    expect(summary.driftRatio).toBeCloseTo(1.1);
    expect(summary.withinBudget).toBe(true);
    expect(summary.withinDrift).toBe(true);
  });

  it("fails the budget when one activation exceeds 500 ms", () => {
    const summary = summarizeActivationMeasurements(
      measurements(
        [10, 10, 10, 10, 10, 10, 10, 10, 10, SC005_MAX_ACTIVATION_MILLIS + 1],
        [],
        [],
      ),
    );

    expect(summary.withinBudget).toBe(false);
    expect(summary.slowestMillis).toBe(501);
  });

  it("fails the drift check when the final ten are more than 25% slower", () => {
    const summary = summarizeActivationMeasurements(
      measurements(
        [10, 10, 10, 10, 10, 10, 10, 10, 10, 10],
        [],
        [13, 13, 13, 13, 13, 13, 13, 13, 13, 13],
      ),
    );

    expect(summary.driftRatio).toBeCloseTo(1.3);
    expect(summary.driftRatio!).toBeGreaterThan(SC005_MAX_DRIFT_RATIO);
    expect(summary.withinDrift).toBe(false);
  });

  it("passes the drift check exactly at the limit", () => {
    const summary = summarizeActivationMeasurements(
      measurements(
        [10, 10, 10, 10, 10, 10, 10, 10, 10, 10],
        [],
        [12.5, 12.5, 12.5, 12.5, 12.5, 12.5, 12.5, 12.5, 12.5, 12.5],
      ),
    );

    expect(summary.driftRatio).toBeCloseTo(SC005_MAX_DRIFT_RATIO);
    expect(summary.withinDrift).toBe(true);
  });

  it("reports no verdict for an empty measurement set", () => {
    const summary = summarizeActivationMeasurements([]);

    expect(summary).toEqual({
      count: 0,
      slowestMillis: null,
      medianFirst10: null,
      medianFinal10: null,
      driftRatio: null,
      withinBudget: false,
      withinDrift: false,
    });
  });

  it("uses the final ten values even when more than forty were taken", () => {
    const summary = summarizeActivationMeasurements(
      measurements(
        [10, 10, 10, 10, 10, 10, 10, 10, 10, 10],
        [100, 100, 100, 100, 100],
        [11, 11, 11, 11, 11, 11, 11, 11, 11, 11],
      ),
    );

    expect(summary.count).toBe(25);
    expect(summary.medianFirst10).toBe(10);
    expect(summary.medianFinal10).toBe(11);
  });
});
