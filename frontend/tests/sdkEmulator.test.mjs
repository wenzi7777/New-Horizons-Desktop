import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "vite";

async function load() {
  const server = await createServer({ root: process.cwd(), logLevel: "error" });
  try {
    return {
      emu: await server.ssrLoadModule("/src/lib/sdkEmulator.ts"),
      sdk: await server.ssrLoadModule("/src/sdk/lib/index.mjs"),
    };
  } finally {
    await server.close();
  }
}

const modules = load();

const HEADER = 'app demo {\n  name "Demo"\n  version 1.0.0\n  author me\n  summary "x"\n}\n';

async function compile(body) {
  const { sdk } = await modules;
  return sdk.compileSource(HEADER + body).package;
}

function frames(values, msStep = 16) {
  return values.map((v, i) => ({ seq: 100 + i, timestampMs: i * msStep, values: [v], rows: 1, cols: 1 }));
}

test("a live sample becomes a frame carrying the device's own frame number", async () => {
  const { emu } = await modules;
  const frame = emu.frameFromSample({ dn: "A", sn: 4, p: [1, 2, 3, 4], frame_id: 77, timestamp_ms: 5000 }, { rows: 2, cols: 2 }, 0);
  assert.deepEqual([frame.seq, frame.timestampMs, frame.rows, frame.cols], [77, 5000, 2, 2]);
  assert.deepEqual([...frame.values], [1, 2, 3, 4]);
});

test("a sample whose size disagrees with the board is read as one row, not reshaped", async () => {
  // Guessing a layout would silently move every region.
  const { emu } = await modules;
  const frame = emu.frameFromSample({ dn: "A", sn: 3, p: [1, 2, 3] }, { rows: 2, cols: 2 }, 9);
  assert.deepEqual([frame.rows, frame.cols, frame.seq], [1, 3, 9]);
  assert.equal(emu.frameFromSample({ dn: "A", sn: 0, p: [] }, { rows: 2, cols: 2 }, 0), null);
});

test("frames the browser never received are counted from frame_seq gaps", async () => {
  const { emu } = await modules;
  const gaps = new emu.SeqGapTracker();
  for (const seq of [10, 11, 13, 16, 17]) gaps.observe(seq);
  assert.equal(gaps.received, 5);
  assert.equal(gaps.missed, 3);
  assert.equal(gaps.coverage, 5 / 8);
});

test("a device reboot is not counted as a gap", async () => {
  const { emu } = await modules;
  const gaps = new emu.SeqGapTracker();
  for (const seq of [5000, 5001, 3, 4]) gaps.observe(seq);
  assert.equal(gaps.missed, 0);
});

test("the frame counter wrapping past uint32 is not a gap either", async () => {
  const { emu } = await modules;
  const gaps = new emu.SeqGapTracker();
  for (const seq of [2 ** 32 - 2, 2 ** 32 - 1, 0, 1]) gaps.observe(seq);
  assert.equal(gaps.missed, 0);
});

test("seeking backwards replays from the start, so debounce state is right", async () => {
  // Stepping back by undoing is impossible: the debounce timer IS the history.
  const { emu } = await modules;
  const pkg = await compile("signal a = total()\nevent hit when a > 10 for 50ms\n");
  const run = frames([0, 20, 20, 20, 20, 20, 0, 0]);
  const cursor = new emu.RecordingCursor(pkg, run);
  cursor.seek(7);
  const afterRun = cursor.simulator.events.map((e) => e.detail);
  cursor.seek(2);
  assert.equal(cursor.position, 2);
  assert.deepEqual(cursor.simulator.events, [], "only 32 ms held by frame 2: nothing may have fired yet");
  cursor.seek(7);
  assert.deepEqual(cursor.simulator.events.map((e) => e.detail), afterRun);
});

test("seek returns the events of the frame it lands on", async () => {
  const { emu } = await modules;
  const pkg = await compile("signal a = total()\nevent hit when a > 10\n");
  const cursor = new emu.RecordingCursor(pkg, frames([0, 20, 20, 0]));
  assert.deepEqual(cursor.seek(1).map((e) => e.detail), ["rise"]);
  assert.deepEqual(cursor.seek(2), []);
  assert.deepEqual(cursor.seek(3).map((e) => e.detail), ["fall"]);
});

test("injected budget pressure survives a replay", async () => {
  const { emu } = await modules;
  const pkg = await compile("signal load = budget_load()\ngate (load < 0.9) {\n  signal p = peak()\n  event spike when p > 10\n}\n");
  const cursor = new emu.RecordingCursor(pkg, frames([50, 50, 50]));
  cursor.setBudget(1.5, 1);
  cursor.seek(2);
  cursor.seek(0);
  assert.deepEqual(cursor.simulator.events.map((e) => e.event), ["degraded"]);
});

test("the editor marks the statement whose event fired", async () => {
  const { emu, sdk } = await modules;
  const { package: pkg, report } = sdk.compileSource(`${HEADER}signal a = total()\nevent hit when a > 10\n`);
  const events = [{ seq: 1, frameSeq: 1, timestampMs: 0, app: "x", event: "hit", detail: "rise", value: null }];
  assert.deepEqual([...emu.linesForEvents(pkg, report.nodeLines, events)], [8]);
  assert.deepEqual([...emu.linesForEvents(pkg, report.nodeLines, [])], []);
});

test("a recording's sidecar is found by name and kept out of the file list", async () => {
  const { emu } = await modules;
  assert.equal(emu.sidecarPathFor("NH-1/20260923/143000.csv"), "NH-1/20260923/143000.events.csv");
  assert.equal(emu.isSidecar("143000.events.csv"), true);
  assert.equal(emu.isSidecar("143000.csv"), false);
});
