import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "vite";

async function load() {
  const server = await createServer({ root: process.cwd(), logLevel: "error" });
  try {
    return await server.ssrLoadModule("/src/lib/deviceApps.ts");
  } finally {
    await server.close();
  }
}

const modules = load();

// Firmware v2.1.0: no slots; apps are named by id, and the registry reports
// the pool. Shapes follow AppManager::statusJson() / AppRegistry::statusJson().
const V21_LIST = {
  data: {
    apps: [
      {
        name: "steps", state: "running", order: 0, burst: true, memory_bytes: 1500,
        load: 62, level: "medium", cpu1: 40, cpu10: 35, cpu60: 20,
        base_us: 2083, borrowed_us: 400, lent_us: 0,
        state_detail: { package: "steps", nodes: 5, vm: { suspensions: 1, frames_skipped: 2 } },
      },
      { name: "glow", state: "suspended", order: 1, memory_bytes: 900, state_detail: { nodes: 3 } },
    ],
  },
};
const V21_PACKAGES = {
  data: {
    pool_bytes: 8192, pool_used: 2400, pool_free: 5792, control_bytes: 572,
    budget_us: 4166, used_us: 15,
    packages: [
      { id: "steps", kind: "flow", active: true, order: 0, memory_bytes: 1500, burst: true, capabilities: 5 },
      { id: "glow", kind: "flow", active: true, order: 1, memory_bytes: 900 },
      { id: "big", kind: "flow", active: false, order: -1, memory_bytes: 7000, estimated_us: 10 },
      { id: "slow", kind: "flow", active: false, order: -1, memory_bytes: 600, estimated_us: 4200 },
      { id: "chart", kind: "readout", active: false },
    ],
  },
};

test("v2.1.0 apps join their packages by id, in run order", async () => {
  const { mergeDeviceApps, parseAppList, parsePackageList, runtimeName, isRunning } = await modules;
  const merged = mergeDeviceApps(parseAppList(V21_LIST), parsePackageList(V21_PACKAGES));
  assert.deepEqual(merged.map((app) => app.id), ["steps", "glow", "big", "chart", "slow"]);
  const [steps, glow] = merged;
  assert.equal(runtimeName(steps), "steps");
  assert.equal(steps.burst, true);
  assert.equal(steps.memoryBytes, 1500);
  assert.equal(isRunning(steps), true);
  assert.equal(isRunning(glow), false);
  assert.equal(merged[2].runtime, null);
});

test("a v2.0.x device's slots map onto the same model, without slots", async () => {
  const { mergeDeviceApps, parseAppList, parsePackageList, runtimeName } = await modules;
  const apps = parseAppList({ data: { apps: [
    { name: "flow", state: "running", state_detail: { package: "", nodes: 0 } },
    { name: "flow1", state: "running", state_detail: { package: "steps", nodes: 5 } },
  ] } });
  const packages = parsePackageList({ data: { packages: [
    { id: "steps", slot: 1 },
    { id: "other", slot: -1 },
  ] } });
  const merged = mergeDeviceApps(apps, packages);
  assert.deepEqual(merged.map((app) => [app.id, app.active, app.order]), [["steps", true, 1], ["other", false, -1]]);
  // Commands to the runtime still use the slot's name on old firmware.
  assert.equal(runtimeName(merged[0]), "flow1");
});

test("load statistics are parsed only where the firmware reports them", async () => {
  const { parseAppList, parseLoadStats } = await modules;
  const [steps, glow] = parseAppList(V21_LIST);
  assert.deepEqual(steps.load, {
    load: 62, level: "medium", cpu1: 40, cpu10: 35, cpu60: 20, baseUs: 2083, borrowedUs: 400, lentUs: 0,
  });
  assert.equal(steps.suspensions, 1);
  assert.equal(steps.framesSkipped, 2);
  assert.equal(glow.load, null);
  assert.equal(parseLoadStats({ load: 5, level: "nonsense" }).level, "low");
});

test("the pool is read from app_list_packages", async () => {
  const { parseAppResources } = await modules;
  assert.deepEqual(parseAppResources(V21_PACKAGES), {
    poolBytes: 8192, poolUsed: 2400, poolFree: 5792, controlBytes: 572, budgetUs: 4166, usedUs: 15,
  });
  // Older firmware has no pool: nothing to draw.
  assert.equal(parseAppResources({ data: { packages: [] } }), null);
});

test("an app that would not fit says why, before anyone tries", async () => {
  const { admissionBlocker, mergeDeviceApps, parseAppList, parseAppResources, parsePackageList } = await modules;
  const resources = parseAppResources(V21_PACKAGES);
  const byId = new Map(
    mergeDeviceApps(parseAppList(V21_LIST), parsePackageList(V21_PACKAGES)).map((app) => [app.id, app]),
  );
  assert.deepEqual(admissionBlocker(byId.get("big"), resources), { kind: "memory", needBytes: 7000 - 5792 });
  assert.deepEqual(admissionBlocker(byId.get("slow"), resources), { kind: "time", needUs: 15 + 4200 - 4166 });
  // Running already, or no pool data: never blocked here (the device decides).
  assert.equal(admissionBlocker(byId.get("steps"), resources), null);
  assert.equal(admissionBlocker(byId.get("big"), null), null);
});

test("app_view names rows by app and carries the live load", async () => {
  const { parseAppView } = await modules;
  const view = parseAppView({ data: {
    oled: { hw: true, rows: [{ kind: "text", text: "Hi", app: "steps", contended: ["glow"] }, null] },
    status_led: { rgb: [0, 255, 0], owner: "steps", app_request: { app: "steps", rgb: [0, 255, 0] } },
    ext_led: { count: 0 },
    load: { cpu10: 35, budget_us: 4166, throttled: false, apps: [
      { name: "steps", state: "running", memory_bytes: 1500, load: 62, level: "medium", cpu10: 35 },
    ] },
  } });
  assert.equal(view.oled.rows[0].app, "steps");
  assert.deepEqual(view.oled.rows[0].contended, ["glow"]);
  assert.equal(view.statusLed.request.app, "steps");
  assert.equal(view.load.apps[0].name, "steps");
  assert.equal(view.load.apps[0].level, "medium");
  // v2.0.x named them by slot.
  const old = parseAppView({ data: { oled: { rows: [{ kind: "text", text: "x", slot: "flow1" }] } } });
  assert.equal(old.oled.rows[0].app, "flow1");
  assert.equal(old.load, null);
});

test("sizes and CPU read the way the UI prints them", async () => {
  const { formatBytes, formatCpu, moreThatFit, appErrorKey } = await modules;
  assert.equal(formatBytes(640), "640 B");
  assert.equal(formatBytes(1536), "1.5 KB");
  assert.equal(formatCpu(35), "3.5%");
  assert.equal(formatCpu(250), "25%");
  assert.equal(moreThatFit({ poolFree: 5792 }, 1500), 3);
  assert.equal(moreThatFit(null, 1500), null);
  assert.equal(appErrorKey("app_budget_exhausted"), "appError_app_budget_exhausted");
  assert.equal(appErrorKey("app_pool_exhausted"), "appError_app_pool_exhausted");
});
