import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "vite";

async function load() {
  const server = await createServer({ root: process.cwd(), logLevel: "error" });
  try {
    return await server.ssrLoadModule("/src/lib/recordingAnalysis.ts");
  } finally {
    await server.close();
  }
}

const analysis = load();

const HEADER = "timestamp_ms,P1,P2,P3,P4,Mag_x,Mag_y,Mag_z,Gyro_x,Gyro_y,Gyro_z,Acc_x,Acc_y,Acc_z,frame_seq,time_ref";

function row(ms, pressures, seq, ref = "device") {
  return [ms, ...pressures, 0, 0, 0, 0, 0, 0, 0.1, 0.2, 0.98, seq, ref].join(",");
}

function csv(rows) {
  return [HEADER, ...rows].join("\r\n") + "\r\n";
}

test("timestamps are epoch milliseconds: 6 rows 16-17 ms apart span 84 ms", async () => {
  const { parseRecordingCsv, summarizeRecording } = await analysis;
  const rows = [0, 17, 33, 50, 67, 84].map((offset, index) => row(1792135441343 + offset, [0, 10, 0, 0], 368 + index));
  const rec = parseRecordingCsv(csv(rows), "a.csv");
  assert.equal(rec.rowCount, 6);
  assert.deepEqual(rec.sensorNames, ["P1", "P2", "P3", "P4"]);
  const summary = summarizeRecording(rec);
  assert.equal(summary.durationMs, 84);
  assert.equal(summary.lostFrames, 0);
  assert.equal(summary.timeGaps, 0);
  assert.equal(summary.timeRefCounts.device, 6);
  assert.ok(Math.abs(summary.rateHz - 5000 / 84) < 1e-9);
});

test("an all-zero IMU channel is a board without that sensor and is dropped", async () => {
  const { parseRecordingCsv } = await analysis;
  const rec = parseRecordingCsv(csv([row(1, [1, 2, 3, 4], 1), row(2, [1, 2, 3, 4], 2)]));
  assert.deepEqual(Object.keys(rec.imu).sort(), ["Acc_x", "Acc_y", "Acc_z"]);
});

test("lost frames, restarts and pauses are reported where they happen", async () => {
  const { parseRecordingCsv, summarizeRecording } = await analysis;
  const rows = [
    row(1000, [0, 0, 0, 0], 10),
    row(1017, [0, 0, 0, 0], 11),
    row(1067, [0, 0, 0, 0], 14), // frames 12 and 13 lost
    row(1084, [0, 0, 0, 0], 15),
    row(3084, [0, 0, 0, 0], 16), // a 2 s pause
    row(3101, [0, 0, 0, 0], 1), // the device restarted
    row(3118, [0, 0, 0, 0], 2),
  ];
  const summary = summarizeRecording(parseRecordingCsv(csv(rows)));
  assert.equal(summary.lostFrames, 2);
  assert.equal(summary.restarts, 1);
  assert.equal(summary.timeGaps, 1);
  assert.deepEqual(
    summary.issues.map((issue) => [issue.index, issue.kind, issue.amount]),
    [[2, "lost_frames", 2], [4, "time_gap", 2000], [5, "restart", 0]],
  );
});

test("a short or garbled line is skipped, not read as zeros", async () => {
  const { parseRecordingCsv } = await analysis;
  const rec = parseRecordingCsv(csv([row(1, [1, 1, 1, 1], 1), "17923,1,2", row(3, [2, 2, 2, 2], 2)]));
  assert.equal(rec.rowCount, 2);
  assert.equal(rec.skippedLines, 1);
  assert.deepEqual(Array.from(rec.lineOfRow), [1, 3]);
});

test("total, peak and contact area per row", async () => {
  const { parseRecordingCsv } = await analysis;
  const rec = parseRecordingCsv(csv([row(1, [0, 100, 50, 1], 1), row(2, [0, 0, 0, 0], 2)]));
  assert.equal(rec.maxValue, 100);
  assert.equal(rec.activeThreshold, 2);
  assert.deepEqual(Array.from(rec.total), [151, 0]);
  assert.deepEqual(Array.from(rec.peak), [100, 0]);
  assert.deepEqual(Array.from(rec.active), [2, 0]);
});

test("sensor statistics over a range", async () => {
  const { parseRecordingCsv, sensorStats, sensorFrame } = await analysis;
  const rec = parseRecordingCsv(csv([row(1, [0, 10, 0, 0], 1), row(2, [0, 30, 0, 0], 2), row(3, [99, 0, 0, 0], 3)]));
  const stats = sensorStats(rec, 0, 2);
  assert.equal(stats[1].mean, 20);
  assert.equal(stats[1].peak, 30);
  assert.equal(stats[1].std, 10);
  assert.equal(stats[1].activeShare, 1);
  assert.equal(stats[0].peak, 0);
  assert.deepEqual(Array.from(sensorFrame(rec, "frame", 2, 3)), [99, 0, 0, 0]);
  assert.deepEqual(Array.from(sensorFrame(rec, "peak", 0, 3)), [99, 30, 0, 0]);
});

test("the timestamp unit is told apart by size", async () => {
  const { detectTimestampUnit, timestampToEpochMs } = await analysis;
  assert.equal(detectTimestampUnit(1792135441), "s");
  assert.equal(detectTimestampUnit(1792135441343), "ms");
  assert.equal(detectTimestampUnit(1792135441343000), "us");
  assert.equal(detectTimestampUnit(1.792e18), "ns");
  // The mistake that started this: ms read as s lands 56,000 years out.
  assert.equal(timestampToEpochMs(1792135441343, "ms"), 1792135441343);
  assert.equal(new Date(timestampToEpochMs(1792135441, "s")).toISOString(), "2026-10-16T07:24:01.000Z");
});

test("durations read as m:ss.mmm", async () => {
  const { formatDuration } = await analysis;
  assert.equal(formatDuration(346903), "5:46.903");
  assert.equal(formatDuration(433730), "7:13.730");
  assert.equal(formatDuration(3946903), "1:05:46.903");
  assert.equal(formatDuration(5000, false), "0:05");
});

test("grids are as square as the sensor count allows", async () => {
  const { defaultGridColumns } = await analysis;
  assert.equal(defaultGridColumns(25), 5);
  assert.equal(defaultGridColumns(112), 14);
  assert.equal(defaultGridColumns(225), 15);
  assert.equal(defaultGridColumns(16), 4);
  assert.equal(defaultGridColumns(7), 3); // a prime count: 3 x 3 with two empty cells
});

test("buckets keep every spike", async () => {
  const { bucketSeries } = await analysis;
  const time = Float64Array.from([0, 1, 2, 3, 4, 5, 6, 7]);
  const values = [0, 9, 0, 0, -3, 0, 0, 1];
  const buckets = bucketSeries(time, (index) => values[index], 0, 8, 0, 8, 2);
  assert.deepEqual(buckets.map((bucket) => [bucket.min, bucket.max]), [[0, 9], [-3, 1]]);
});

test("binary search by time", async () => {
  const { indexAtTime, nearestIndex } = await analysis;
  const time = Float64Array.from([0, 16, 33, 50]);
  assert.equal(indexAtTime(time, 20), 2);
  assert.equal(indexAtTime(time, 99), 4);
  assert.equal(nearestIndex(time, 20), 1);
  assert.equal(nearestIndex(time, 30), 2);
  assert.equal(nearestIndex(time, 99), 3);
});

test("events land on their frame's row; uptime-only events without a frame are left out", async () => {
  const { parseRecordingCsv, parseEventsCsv, placeEvents, sidecarNameFor, isEventsSidecar } = await analysis;
  const rec = parseRecordingCsv(csv([row(1000, [0, 0, 0, 0], 7), row(1017, [0, 0, 0, 0], 8), row(1033, [0, 0, 0, 0], 9)]));
  const events = parseEventsCsv([
    "seq,frame_seq,timestamp_ms,app,event,edge,value,uptime_ms,time_ref",
    "3,8,1017,flow,magnet,rise,,20085,device",
    "4,0,22906,flow,events_dropped,2,,22906,uptime",
    "5,99,1030,flow,north,fall,,23000,estimated",
  ].join("\n"));
  const placed = placeEvents(rec, events);
  assert.deepEqual(placed.map((event) => [event.seq, event.index, event.atMs]), [[3, 1, 17], [5, 2, 30]]);
  assert.equal(sidecarNameFor("072401.csv"), "072401.events.csv");
  assert.ok(isEventsSidecar("072401.events.csv"));
  assert.ok(!isEventsSidecar("072401.csv"));
});

test("an exported range is the original lines, header first", async () => {
  const { parseRecordingCsv, sliceRecordingText } = await analysis;
  const lines = [row(1, [1, 0, 0, 0], 1), row(2, [2, 0, 0, 0], 2), row(3, [3, 0, 0, 0], 3)];
  const text = csv(lines);
  const rec = parseRecordingCsv(text);
  assert.equal(sliceRecordingText(text, rec, 1, 2), [HEADER, lines[1], lines[2]].join("\n") + "\n");
});

test("ticks", async () => {
  const { niceTicks, timeTicks } = await analysis;
  assert.deepEqual(niceTicks(0, 100, 5), [0, 20, 40, 60, 80, 100]);
  assert.deepEqual(timeTicks(0, 346903, 6), [0, 60000, 120000, 180000, 240000, 300000]);
});

test("a recording's files pair up by name in both layouts", async () => {
  const { recordingBase, sidecarNameFor, metaNameFor, isSamplesCsv, isMetaFile } = await analysis;
  // v0.27.0+: one folder per recording.
  assert.equal(recordingBase("062756.data.csv"), "062756");
  assert.equal(sidecarNameFor("062756.data.csv"), "062756.events.csv");
  assert.equal(metaNameFor("062756.data.csv"), "062756.meta.json");
  assert.equal(sidecarNameFor("062756-2.data.csv"), "062756-2.events.csv");
  // Before: flat in the day folder.
  assert.equal(sidecarNameFor("072401.csv"), "072401.events.csv");
  assert.ok(isSamplesCsv("062756.data.csv"));
  assert.ok(isSamplesCsv("072401.csv"));
  assert.ok(!isSamplesCsv("072401.events.csv"));
  assert.ok(!isSamplesCsv("062756.meta.json"));
  assert.ok(isMetaFile("062756.meta.json"));
});

const META = {
  format: 1,
  files: { data: "062756.data.csv", events: "062756.events.csv" },
  device: { uid: "80456B76AAF4", hardware_model: "TIA-CTL v1.5.F 2026.7", firmware_version: "v1.16.0", firmware_prerelease: false },
  sensors: { count: 112, matrix_shape: { rows: 8, cols: 14 }, raw_adc_columns: false },
  calibration: { enabled: true, output_mode: "tared", tare_complete: true },
  stream: { target_fps: 60 },
  transport: { path: "espnow", relay: "hub", relay_id: "HUB-1" },
  status_received_at: "2026-10-16T06:27:10+00:00",
  recording: { started_at: "2026-10-16T06:27:56.770Z", rows: 20649, updated_at: "2026-10-16T06:33:43.700Z", stopped_at: "2026-10-16T06:33:43.700Z", stop_reason: "user" },
  changes: [{ at: "2026-10-16T06:30:00.000Z", frame_seq: 9000, field: "calibration.output_mode", from: "raw", to: "tared" }],
  some_future_block: { kept: true },
};

test("a meta file reads into the fields the pages show", async () => {
  const { parseRecordingMeta, parseRecordingMetaText, metaGridColumns } = await analysis;
  const meta = parseRecordingMeta(META);
  assert.equal(meta.device.hardwareModel, "TIA-CTL v1.5.F 2026.7");
  assert.equal(meta.device.firmwarePrerelease, false);
  assert.deepEqual([meta.sensors.count, meta.sensors.rows, meta.sensors.cols], [112, 8, 14]);
  assert.equal(meta.calibration.outputMode, "tared");
  assert.deepEqual(meta.transport, { path: "espnow", relay: "hub", relayId: "HUB-1" });
  assert.equal(meta.changes[0].frameSeq, 9000);
  assert.equal(meta.raw.some_future_block.kept, true);
  assert.equal(metaGridColumns(meta, 112), 14);
  // A shape that does not match the file is not trusted.
  assert.equal(metaGridColumns(meta, 25), null);
  assert.equal(metaGridColumns(null, 25), null);
  assert.equal(parseRecordingMetaText("{not json"), null);
  assert.equal(parseRecordingMeta([1, 2]), null);
});

test("a meta with missing or odd fields still reads, as nulls", async () => {
  const { parseRecordingMeta } = await analysis;
  const meta = parseRecordingMeta({ format: 1, device: { hardware_model: 5 }, sensors: "x", changes: [null, { field: "a" }] });
  assert.equal(meta.device.hardwareModel, null);
  assert.equal(meta.sensors.count, null);
  assert.equal(meta.recording.stoppedAt, null);
  assert.deepEqual(meta.changes.map((change) => change.field), ["a"]);
});

test("how a recording ended", async () => {
  const { parseRecordingMeta, recordingEnd } = await analysis;
  assert.equal(recordingEnd(parseRecordingMeta(META)), "stopped");
  const running = parseRecordingMeta({ ...META, recording: { ...META.recording, stopped_at: null, updated_at: "2026-10-16T06:33:43.700Z" } });
  assert.equal(recordingEnd(running, Date.parse("2026-10-16T06:33:50Z")), "live");
  // Not updated for a while and never stopped: the backend went away.
  assert.equal(recordingEnd(running, Date.parse("2026-10-16T07:00:00Z")), "cut_off");
});

test("the small timeline fills between min and max, broken where there is no data", async () => {
  const { envelopePolygons } = await analysis;
  const polygons = envelopePolygons([[0, 10], [5, 10], null, [0, 0]], 40, 10, 10);
  assert.equal(polygons.length, 2);
  // Top edge at the max (y 0), bottom at the min (+0.6 so a flat run shows).
  assert.equal(polygons[0], "5.00,0.00 15.00,0.00 15.00,5.60 5.00,10.00");
  assert.equal(polygons[1], "34.50,10.00 35.50,10.00 35.50,10.00 34.50,10.00");
  assert.deepEqual(envelopePolygons([], 40, 10, 10), []);
});
