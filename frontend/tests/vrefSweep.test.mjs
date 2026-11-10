import assert from "node:assert/strict";
import test from "node:test";

import { rsSpreadFraction, summarizeSweep, sweepCsv } from "../src/lib/vrefSweep.ts";

// 2 rows x 2 cols; Rfb 20k, a cell of Rs = 10k reads Vref * (1 + 20k/10k) = 3 * Vref.
function step(vref, rs, rfb = 20000) {
  const v = (r) => (r === null ? vref : vref * (1 + rfb / r));
  return { vref_mv: vref, matrix_mv: [v(rs), v(null), v(null), v(rs)] };
}
const measured = { rfb_ohm: [20000, 20000], offset_mv: [0, 0] };

test("a pure resistance keeps its Rs across Vref", () => {
  const steps = [step(200, 10000), step(300, 10000), step(500, 10000)];
  const summary = summarizeSweep(steps, 2, 2, measured);
  assert.deepEqual(summary.map((s) => Math.round(s.rsMedianOhm)), [10000, 10000, 10000]);
  assert.equal(summary[0].usedCells, 2);
  assert.equal(rsSpreadFraction(summary) < 1e-9, true);
});

test("a material whose Rs falls with Vref shows a spread", () => {
  const summary = summarizeSweep([step(200, 12000), step(500, 8000)], 2, 2, measured);
  assert.ok(rsSpreadFraction(summary) > 0.3);
});

test("cells at the rail are counted, not turned into a resistance", () => {
  const saturated = { vref_mv: 330, matrix_mv: [3100, 330, 330, 3173] };
  const [only] = summarizeSweep([saturated], 2, 2, measured);
  assert.equal(only.saturatedCells, 2);
  assert.equal(only.rsMedianOhm, null);
});

test("without a measured Rfb the soldered value is used, and without either Rs is unknown", () => {
  const bare = { vref_mv: 330, matrix_mv: [990, 330, 330, 990] };
  assert.equal(Math.round(summarizeSweep([bare], 2, 2, {}, 20000)[0].rsMedianOhm), 10000);
  assert.equal(summarizeSweep([bare], 2, 2)[0].rsMedianOhm, null);
  assert.equal(summarizeSweep([bare], 2, 2)[0].rfbMeanOhm, null);
});

test("a row's ADC offset moves where no signal is", () => {
  // The ADC reads 9 mV high on this row: an idle cell sits at Vref + 9, not Vref.
  const biased = { vref_mv: 330, matrix_mv: [339 + 660, 339, 339, 339 + 660] };
  const [only] = summarizeSweep([biased], 2, 2, { rfb_ohm: [20000, 20000], offset_mv: [9, 9] });
  assert.equal(Math.round(only.rsMedianOhm), 10000);
  assert.equal(only.usedCells, 2);
});

test("the csv is one line per vref and cell, row-major", () => {
  const lines = sweepCsv([step(300, 10000)], 2, 2, measured).trim().split("\n");
  assert.equal(lines[0], "vref_mv,row,col,rfb_ohm,offset_mv,raw_mv");
  assert.equal(lines.length, 1 + 4);
  assert.equal(lines[2], "300,0,1,20000,0,300");
});
