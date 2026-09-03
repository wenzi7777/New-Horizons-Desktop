import assert from "node:assert/strict";
import test from "node:test";

import {
  connectionRank,
  connectionStateLabel,
  deviceClassName,
  statusDot,
} from "../src/lib/deviceStatus.ts";

const device = (connectionState, mode = "normal") => ({ connectionState, mode });
const t = (key) => `t:${key}`;

test("card class reflects connection state before operating mode", () => {
  assert.equal(deviceClassName(device("online")), "normal");
  assert.equal(deviceClassName(device("offline")), "offline");
  assert.equal(deviceClassName(device("reconnecting")), "reconnecting");
  assert.equal(deviceClassName(device("booting")), "booting");
  assert.equal(deviceClassName(device("online", "maintenance")), "maintenance");
  assert.equal(deviceClassName(device("online", "safe_maintenance")), "maintenance");
  // Unreachable outranks maintenance: you cannot service what you cannot reach.
  assert.equal(deviceClassName(device("offline", "maintenance")), "offline");
  // Maintenance outranks booting, preserving the Launchpad ordering.
  assert.equal(deviceClassName(device("booting", "maintenance")), "maintenance");
});

test("status dot maps every connection state to a defined variant", () => {
  assert.equal(statusDot(device("online")), "status-dot online");
  assert.equal(statusDot(device("offline")), "status-dot offline");
  assert.equal(statusDot(device("reconnecting")), "status-dot reconnecting");
  assert.equal(statusDot(device("booting")), "status-dot booting");
  // Mode must never leak into the dot.
  assert.equal(statusDot(device("online", "maintenance")), "status-dot online");
});

test("connection label always translates and never leaks the raw mode string", () => {
  assert.equal(connectionStateLabel(device("online"), t), "t:online");
  assert.equal(connectionStateLabel(device("offline"), t), "t:offline");
  assert.equal(connectionStateLabel(device("reconnecting"), t), "t:reconnecting");
  assert.equal(connectionStateLabel(device("booting"), t), "t:booting");
  // The bug this guards: LaunchpadPage's deviceStateLabel falls through to the
  // untranslated `mode` for an online device, which the picker must not do.
  assert.equal(connectionStateLabel(device("online", "maintenance"), t), "t:online");
});

test("reachable devices sort ahead of unreachable ones", () => {
  const states = ["offline", "reconnecting", "booting", "online"];
  const sorted = states
    .map((state) => device(state))
    .sort((left, right) => connectionRank(left) - connectionRank(right))
    .map((entry) => entry.connectionState);

  assert.deepEqual(sorted, ["online", "booting", "reconnecting", "offline"]);
  assert.ok(connectionRank(device("online")) < connectionRank(device("offline")));
});
