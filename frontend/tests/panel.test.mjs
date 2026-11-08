import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createServer } from "vite";

async function load() {
  const server = await createServer({ root: process.cwd(), logLevel: "error" });
  try {
    return {
      panel: await server.ssrLoadModule("/src/lib/panel.ts"),
      readout: await server.ssrLoadModule("/src/lib/readout.ts"),
    };
  } finally {
    await server.close();
  }
}

const modules = load();
const EXAMPLE = JSON.parse(readFileSync(new URL("../src/sdk/examples/sysmon.panel.json", import.meta.url), "utf8"));
const clone = () => structuredClone(EXAMPLE);

test("the sysmon example passes, and a readout is a panel without actions", async () => {
  const { panel } = await modules;
  assert.equal(panel.panelRejectionReason(EXAMPLE), null);
  const readout = { nhapp: 1, kind: "readout", manifest: {}, readout: { sources: [{ id: "s", command: "sysmon" }], sections: [{ kind: "stats", title: "x", items: [] }] } };
  assert.equal(panel.panelRejectionReason(readout), null);
  readout.readout.actions = [{ id: "a", label: "A", command: "task_stop" }];
  assert.equal(panel.panelRejectionReason(readout), "readout_must_not_declare_actions");
});

test("an action needs a declared permission and is never a forbidden command", async () => {
  const { panel } = await modules;
  const doc = clone();
  doc.manifest.permissions = ["service_control", "app_control"];
  assert.match(panel.panelRejectionReason(doc), /^panel_action_not_permitted:task_stop$/);
  for (const command of ["set_imu", "file_write_begin", "file_delete", "reboot", "app_install", "config_set"]) {
    const bad = clone();
    bad.panel.actions[0].command = command;
    assert.match(panel.panelRejectionReason(bad), /^panel_action_not_permitted:/, command);
    assert.equal(panel.isForbiddenCommand(command), true, command);
  }
  const unknown = clone();
  unknown.manifest.permissions.push("everything");
  assert.equal(panel.panelRejectionReason(unknown), "unknown_permission:everything");
});

test("arguments are constants, $row.x or a declared $input.x -- nothing else", async () => {
  const { panel } = await modules;
  for (const bad of ["$row.name + 1", "${row.name}", "$env.HOME", "$row.a.b", { x: 1 }]) {
    const doc = clone();
    doc.panel.actions[0].args.name = bad;
    assert.match(panel.panelRejectionReason(doc), /^invalid_arg_template:/, JSON.stringify(bad));
  }
  const doc = clone();
  doc.panel.actions[0].args.period_us = "$input.period_us";
  assert.match(panel.panelRejectionReason(doc), /^input_not_declared:/);
});

test("resolveArgs copies values verbatim and refuses holes", async () => {
  const { panel } = await modules;
  const template = { name: "$row.name", period_us: "$input.period_us", mode: "default", n: 3 };
  assert.deepEqual(panel.resolveArgs(template, { name: "imu" }, { period_us: 20000 }),
    { name: "imu", period_us: 20000, mode: "default", n: 3 });
  assert.equal(panel.resolveArgs(template, {}, { period_us: 1 }), null);
  assert.equal(panel.resolveArgs({ name: "$row.name" }, { name: { nested: 1 } }, {}), null);
  assert.equal(panel.resolveArgs({ command: "reboot" }, {}, {}), null);
  assert.equal(panel.resolveArgs({ name: "$row.constructor" }, {}, {}), null);
});

test("conditions gate and hide actions per row", async () => {
  const { panel } = await modules;
  const actions = new Map(EXAMPLE.panel.actions.map((action) => [action.id, action]));
  const stop = actions.get("t_stop");
  assert.equal(panel.actionEnabled(stop.when, { state: "running" }), true);
  assert.equal(panel.actionEnabled(stop.when, { state: "stopped" }), false);
  assert.equal(panel.actionHidden(stop, { protected: true }), true);
  assert.equal(panel.actionHidden(stop, { protected: "true" }), true);
  assert.equal(panel.actionHidden(stop, { protected: false }), false);
  // Only eq/ne: an operator the SDK does not define never holds.
  assert.equal(panel.actionEnabled({ field: "state", in: ["running", "degraded"] }, { state: "degraded" }), false);
  // Lists: `when` needs every condition, `hidden_when` any.
  const rate = actions.get("t_rate");
  assert.equal(panel.actionHidden(rate, { protected: false, fixed_period: true }), true);
  assert.equal(panel.actionHidden(rate, { protected: false, fixed_period: false }), false);
  const revive = actions.get("a_revive");
  assert.equal(panel.actionEnabled(revive.when, { state: "killed" }), true);
  assert.equal(panel.actionEnabled(revive.when, { state: "running" }), false);
  assert.equal(panel.actionEnabled(revive.when, { state: "stopped" }), false);
});

test("Run offers only stopped things its actions can start", async () => {
  const { panel } = await modules;
  const actions = new Map(EXAMPLE.panel.actions.map((action) => [action.id, action]));
  const run = EXAMPLE.panel.sections.find((section) => section.kind === "run");
  const data = {
    tasks: [{ name: "imu", state: "stopped" }, { name: "scan_stream", state: "running" }],
    svcs: [{ name: "scanner", state: "stopped", operator_stopped: true }, { name: "wifi", state: "running", operator_stopped: false }],
    apps: [{ name: "flow", state: "stopped" }, { name: "flow1", state: "killed" }],
  };
  const entries = panel.runEntries(run, actions, data);
  assert.deepEqual(entries.map((entry) => `${entry.action.id}:${entry.label}`),
    ["t_start:imu", "s_start:scanner", "a_start:flow"]);
  assert.deepEqual(panel.filterRunEntries(entries, "sc").map((entry) => entry.label), ["scanner"]);
  assert.deepEqual(panel.filterRunEntries(entries, "lo").map((entry) => entry.label), ["flow"]);
});

test("actions the device does not list are hidden; no catalog hides nothing", async () => {
  const { panel } = await modules;
  const actions = EXAMPLE.panel.actions;
  assert.equal(panel.supportedActions(actions, null).length, actions.length);
  const old = panel.supportedActions(actions, new Set(["service_restart", "app_revive"]));
  assert.deepEqual(old.map((action) => action.id), ["s_restart", "a_revive"]);
});

test("a dotted source path walks into sysmon's parts", async () => {
  const { readout } = await modules;
  const result = { data: { scheduler: { tasks: [{ name: "imu" }] }, threads: { cores: [{ core: 0 }] } } };
  assert.deepEqual(readout.extractSource(result, { id: "t", command: "sysmon", path: "scheduler.tasks" }), [{ name: "imu" }]);
  assert.deepEqual(readout.extractSource(result, { id: "c", command: "sysmon", path: "threads.cores" }), [{ core: 0 }]);
  assert.deepEqual(readout.extractSource(result, { id: "x", command: "sysmon", path: "scheduler.__proto__" }), []);
  assert.equal(readout.fieldValue(result.data, "threads.cores.0.core"), 0);
  assert.equal(readout.fieldValue(result.data, "threads.cores.x"), undefined);
  assert.equal(readout.fieldValue({ a: 1 }, "constructor"), undefined);
});

test("the command lock never lets two sends overlap", async () => {
  const { panel } = await modules;
  const lock = panel.createCommandLock();
  let active = 0;
  let peak = 0;
  const log = [];
  const task = (name, ms) => async () => {
    active += 1;
    peak = Math.max(peak, active);
    log.push(`start:${name}`);
    await new Promise((resolve) => setTimeout(resolve, ms));
    log.push(`end:${name}`);
    active -= 1;
    return name;
  };
  const pollPass = lock.tryRun(task("poll", 20));
  // A second poll while one is in flight is skipped, not queued.
  assert.equal(await lock.tryRun(task("poll2", 1)), null);
  // Two actions wait their turn.
  const [a, b] = await Promise.all([lock.run(task("a", 5)), lock.run(task("b", 5)), pollPass]);
  assert.equal(a, "a");
  assert.equal(b, "b");
  assert.equal(peak, 1);
  assert.deepEqual(log.slice(0, 2), ["start:poll", "end:poll"]);
  assert.equal(lock.busy, false);
});

test("error codes map to translation keys", async () => {
  const { panel } = await modules;
  assert.equal(panel.panelErrorKey("task_protected"), "panelError_task_protected");
  assert.equal(panel.panelErrorKey("period_out_of_range"), "panelError_period_out_of_range");
  assert.equal(panel.panelErrorKey("something_else"), null);
});

test("messages substitute row fields and nothing else", async () => {
  const { panel } = await modules;
  assert.equal(panel.fillMessage("End {name}? {missing} {x.y}", { name: "imu" }), "End imu? {missing} {x.y}");
});

test("conditions follow the SDK's executable rule, case by case", async () => {
  const { panel } = await modules;
  const { CONDITION_CASES } = await import("../src/sdk/lib/panelset.mjs");
  assert.ok(CONDITION_CASES.length >= 10);
  for (const [what, when, hiddenWhen, row, enabled, hidden] of CONDITION_CASES) {
    assert.equal(panel.actionEnabled(when, row), enabled, `${what}: enabled`);
    assert.equal(panel.actionHidden({ id: "a", label: "a", command: "task_stop", hidden_when: hiddenWhen }, row), hidden,
      `${what}: hidden`);
  }
});

test("a condition the SDK would refuse is refused here too", async () => {
  const { panel } = await modules;
  for (const bad of [
    { field: "state", in: ["running"] },
    { field: "state" },
    { field: "state", eq: "running", ne: "stopped" },
    { field: "state", eq: { nested: true } },
    [],
  ]) {
    const doc = clone();
    doc.panel.actions[0].when = bad;
    assert.match(panel.panelRejectionReason(doc), /^invalid_when:/, JSON.stringify(bad));
  }
});
