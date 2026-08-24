import assert from "node:assert/strict";
import test from "node:test";

import {
  actionButtonActionsForGesture,
  buildActionButtonCommand,
  normalizeActionButtonStatus,
} from "../src/lib/actionButton.ts";

test("Action Button actions keep soft-off exclusive to a long press", () => {
  assert.deepEqual(actionButtonActionsForGesture("short"), ["none", "identify", "toggle_external_led"]);
  assert.deepEqual(actionButtonActionsForGesture("long"), ["none", "identify", "toggle_external_led", "soft_off"]);
});

test("builds an Action Button command only from a complete valid pair", () => {
  assert.deepEqual(buildActionButtonCommand("identify", "soft_off"), {
    command: "set_action_button",
    short_press: "identify",
    long_press: "soft_off",
  });
  assert.throws(() => buildActionButtonCommand("soft_off", "identify"), /invalid_action_button_config/);
});

test("normalizes missing Action Button support without inventing a device configuration", () => {
  assert.deepEqual(normalizeActionButtonStatus(undefined), {
    supported: false,
    shortPress: null,
    longPress: null,
    bootWifiSetup: null,
    lastAction: null,
    lastResult: null,
  });
});
