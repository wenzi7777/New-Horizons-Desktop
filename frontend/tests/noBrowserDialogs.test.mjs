import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

// The app asks with its own dialogs (ConfirmModal) and its own dropdowns
// (components/Select.tsx); the browser's look out of place and ignore the theme.
function sources(dir) {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sources(path);
    return /\.tsx?$/.test(name) ? [path] : [];
  });
}

test("no browser alert, confirm or prompt, and no native select", () => {
  const offenders = [];
  for (const path of sources(new URL("../src", import.meta.url).pathname)) {
    const source = readFileSync(path, "utf8");
    if (/(?<![\w.])(?:window\.)?(?:alert|confirm|prompt)\s*\(/.test(source)) offenders.push(`${path}: browser dialog`);
    // Select.tsx itself names <select> in its comment.
    if (!path.endsWith("Select.tsx") && /<select[\s>]/.test(source)) offenders.push(`${path}: native <select>`);
  }
  assert.deepEqual(offenders, []);
});
