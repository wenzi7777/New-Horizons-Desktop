import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "vite";

async function load() {
  const server = await createServer({ root: process.cwd(), logLevel: "error" });
  try {
    return await server.ssrLoadModule("/src/lib/readout.ts");
  } finally {
    await server.close();
  }
}

const readout = load();
const SECTION = { kind: "chart", title: "Acc", source: "imu", points: 10, series: [{ field: "ax" }, { field: "ay" }] };

test("a path to an object is one row, as sensor_sample reports its sensors", async () => {
  const { extractSource } = await readout;
  assert.deepEqual(extractSource({ data: { imu: { ax: 1 } } }, { id: "imu", command: "sensor_sample", path: "imu" }), { ax: 1 });
  assert.deepEqual(extractSource({ data: { tasks: [{ name: "a" }] } }, { id: "t", command: "task_list", path: "tasks" }), [{ name: "a" }]);
  assert.deepEqual(extractSource({ data: { x: 3 } }, { id: "x", command: "status", path: "x" }), []);
});

test("a missing or non-numeric field is a gap, not a zero", async () => {
  const { chartSample } = await readout;
  assert.deepEqual(chartSample(SECTION, { ax: 0.5, ay: "n/a" }), [0.5, null]);
  assert.deepEqual(chartSample(SECTION, undefined), [null, null]);
});

test("the history keeps the last `points` polls", async () => {
  const { chartPoints, pushChartHistory } = await readout;
  let history = [];
  for (let i = 0; i < 25; i += 1) history = pushChartHistory(history, [i, null], chartPoints(SECTION));
  assert.equal(history.length, 10);
  assert.deepEqual(history[0], [15, null]);
  assert.equal(chartPoints({ ...SECTION, points: 5000 }), 600);
  assert.equal(chartPoints({ ...SECTION, points: undefined }), 60);
});

test("the y range follows the data, or the section's bounds, and is never flat", async () => {
  const { chartRange } = await readout;
  assert.deepEqual(chartRange(SECTION, [[1, 3], [null, -2]]), { min: -2, max: 3 });
  assert.deepEqual(chartRange({ ...SECTION, min: -10, max: 10 }, [[1, 3]]), { min: -10, max: 10 });
  assert.deepEqual(chartRange(SECTION, [[4, 4]]), { min: 3, max: 5 });
  assert.deepEqual(chartRange(SECTION, []), { min: 0, max: 1 });
});

test("sensor_sample is a command a readout may poll", async () => {
  const { READOUT_ALLOWED_SOURCES, readoutRejectionReason } = await readout;
  assert.ok(READOUT_ALLOWED_SOURCES.has("sensor_sample"));
  const pkg = { nhapp: 1, kind: "readout", manifest: {}, readout: { sources: [{ id: "imu", command: "sensor_sample", path: "imu" }], sections: [SECTION] } };
  assert.equal(readoutRejectionReason(pkg), null);
});
