import assert from "node:assert/strict";
import test from "node:test";

import { isAppliedComplete, progressOf, updateTransferProgress } from "../src/lib/updateProgress.ts";

test("a Hub-relayed transfer reports chunks", () => {
  const state = { phase: "downloading", operation: "apply_update", total_chunks: 425, applied_chunks: 120 };
  assert.equal(updateTransferProgress(state), "120 / 425 (28%)");
  assert.equal(progressOf(state), 28);
  assert.equal(isAppliedComplete(state), false);
  assert.equal(isAppliedComplete({ ...state, applied_chunks: 425 }), true);
});

test("a WiFi transfer still reports files", () => {
  assert.equal(updateTransferProgress({ phase: "downloading", total_files: 4, applied_files: 1 }), "1 / 4 (25%)");
});

test("nothing to show outside a transfer", () => {
  assert.equal(updateTransferProgress({ phase: "ready", total_chunks: 425 }), null);
  assert.equal(updateTransferProgress({ phase: "downloading" }), null);
});
