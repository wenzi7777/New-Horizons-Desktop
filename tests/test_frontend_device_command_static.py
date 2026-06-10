import subprocess
import textwrap
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
FRONTEND_ROOT = ROOT / "frontend"
COMMAND_RESULT_LIB = FRONTEND_ROOT / "src" / "lib" / "commandResult.ts"
DEVICE_COMMAND_LIB = FRONTEND_ROOT / "src" / "lib" / "deviceCommand.ts"


class FrontendDeviceCommandStaticTest(unittest.TestCase):
    def test_device_command_uses_shared_result_normalizer(self):
        source = DEVICE_COMMAND_LIB.read_text(encoding="utf-8")

        self.assertIn('from "./commandResult"', source)
        self.assertIn("normalizeCommandResult", source)
        self.assertIn("result: normalizeCommandResult(response.result)", source)
        self.assertIn("return normalizeCommandResult(result)", source)

    def test_shared_result_normalizer_flattens_transport_envelope(self):
        script = textwrap.dedent(
            """
            const assert = require("node:assert/strict");
            const fs = require("node:fs");
            const ts = require("typescript");

            const source = fs.readFileSync("src/lib/commandResult.ts", "utf8");
            const output = ts.transpileModule(source, {
              compilerOptions: {
                module: ts.ModuleKind.CommonJS,
                target: ts.ScriptTarget.ES2020,
              },
            }).outputText;
            const module = { exports: {} };
            new Function("exports", "module", output)(module.exports, module);
            const { normalizeCommandResult } = module.exports;

            const flattened = normalizeCommandResult({
              ok: true,
              cmd: "file_read_chunk",
              message: "file_read_chunk",
              error: "",
              request_id: "req-1",
              data: {
                data: "68656c6c6f",
                next_offset: 5,
                has_more: false,
              },
            });
            assert.equal(flattened.command, "file_read_chunk");
            assert.equal(flattened.cmd, "file_read_chunk");
            assert.equal(flattened.message, "file_read_chunk");
            assert.equal(flattened.error, "");
            assert.equal(flattened.request_id, "req-1");
            assert.equal(flattened.data, "68656c6c6f");
            assert.equal(flattened.next_offset, 5);
            assert.equal(flattened.has_more, false);

            const passthrough = { command: "status", ok: true, message: "status", battery: { level: 90 } };
            assert.deepEqual(normalizeCommandResult(passthrough), passthrough);
            """
        )

        result = subprocess.run(
            ["node", "-e", script],
            cwd=FRONTEND_ROOT,
            text=True,
            capture_output=True,
            check=False,
        )

        self.assertEqual(result.returncode, 0, result.stderr or result.stdout)


if __name__ == "__main__":
    unittest.main()
