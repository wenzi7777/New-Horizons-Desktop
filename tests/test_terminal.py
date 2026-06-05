import sys
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
BACKEND_ROOT = ROOT / "backend"
if str(BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(BACKEND_ROOT))

from newhorizons_backend.terminal import compile_terminal_command, terminal_help_items, validate_device_command_payload  # noqa: E402


TERMINAL_PAGE = ROOT / "frontend" / "src" / "pages" / "TerminalPage.tsx"


class DeviceCommandValidationTest(unittest.TestCase):
    def test_memory_status_is_allowed(self):
        payload = validate_device_command_payload({"command": "memory_status", "request_id": "req-memory"})

        self.assertEqual(payload["command"], "memory_status")
        self.assertEqual(payload["request_id"], "req-memory")

    def test_scan_health_is_allowed_and_compiles_from_terminal(self):
        payload = validate_device_command_payload({"command": "scan_health", "request_id": "req-health"})
        compiled = compile_terminal_command("scan-health")

        self.assertEqual(payload["command"], "scan_health")
        self.assertEqual(payload["request_id"], "req-health")
        self.assertEqual(compiled["payload"]["command"], "scan_health")

    def test_storage_status_is_allowed_and_compiles_from_terminal(self):
        payload = validate_device_command_payload({"command": "storage_status", "request_id": "req-storage"})
        compiled = compile_terminal_command("storage-status")

        self.assertEqual(payload["command"], "storage_status")
        self.assertEqual(payload["request_id"], "req-storage")
        self.assertEqual(compiled["payload"]["command"], "storage_status")

    def test_manual_calibration_commands_are_allowed_and_compile_from_terminal(self):
        for command in (
            "calibration_status",
            "calibration_enable",
            "calibration_disable",
            "calibration_clear_profile",
            "calibration_session_begin",
            "calibration_session_abort",
            "calibration_session_commit",
            "calibration_dump_level",
            "calibration_delete_level",
            "calibration_capture_cell",
            "calibration_capture_all",
        ):
            with self.subTest(command=command):
                payload = validate_device_command_payload({"command": command, "request_id": f"req-{command}"})
                self.assertEqual(payload["command"], command)

        dump_level = compile_terminal_command("calibration-dump-level --level 10")
        delete_level = compile_terminal_command("calibration-delete-level --level 10")
        capture_cell = compile_terminal_command("calibration-capture-cell --sensor-index 3 --level 10 --duration-ms 2500")
        capture_all = compile_terminal_command("calibration-capture-all --level 10 --duration-ms 2500")
        session_begin = compile_terminal_command("calibration-session-begin")
        session_commit = compile_terminal_command("calibration-session-commit --auto-enable true")

        self.assertEqual(dump_level["payload"]["command"], "calibration_dump_level")
        self.assertEqual(delete_level["payload"]["command"], "calibration_delete_level")
        self.assertEqual(capture_cell["payload"]["command"], "calibration_capture_cell")
        self.assertEqual(capture_cell["payload"]["sensor_index"], 3)
        self.assertEqual(capture_all["payload"]["command"], "calibration_capture_all")
        self.assertEqual(session_begin["payload"]["command"], "calibration_session_begin")
        self.assertEqual(session_commit["payload"]["command"], "calibration_session_commit")
        self.assertEqual(session_commit["payload"]["auto_enable"], True)

    def test_charge_profile_is_allowed_and_compiles_from_terminal(self):
        payload = validate_device_command_payload({"command": "set_charge_profile", "profile": "compatible", "request_id": "req-charge"})
        compiled = compile_terminal_command("set-charge-profile --profile fast")

        self.assertEqual(payload["command"], "set_charge_profile")
        self.assertEqual(payload["profile"], "compatible")
        self.assertEqual(compiled["payload"]["command"], "set_charge_profile")
        self.assertEqual(compiled["payload"]["profile"], "fast")

        for legacy_profile in ("safe_default", "fast_800mah_only"):
            with self.subTest(profile=legacy_profile):
                with self.assertRaisesRegex(ValueError, "invalid_charge_profile"):
                    compile_terminal_command(f"set-charge-profile --profile {legacy_profile}")

    def test_recovery_update_commands_are_removed_from_terminal(self):
        removed_commands = (
            "check_os_release",
            "write_os",
            "check_recovery_release",
            "write_recovery",
            "reboot_to_os",
            "reboot_to_recovery",
            "release_recovery_resources",
        )
        for command in removed_commands:
            with self.subTest(command=command):
                with self.assertRaisesRegex(ValueError, "unknown_command"):
                    validate_device_command_payload({"command": command, "request_id": "req-old"})

        for command_line in ("check-os-release", "write-os", "check-recovery-release", "write-recovery", "reboot-to-os", "reboot-to-recovery", "boot-minimal"):
            with self.subTest(command_line=command_line):
                with self.assertRaisesRegex(ValueError, "unknown_command"):
                    compile_terminal_command(command_line)

    def test_arduino_update_commands_are_allowed_and_compile_from_terminal(self):
        check_payload = validate_device_command_payload({"command": "check_update", "request_id": "req-check"})
        apply_payload = validate_device_command_payload({"command": "apply_update", "request_id": "req-apply"})
        compiled_check = compile_terminal_command("check-update")
        compiled_apply = compile_terminal_command("apply-update")

        self.assertEqual(check_payload["command"], "check_update")
        self.assertEqual(apply_payload["command"], "apply_update")
        self.assertEqual(compiled_check["payload"]["command"], "check_update")
        self.assertEqual(compiled_apply["payload"]["command"], "apply_update")

    def test_service_control_is_not_exposed_by_default(self):
        with self.assertRaisesRegex(ValueError, "unknown_command"):
            validate_device_command_payload({
                "command": "service_control",
                "service": "matrix_scan",
                "action": "restart",
                "request_id": "req-service",
            })

        with self.assertRaisesRegex(ValueError, "unknown_command"):
            compile_terminal_command("service-control --service matrix_scan --action restart")

    def test_scan_timing_compiles_full_runtime_controls(self):
        compiled = compile_terminal_command("set-scan-timing --target-fps 75 --settle-us 18 --send-every-n-frames 3")

        self.assertEqual(compiled["payload"]["command"], "set_scan_timing")
        self.assertEqual(compiled["payload"]["target_fps"], 75)
        self.assertEqual(compiled["payload"]["settle_us"], 18)
        self.assertEqual(compiled["payload"]["send_every_n_frames"], 3)

    def test_set_imu_compiles_enabled_flag(self):
        compiled = compile_terminal_command("set-imu --enabled false")
        payload = validate_device_command_payload(compiled["payload"])

        self.assertEqual(compiled["payload"], {"command": "set_imu", "enabled": False})
        self.assertEqual(payload["command"], "set_imu")

    def test_power_set_state_is_allowed_and_compiles_from_terminal(self):
        payload = validate_device_command_payload({"command": "power_set_state", "state": "soft_off_auto", "request_id": "req-power"})
        compiled = compile_terminal_command("power-set-state --state normal")

        self.assertEqual(payload["command"], "power_set_state")
        self.assertEqual(payload["state"], "soft_off_auto")
        self.assertEqual(compiled["payload"]["command"], "power_set_state")
        self.assertEqual(compiled["payload"]["state"], "normal")

    def test_set_indicators_compiles_external_led_and_oled_modes(self):
        compiled = compile_terminal_command(
            "set-indicators --external-led-mode enabled --preset stream_health --brightness 0.35 "
            "--oled-mode auto --oled-page live_status --oled-update-hz 1 --oled-contrast 128"
        )
        payload = validate_device_command_payload(compiled["payload"])

        self.assertEqual(payload["command"], "set_indicators")
        self.assertEqual(payload["external_led"]["mode"], "enabled")
        self.assertEqual(payload["external_led"]["preset"], "stream_health")
        self.assertEqual(payload["oled"]["mode"], "auto")
        self.assertEqual(payload["oled"]["page"], "live_status")

        identify = compile_terminal_command("set-indicators --external-led-mode enabled --preset identify")
        identify_payload = validate_device_command_payload(identify["payload"])
        self.assertEqual(identify_payload["external_led"]["preset"], "identify")

    def test_set_indicators_terminal_help_and_prompt_call_out_decimal_brightness(self):
        item = next(entry for entry in terminal_help_items() if entry["command"] == "set-indicators")
        source = TERMINAL_PAGE.read_text(encoding="utf-8")

        self.assertIn("0.10", item["description"])
        self.assertIn("--brightness 0.35", item["example"])
        self.assertIn('placeholder: "0.10, 0.20, 0.35, 0.50, 1.00"', source)

    def test_terminal_uses_arduino_file_read_write_commands(self):
        read_begin = compile_terminal_command("file-read-begin --scope logs --path device.log")
        read_chunk = compile_terminal_command("file-read-chunk --scope logs --path device.log --offset 0 --length 128")
        write_begin = compile_terminal_command("file-write-begin --scope user --path configs/profile.json --size 2 --sha256 deadbeef")
        write_chunk = compile_terminal_command("file-write-chunk --scope user --path configs/profile.json --offset 0 --data 4e48")
        write_finish = compile_terminal_command("file-write-finish --scope user --path configs/profile.json")

        self.assertEqual(read_begin["payload"]["command"], "file_read_begin")
        self.assertEqual(read_chunk["payload"]["command"], "file_read_chunk")
        self.assertEqual(write_begin["payload"]["command"], "file_write_begin")
        self.assertEqual(write_chunk["payload"]["command"], "file_write_chunk")
        self.assertEqual(write_finish["payload"]["command"], "file_write_finish")

        for command in ("file_upload_begin", "file_upload_chunk", "file_upload_finish", "file_download_begin", "file_download_chunk"):
            with self.subTest(command=command):
                with self.assertRaisesRegex(ValueError, "unknown_command"):
                    validate_device_command_payload({"command": command, "request_id": "req-old-file"})


if __name__ == "__main__":
    unittest.main()
