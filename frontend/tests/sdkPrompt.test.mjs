import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "vite";

// Through Vite, not a plain import: the prompt quotes the authoring guide and
// example apps with ?raw imports.
async function load() {
  const server = await createServer({ root: process.cwd(), logLevel: "error" });
  try {
    return {
      prompt: await server.ssrLoadModule("/src/lib/sdkPrompt.ts"),
      project: await server.ssrLoadModule("/src/lib/sdkProject.ts"),
      sdk: await server.ssrLoadModule("/src/sdk/lib/index.mjs"),
    };
  } finally {
    await server.close();
  }
}

const modules = load();

const CURRENT = `app broken {
  name "Broken"
  version 0.1.0
  author me
  summary "Does not build."
}
signal load = wobble(front)
`;

async function flowPrompt(overrides = {}) {
  const { prompt, project } = await modules;
  const board = project.boardById("v15f");
  return prompt.buildAiPrompt({
    kind: "flow",
    request: "Count taps on the front half and flash the LED green on each tap.",
    board: { rows: board.rows, cols: board.cols, board, label: "Virtual device" },
    includeCurrent: true,
    source: CURRENT,
    diagnostics: [{ severity: "error", message: "unknown function wobble", line: 7, col: 15, code: null }],
    author: "tester",
    ...overrides,
  });
}

test("a flow prompt states the SDK's own limits and the target board", async () => {
  const { sdk } = await modules;
  const text = await flowPrompt();

  assert.match(text, new RegExp(`At most ${sdk.MAX_NODES} nodes`));
  assert.match(text, new RegExp(`at most ${sdk.MAX_PACKAGE_BYTES} bytes`));
  assert.match(text, new RegExp(`at most ${sdk.MAX_WINDOW}; all windows in one app together at most ${sdk.WINDOW_POOL}`));
  assert.match(text, new RegExp(`within ${sdk.DEFAULT_BUDGET_US} µs per frame`));
  assert.match(text, new RegExp(`at most ${sdk.MAX_OLED_LABEL} printable ASCII`));
  assert.match(text, /14 rows x 14 columns \(196 cells\)/);
  assert.match(text, /External LED strip: 9 pixels/);
  assert.match(text, /Use `tester` as the author/);
});

test("a flow prompt carries the language reference, the guide and the examples", async () => {
  const { sdk } = await modules;
  const text = await flowPrompt();

  for (const op of ["region_sum", "threshold", "debounce", "emit_value", "oled_text", "ext_pixel", "peak_since", "imu"]) {
    assert.ok(text.includes(`\`${op}\``), `op ${op} missing`);
    assert.ok(text.includes(sdk.OPS[op].summary), `summary of ${op} missing`);
  }
  for (const name of sdk.LANGUAGE.functions) assert.ok(text.includes(`\`${name}(`), `function ${name} missing`);
  for (const field of sdk.IMU_FIELDS) assert.ok(text.includes(`\`${field}\``), `imu field ${field} missing`);
  assert.ok(text.includes("`peak()` or `peak(region)`"));
  assert.ok(text.includes("signal <name> = <expression> [persist]"));
  assert.match(text, /<authoring_guide>\n# Writing an NHOS app[\s\S]*<\/authoring_guide>/);
  assert.match(text, /### steps\n```nhs\n[\s\S]*app steps \{/);
  assert.match(text, /### tilt\n```nhs\n/);
  assert.match(text, /### mat_view\n```nhs\n/);
});

test("the output contract asks for exactly one fenced block", async () => {
  const text = await flowPrompt();
  assert.ok(text.includes("exactly ONE fenced code block tagged `nhs`"));
  assert.ok(text.trimEnd().endsWith("Remember: one ```nhs block, nothing before it, at most three short lines after it."));
});

test("the request is quoted, and the current program and its errors only when asked", async () => {
  const withCurrent = await flowPrompt();
  assert.ok(withCurrent.includes("Count taps on the front half and flash the LED green on each tap."));
  assert.ok(withCurrent.includes("## Current program"));
  assert.ok(withCurrent.includes("signal load = wobble(front)"));
  assert.ok(withCurrent.includes("line 7:15 — error: unknown function wobble"));

  const without = await flowPrompt({ includeCurrent: false });
  assert.ok(without.includes("Count taps on the front half"));
  assert.ok(!without.includes("## Current program"));
  assert.ok(!without.includes("wobble"));
});

test("an empty request still gives the model a task", async () => {
  const fix = await flowPrompt({ request: "  " });
  assert.match(fix, /Fix the current program below so it builds/);
  const fresh = await flowPrompt({ request: "", includeCurrent: false });
  assert.match(fresh, /Write a small, useful app for this board/);
});

test("a board without an OLED, button or strip says so", async () => {
  const { project } = await modules;
  const board = project.boardById("v23d");
  const text = await flowPrompt({ board: { rows: board.rows, cols: board.cols, board } });
  assert.match(text, /15 rows x 15 columns \(225 cells\)/);
  assert.match(text, /OLED: none/);
  assert.match(text, /Action button: none/);
  assert.match(text, /External LED strip: none/);
});

test("an unknown board falls back to its label and the matrix", async () => {
  const text = await flowPrompt({ board: { rows: 8, cols: 6, label: "Lab device", firmware: "v1.4.0" } });
  assert.match(text, /Board: Lab device/);
  assert.match(text, /Firmware on the device: v1\.4\.0/);
  assert.match(text, /8 rows x 6 columns \(48 cells\)/);
});

test("a source holding backticks cannot close its fence early", async () => {
  const text = await flowPrompt({ source: "# ```oops```\napp a {}\n" });
  assert.ok(text.includes("````nhs\n# ```oops```\napp a {}\n````"));
});

test("a readout prompt uses the readout reference and examples, not the flow guide", async () => {
  const { prompt, project, sdk } = await modules;
  const board = project.boardById("v15f");
  const source = '{ "nhapp": 1 }\n';
  const text = prompt.buildAiPrompt({
    kind: "readout",
    request: "Chart the battery voltage.",
    board: { rows: board.rows, cols: board.cols, board },
    includeCurrent: true,
    source,
    diagnostics: [{ severity: "error", message: "missing_manifest", line: null, col: null, code: "missing_manifest" }],
  });

  assert.ok(text.includes("exactly ONE fenced code block tagged `json`"));
  for (const command of sdk.readoutset.ALLOWED_SOURCES) assert.ok(text.includes(`\`${command}\``), command);
  for (const kind of sdk.readoutset.SECTION_KINDS) assert.ok(text.includes(`"kind": "${kind}"`), kind);
  assert.ok(text.includes(`At most ${sdk.readoutset.MAX_SOURCES} sources`));
  assert.ok(text.includes(`${sdk.readoutset.MIN_REFRESH_MS}..${sdk.readoutset.MAX_REFRESH_MS}`));
  assert.match(text, /### sysmon\n```json\n/);
  assert.match(text, /### sensors\n```json\n/);
  assert.ok(text.includes("## Current readout"));
  assert.ok(text.includes("whole app — error: missing_manifest [missing_manifest]"));
  assert.ok(!text.includes("<authoring_guide>"));
});

test("the prompt is deterministic", async () => {
  assert.equal(await flowPrompt(), await flowPrompt());
});

test("every vendored example builds with the vendored SDK", async () => {
  const { prompt, sdk } = await modules;
  for (const example of prompt.FLOW_EXAMPLES) {
    const analysis = sdk.analyzeFlow(example.source);
    assert.ok(analysis.ok, `${example.id}: ${JSON.stringify(analysis.diagnostics)}`);
  }
  for (const example of prompt.READOUT_EXAMPLES) {
    const analysis = sdk.analyzeReadout(example.source);
    assert.ok(analysis.ok, `${example.id}: ${JSON.stringify(analysis.diagnostics)}`);
  }
});
