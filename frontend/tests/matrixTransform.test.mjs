import assert from "node:assert/strict";
import test from "node:test";

import { displayIndexGrid, displayPinLabels } from "../src/lib/matrixTransform.ts";

const none = { rowMirror: false, colMirror: false, transpose: false };

// 2×3 stream:  0 1 2
//              3 4 5
test("no transform keeps the stream's order", () => {
  assert.deepEqual(displayIndexGrid(2, 3, none), { rows: 2, cols: 3, indices: [[0, 1, 2], [3, 4, 5]] });
});

test("mirrors flip the drawn rows and columns", () => {
  assert.deepEqual(displayIndexGrid(2, 3, { ...none, rowMirror: true }).indices, [[3, 4, 5], [0, 1, 2]]);
  assert.deepEqual(displayIndexGrid(2, 3, { ...none, colMirror: true }).indices, [[2, 1, 0], [5, 4, 3]]);
});

test("transpose swaps the axes, then the mirrors act on what is drawn", () => {
  const t = { ...none, transpose: true };
  assert.deepEqual(displayIndexGrid(2, 3, t), { rows: 3, cols: 2, indices: [[0, 3], [1, 4], [2, 5]] });
  // Transpose + Col Mirror = a quarter turn clockwise.
  assert.deepEqual(displayIndexGrid(2, 3, { ...t, colMirror: true }).indices, [[3, 0], [4, 1], [5, 2]]);
  assert.deepEqual(displayIndexGrid(2, 3, { ...t, rowMirror: true }).indices, [[2, 5], [1, 4], [0, 3]]);
  assert.deepEqual(displayIndexGrid(2, 3, { transpose: true, rowMirror: true, colMirror: true }).indices, [[5, 2], [4, 1], [3, 0]]);
});

test("the 8 combinations are 8 different layouts of the same sensors", () => {
  const seen = new Set();
  for (const transpose of [false, true]) {
    for (const rowMirror of [false, true]) {
      for (const colMirror of [false, true]) {
        const grid = displayIndexGrid(3, 3, { transpose, rowMirror, colMirror });
        assert.deepEqual(grid.indices.flat().sort((a, b) => a - b), [0, 1, 2, 3, 4, 5, 6, 7, 8]);
        seen.add(JSON.stringify(grid.indices));
      }
    }
  }
  assert.equal(seen.size, 8);
});

test("pin labels follow the drawn axes", () => {
  const labels = { rows: ["A1", "A2"], cols: ["D1", "D2", "D3"] };
  assert.deepEqual(displayPinLabels(labels, none), { rows: ["A1", "A2"], cols: ["D1", "D2", "D3"] });
  assert.deepEqual(displayPinLabels(labels, { ...none, transpose: true }), { rows: ["D1", "D2", "D3"], cols: ["A1", "A2"] });
  assert.deepEqual(displayPinLabels(labels, { transpose: true, rowMirror: true, colMirror: false }), {
    rows: ["D3", "D2", "D1"],
    cols: ["A1", "A2"],
  });
});
