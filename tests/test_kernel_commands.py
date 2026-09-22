"""Regression tests for the v1.0.0 kernel-layer command surface.

Every one of these commands shipped in the firmware and was listed in the
terminal help, yet none of them could be executed: `compile_terminal_command`
had no branch for them (HTTP 400 before a payload was built), and
`_boot_command_mode_error_for_status` derived "does this command exist" from
the mode-gating sets, which did not list them either.

The drift guards at the bottom are the point of this file -- the per-command
assertions would have to be extended by hand for a new command, but the guards
fail on their own the next time the two allowlists diverge.
"""

import sys
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
BACKEND_ROOT = ROOT / "backend"
if str(BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(BACKEND_ROOT))

from newhorizons_backend.service import NewHorizonsService  # noqa: E402
from newhorizons_backend.terminal import (  # noqa: E402
    DEVICE_COMMAND_ALLOWLIST,
    compile_terminal_command,
    terminal_help_items,
    validate_device_command_payload,
)


# command line -> firmware command name
#
# v1.1.0 renamed the engine from "rule" to "flow" and kept no aliases, so these
# are the only spellings that exist.
KERNEL_COMMANDS = {
    "task-list": "task_list",
    "service-list": "service_list",
    "service-restart --name wifi": "service_restart",
    "dmesg": "dmesg",
    "crash-log": "crash_log",
    "crash-clear": "crash_clear",
    "capabilities": "capabilities",
    "config-schema": "config_schema",
    "config-get --path scan.target_fps": "config_get",
    "config-set --path scan.target_fps --value 60": "config_set",
    "set-time --epoch-ms 1716026905000": "set_time",
    "set-power-profile --profile balanced": "set_power_profile",
    "app-list": "app_list",
    "app-enable --name flow": "app_enable",
    "app-disable --name flow1": "app_disable",
    "app-revive --name flow": "app_revive",
    "app-load-flow --path apps/flow.json": "app_load_flow",
    "app-unload-flow": "app_unload_flow",
}

# Terminal entries handled entirely in the browser -- they open a local modal and
# never reach a device, so they have no compiler branch by design.
LOCAL_ONLY_TERMINAL_COMMANDS = {"io-config", "visualize-io"}


class KernelCommandCompilationTests(unittest.TestCase):
    def test_every_kernel_command_compiles(self):
        for line, expected in KERNEL_COMMANDS.items():
            with self.subTest(line=line):
                compiled = compile_terminal_command(line)
                self.assertEqual(compiled["command"], expected)
                self.assertEqual(compiled["payload"]["command"], expected)

    def test_every_kernel_command_validates(self):
        for line, expected in KERNEL_COMMANDS.items():
            with self.subTest(line=line):
                payload = compile_terminal_command(line)["payload"]
                self.assertEqual(validate_device_command_payload(payload)["command"], expected)

    def test_optional_arguments_are_omitted_not_defaulted(self):
        # The firmware treats an absent path as "dump everything" / "use the
        # default file"; inventing a default here would change its meaning.
        self.assertNotIn("path", compile_terminal_command("config-get")["payload"])
        self.assertNotIn("path", compile_terminal_command("app-load-flow")["payload"])


class KernelCommandModeGateTests(unittest.TestCase):
    def test_kernel_commands_pass_the_mode_gate(self):
        for line, command in KERNEL_COMMANDS.items():
            for status in ({"mode": "normal"}, {"mode": "maintenance"}, {}):
                with self.subTest(command=command, status=status):
                    error = NewHorizonsService._boot_command_mode_error_for_status(
                        status, {"command": command}
                    )
                    self.assertEqual(error, "", f"{command} rejected as {error!r}")

    def test_unknown_commands_are_still_rejected(self):
        self.assertEqual(
            NewHorizonsService._boot_command_mode_error_for_status(
                {"mode": "normal"}, {"command": "definitely_not_a_command"}
            ),
            "unknown_command",
        )

    def test_missing_command_is_not_reported_as_unknown(self):
        self.assertEqual(
            NewHorizonsService._boot_command_mode_error_for_status({"mode": "normal"}, {}),
            "",
        )


class CommandAllowlistDriftTests(unittest.TestCase):
    """The guards that would have caught both blockers."""

    def test_every_allowlisted_command_is_reachable_in_some_mode(self):
        known = set()
        for commands in NewHorizonsService.MODE_COMMANDS.values():
            known.update(commands)
        missing = sorted(DEVICE_COMMAND_ALLOWLIST - known)
        self.assertEqual(
            missing, [], f"allowlisted but gated out of every mode: {missing}"
        )

    def test_every_mode_gated_command_is_a_known_command(self):
        known = set()
        for commands in NewHorizonsService.MODE_COMMANDS.values():
            known.update(commands)
        unknown = sorted(known - NewHorizonsService.KNOWN_DEVICE_COMMANDS)
        self.assertEqual(
            unknown, [], f"mode-gated but rejected as unknown: {unknown}"
        )

    def test_every_documented_terminal_command_compiles(self):
        failures = []
        for item in terminal_help_items():
            name = str(item.get("command") or "").strip()
            if name in LOCAL_ONLY_TERMINAL_COMMANDS:
                continue
            example = str(item.get("example") or name)
            try:
                compile_terminal_command(example)
            except Exception as exc:  # noqa: BLE001 - the message is the report
                failures.append((example, str(exc)))
        self.assertEqual(failures, [], f"help lists commands that cannot run: {failures}")


class ProcScopeTests(unittest.TestCase):
    def test_proc_scope_is_readable(self):
        payload = compile_terminal_command("file-list --scope proc")["payload"]
        self.assertEqual(validate_device_command_payload(payload)["scope"], "proc")

    def test_proc_scope_is_rejected_for_writes(self):
        for command in ("file_write_begin", "file_write_chunk", "file_write_finish", "file_delete"):
            with self.subTest(command=command):
                with self.assertRaises(ValueError) as ctx:
                    validate_device_command_payload(
                        {"command": command, "scope": "proc", "path": "apps"}
                    )
                self.assertEqual(str(ctx.exception), "read_only_scope")

    def test_unknown_scope_is_still_rejected(self):
        with self.assertRaises(ValueError) as ctx:
            validate_device_command_payload({"command": "file_list", "scope": "nowhere"})
        self.assertEqual(str(ctx.exception), "invalid_scope")


if __name__ == "__main__":
    unittest.main()
