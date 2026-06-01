import subprocess
import textwrap
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
FRONTEND_ROOT = ROOT / "frontend"


class FrontendWebSocketErrorPolicyTest(unittest.TestCase):
    def test_request_scoped_command_error_is_not_global_connection_error(self):
        script = textwrap.dedent(
            """
            const assert = require("node:assert/strict");
            const fs = require("node:fs");
            const ts = require("typescript");

            const source = fs.readFileSync("src/lib/wsErrorPolicy.ts", "utf8");
            const output = ts.transpileModule(source, {
              compilerOptions: {
                module: ts.ModuleKind.CommonJS,
                target: ts.ScriptTarget.ES2020,
              },
            }).outputText;
            const module = { exports: {} };
            new Function("exports", "module", output)(module.exports, module);
            const { shouldPublishGlobalWsError } = module.exports;

            assert.equal(
              shouldPublishGlobalWsError({ type: "error", request_id: "req-1", message: "Device control is reconnecting; try again in a few seconds." }, true),
              false,
            );
            assert.equal(
              shouldPublishGlobalWsError({ type: "error", request_id: "req-1", message: "Device control is reconnecting; try again in a few seconds." }, false),
              false,
            );
            assert.equal(
              shouldPublishGlobalWsError({ type: "error", code: "websocket_error", message: "websocket_error" }, false),
              true,
            );
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
