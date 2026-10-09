import assert from "node:assert/strict";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import test from "node:test";

import {
  COMMAND_BLOCKS,
  buildCommandLine,
  findCommandBlock,
  parsePastedCommand,
  tokenizeCommandLine,
} from "../src/lib/terminalCommands.ts";

const TERMINAL_PY = new URL("../../backend/newhorizons_backend/terminal.py", import.meta.url);
const WIKI_DEVICES = new URL("../../wiki/devices/", import.meta.url);

// The help examples the Terminal page shows on every command block card --
// read from the backend so a new example is covered without touching this file.
function backendHelpExamples() {
  const source = readFileSync(TERMINAL_PY, "utf8");
  return [...source.matchAll(/"example":\s*"([^"]+)"/g)].map((match) => match[1]);
}

// Command + option map of a CLI line, independent of option order.
function optionMap(line) {
  const [command, ...args] = tokenizeCommandLine(line);
  const options = {};
  for (let index = 0; index < args.length; index += 2) {
    options[args[index].slice(2)] = args[index + 1];
  }
  return { command, options };
}

function parseOk(text) {
  const parsed = parsePastedCommand(text);
  assert.equal(parsed.ok, true, `${text}: ${JSON.stringify(parsed)}`);
  return parsed;
}

test("every backend help example fills the builder and round-trips", () => {
  const examples = backendHelpExamples();
  assert.ok(examples.length > 60, `only ${examples.length} examples found`);
  for (const example of examples) {
    const parsed = parseOk(example);
    assert.deepEqual(parsed.warnings, [], example);
    assert.deepEqual(parsed.unknownKeys, [], example);
    const built = buildCommandLine(findCommandBlock(parsed.command), parsed.values);
    assert.deepEqual(optionMap(built), optionMap(example), example);
  }
});

test("pasted CLI keeps only what was pasted, not builder defaults", () => {
  const parsed = parseOk("set-log --level info");
  assert.equal(parsed.command, "set-log");
  assert.deepEqual(parsed.values, { level: "info" });
  assert.equal(buildCommandLine(findCommandBlock("set-log"), parsed.values), "set-log --level info");
});

test("IO modal pin command fills set-matrix-layout", () => {
  const parsed = parseOk("set-matrix-layout --analog-pins 1,2 --select-pins 13,14");
  assert.equal(parsed.command, "set-matrix-layout");
  assert.deepEqual(parsed.values, { "analog-pins": "1,2", "select-pins": "13,14" });
});

test("CLI forms: log prefix, snake names, --key=value, quotes and case", () => {
  const fromLog = parseOk("$ log_tail --max_lines 20");
  assert.equal(fromLog.command, "log-tail");
  assert.deepEqual(fromLog.values, { lines: "20" });

  const equals = parseOk("CONFIG-SET --path=scan.target_fps --value='60'");
  assert.equal(equals.command, "config-set");
  assert.deepEqual(equals.values, { path: "scan.target_fps", value: "60" });

  const quoted = parseOk('enter-maintenance --reason "bench \\"test\\" run"');
  assert.deepEqual(quoted.values, { reason: 'bench "test" run' });
  assert.equal(buildCommandLine(findCommandBlock("enter-maintenance"), quoted.values), 'enter-maintenance --reason "bench \\"test\\" run"');

  const continued = parseOk("set-scan-timing --target-fps 75 \\\n  --settle-us 20");
  assert.deepEqual(continued.values, { "target-fps": "75", "settle-us": "20" });

  const sinceSeq = parseOk("app-events --since_seq 4");
  assert.deepEqual(sinceSeq.values, { "since-seq": "4" });
});

test("select values match case-insensitively and booleans normalize", () => {
  const parsed = parseOk("set-log --enabled yes --level INFO --mode Extended");
  assert.deepEqual(parsed.values, { enabled: "true", level: "info", mode: "extended" });

  assert.deepEqual(parseOk("set-imu --enabled off").values, { enabled: "false" });
  assert.deepEqual(parseOk("set-imu --enabled").values, { enabled: "true" });
  assert.deepEqual(parseOk("power-set-state --state soft-off-battery").values, { state: "soft_off_battery" });
});

test("unknown keys, bad options and stray arguments are reported", () => {
  const parsed = parseOk("set-charge-profile --profile compatible --colour red extra");
  assert.deepEqual(parsed.values, {});
  assert.deepEqual(parsed.unknownKeys, ["colour"]);
  assert.deepEqual(
    parsed.warnings.map((warning) => warning.code).sort(),
    ["ignored_argument", "invalid_option", "unknown_param"],
  );

  const number = parseOk("log-tail --lines many");
  assert.deepEqual(number.values, {});
  assert.equal(number.warnings[0].code, "invalid_number");
});

test("local-only commands just select their block", () => {
  assert.equal(parseOk("io-config").command, "io-config");
  assert.equal(parseOk("visualize-io").command, "io-config");
});

test("errors: empty, unknown command, unterminated quote, bad JSON", () => {
  assert.deepEqual(parsePastedCommand("   "), { ok: false, error: "empty" });
  assert.deepEqual(parsePastedCommand("frobnicate --x 1"), { ok: false, error: "unknown_command", detail: "frobnicate" });
  assert.deepEqual(parsePastedCommand('config-set --path "scan.target_fps'), { ok: false, error: "unterminated_quote" });
  assert.deepEqual(parsePastedCommand('{"command": '), { ok: false, error: "invalid_json" });
  assert.deepEqual(parsePastedCommand('{"protocol": "NHO/Arduino/1"}'), { ok: false, error: "missing_command" });
  assert.deepEqual(parsePastedCommand('{"command": "set_battery_profile"}'), { ok: false, error: "unknown_command", detail: "set_battery_profile" });
});

test("wiki JSON: scan timing and matrix layout", () => {
  const timing = parseOk(`{
    "command": "set_scan_timing",
    "protocol": "NHO/Arduino/1",
    "target_fps": 60,
    "settle_us": 20,
    "send_every_n_frames": 1
  }`);
  assert.equal(timing.command, "set-scan-timing");
  assert.deepEqual(timing.values, { "target-fps": "60", "settle-us": "20", "send-every-n-frames": "1" });
  assert.deepEqual(timing.warnings, []);

  const layout = parseOk('{"command": "set_matrix_layout", "protocol": "NHO/Arduino/1", "analog_pins": [1, 2, 3], "select_pins": [13, 14]}');
  assert.deepEqual(layout.values, { "analog-pins": "1,2,3", "select-pins": "13,14" });
});

test("wiki JSON: booleans and nested set_indicators objects flatten", () => {
  const stream = parseOk('{"command": "set_stream_buffer", "protocol": "NHO/Arduino/1", "enabled": true, "mode": "standard", "request_id": "r1", "quiet": false}');
  assert.deepEqual(stream.values, { enabled: "true", mode: "standard" });
  assert.deepEqual(stream.unknownKeys, []);

  const led = parseOk('{"command": "set_indicators", "protocol": "NHO/Arduino/1", "external_led": {"mode": "enabled", "preset": "system_status", "color": "teal", "brightness": 0.35}}');
  assert.deepEqual(led.values, {
    "external-led-mode": "enabled",
    preset: "system_status",
    "external-led-color": "teal",
    brightness: "0.35",
  });
  assert.equal(
    buildCommandLine(findCommandBlock("set-indicators"), led.values),
    "set-indicators --external-led-mode enabled --preset system_status --external-led-color teal --brightness 0.35",
  );

  // The wiki's OLED sample uses mode "on" (not a builder option) and rotation
  // (not a builder field): both are reported instead of guessed.
  const oled = parseOk('{"command": "set_indicators", "oled": {"mode": "on", "page": "live_status", "update_hz": 1, "contrast": 128, "rotation": 0}}');
  assert.deepEqual(oled.values, { "oled-page": "live_status", "oled-update-hz": "1", "oled-contrast": "128" });
  assert.deepEqual(oled.unknownKeys, ["oled.rotation"]);
  assert.deepEqual(oled.warnings.map((warning) => warning.code).sort(), ["invalid_option", "unknown_param"]);

  const time = parseOk('{"command": "set_time", "epoch": 1780000000000}');
  assert.deepEqual(time.values, { "epoch-ms": "1780000000000" });
  const chunk = parseOk('{"command": "file_write_chunk", "path": "a.bin", "data_hex": "4e48"}');
  assert.deepEqual(chunk.values, { path: "a.bin", data: "4e48" });
});

test("every wiki JSON command sample fills the builder", () => {
  if (!existsSync(WIKI_DEVICES)) return;
  let checked = 0;
  for (const device of readdirSync(WIKI_DEVICES)) {
    const dir = new URL(`${device}/en/`, WIKI_DEVICES);
    if (!existsSync(dir)) continue;
    for (const file of readdirSync(dir).filter((name) => name.endsWith(".md"))) {
      const text = readFileSync(new URL(file, dir), "utf8");
      for (const match of text.matchAll(/```json\n([\s\S]*?)```/g)) {
        let data;
        try {
          data = JSON.parse(match[1]);
        } catch {
          continue; // placeholders such as "<cmd>" in the protocol overview
        }
        if (!data || typeof data.command !== "string") continue;
        const parsed = parseOk(match[1]);
        assert.equal(parsed.command, data.command.replace(/_/g, "-"), `${device}/${file}`);
        checked += 1;
      }
    }
  }
  assert.ok(checked > 0);
});

test("every block's keys are kebab-case and its select defaults are real options", () => {
  for (const block of COMMAND_BLOCKS) {
    for (const param of block.params) {
      assert.match(param.key, /^[a-z0-9]+(-[a-z0-9]+)*$/, `${block.command} ${param.key}`);
      if (param.type === "select" && param.defaultValue) {
        assert.ok(param.options.some((option) => option.value === param.defaultValue), `${block.command} ${param.key}`);
      }
    }
  }
});
