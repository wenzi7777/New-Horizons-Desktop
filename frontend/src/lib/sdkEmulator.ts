// The emulator's logic, kept out of React so it can be tested: turning live
// samples into frames, noticing the frames the browser never saw, and moving
// a simulation to any point of a recording.

import { Simulator, type Frame, type SimEvent } from "../sdk/lib/index.mjs";
import type { VisualizationEntry } from "./api";

/** A live sample as a simulator frame, or null if it carries no pressures. */
export function frameFromSample(entry: VisualizationEntry, shape: { rows: number; cols: number }, fallbackSeq: number): Frame | null {
  if (!Array.isArray(entry.p) || entry.p.length === 0) return null;
  const seq = Number.isFinite(Number(entry.frame_id)) && entry.frame_id !== undefined ? Number(entry.frame_id) : fallbackSeq;
  const timestamp = Number(entry.timestamp_ms ?? entry.received_at_ms ?? Date.now());
  const rows = shape.rows * shape.cols === entry.p.length ? shape.rows : 1;
  const cols = shape.rows * shape.cols === entry.p.length ? shape.cols : entry.p.length;
  return { seq, timestampMs: Math.trunc(timestamp), values: Float32Array.from(entry.p, (v) => Number(v) || 0), rows, cols };
}

/**
 * Counts frames the device scanned but the browser never received.
 *
 * The backend pushes at most 60 frames a second and drops the rest
 * (latest-wins), so on a faster scan the emulator sees a thinned stream. A
 * debounce or a window then spans more real time per sample than it will on
 * the device, and the emulator must say so rather than quietly differ.
 * frame_seq gaps are how it knows.
 */
export class SeqGapTracker {
  received = 0;
  missed = 0;
  private last: number | null = null;

  /** @returns frames skipped just before this one */
  observe(seq: number): number {
    this.received += 1;
    if (this.last === null) {
      this.last = seq;
      return 0;
    }
    // uint32 on the device; a large jump backwards is a reboot, not a gap.
    const delta = (seq - this.last) >>> 0;
    this.last = seq;
    if (delta === 0 || delta > 0x7fffffff) return 0;
    const skipped = delta - 1;
    this.missed += skipped;
    return skipped;
  }

  /** Share of the device's frames that arrived, 0..1. */
  get coverage(): number {
    const total = this.received + this.missed;
    return total === 0 ? 1 : this.received / total;
  }

  reset() {
    this.received = 0;
    this.missed = 0;
    this.last = null;
  }
}

/**
 * A simulation positioned at a frame of a recording.
 *
 * Moving forward steps on from where it is. Moving backward replays from the
 * start: a debounce's timer and a window's ring are the history, so there is
 * no other way to know their state at an earlier frame.
 *
 * Button presses are part of that history, so they are kept by frame index
 * and replayed with it -- a press sent straight to the simulator would vanish
 * the first time the operator scrubbed backwards past it.
 */
export class RecordingCursor {
  private sim: Simulator;
  /** Index of the last frame evaluated, or -1 before the first. */
  position = -1;
  private budget = { load: 0, graceLeft: 0 };

  constructor(
    private readonly pkg: Record<string, any>,
    private readonly frames: readonly Frame[],
    private readonly presses: ReadonlySet<number> = new Set(),
  ) {
    this.sim = new Simulator(pkg);
  }

  get simulator(): Simulator {
    return this.sim;
  }

  get length(): number {
    return this.frames.length;
  }

  setBudget(load: number, graceLeft: number) {
    this.budget = { load, graceLeft };
    this.sim.setBudget(load, graceLeft);
  }

  /** Evaluate up to and including frame `index`. Returns that frame's events. */
  seek(index: number): SimEvent[] {
    const target = Math.max(-1, Math.min(index, this.frames.length - 1));
    if (target < this.position) {
      this.sim = new Simulator(this.pkg);
      this.sim.setBudget(this.budget.load, this.budget.graceLeft);
      this.position = -1;
    }
    let last: SimEvent[] = [];
    while (this.position < target) {
      this.position += 1;
      if (this.presses.has(this.position)) this.sim.pressButton();
      last = this.sim.step(this.frames[this.position]);
    }
    return last;
  }

  get frame(): Frame | null {
    return this.position >= 0 ? this.frames[this.position] : null;
  }
}

/** Every event a package produces over a whole recording, for the timeline. */
export function simulateAll(pkg: Record<string, any>, frames: readonly Frame[], presses: ReadonlySet<number> = new Set()): SimEvent[] {
  const sim = new Simulator(pkg);
  frames.forEach((frame, index) => {
    if (presses.has(index)) sim.pressButton();
    sim.step(frame);
  });
  return sim.events;
}

/** Largest cell value across frames: the default top of the colour scale. */
export function peakOf(frames: readonly Frame[]): number {
  let peak = 0;
  for (const frame of frames) {
    for (let i = 0; i < frame.values.length; i += 1) if (frame.values[i] > peak) peak = frame.values[i];
  }
  return peak;
}

/** `HHMMSS.csv` -> `HHMMSS.events.csv`, the sidecar the Desktop writes beside it. */
export function sidecarPathFor(path: string): string {
  return path.replace(/\.csv$/i, ".events.csv");
}

export function isSidecar(name: string): boolean {
  return /\.events\.csv$/i.test(name);
}

/**
 * Which source lines to mark in the editor for this frame's output: the
 * statements whose nodes emitted.
 */
export function linesForEvents(pkg: Record<string, any>, nodeLines: readonly number[], events: readonly SimEvent[]): Set<number> {
  const lines = new Set<number>();
  if (!events.length) return lines;
  const names = new Set(events.map((event) => event.event));
  (pkg.nodes as { op: string; event?: string }[]).forEach((node, index) => {
    if ((node.op === "emit" || node.op === "emit_value") && node.event && names.has(node.event)) {
      const line = nodeLines[index];
      if (line) lines.add(line);
    }
  });
  return lines;
}
