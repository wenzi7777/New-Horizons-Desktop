import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
SETTINGS_PAGE = ROOT / "frontend" / "src" / "pages" / "DeviceSettingsPage.tsx"
DEVICE_LIB = ROOT / "frontend" / "src" / "lib" / "device.ts"
DEVICE_COMMAND_LIB = ROOT / "frontend" / "src" / "lib" / "deviceCommand.ts"
APP_TSX = ROOT / "frontend" / "src" / "App.tsx"
STYLES = ROOT / "frontend" / "src" / "styles.css"
SERVICE = ROOT / "backend" / "newhorizons_backend" / "service.py"


class DeviceSettingsPageStaticTest(unittest.TestCase):
    def test_settings_page_keeps_original_operational_layout(self):
        source = SETTINGS_PAGE.read_text()

        for key in (
            't("scanPerformance")',
            't("currentScanTiming")',
            't("gatewayTitle")',
            't("externalLedIndicators")',
            't("ssd1306Display")',
            't("streamDiagnostics")',
            't("imuDiagnostics")',
            't("logSettings")',
            't("autoOtaOnBoot")',
        ):
            self.assertIn(key, source)

        self.assertIn("scan-timing-row", source)
        self.assertIn("segmented-control", source)
        self.assertIn("metric-row", source)
        self.assertIn("settings-shell", source)
        self.assertIn("settings-sidebar", source)
        self.assertIn("settings-detail", source)
        self.assertIn("activeSection", source)
        self.assertNotIn('className="kv-list"', source)

    def test_settings_page_exposes_board_io_visualizer(self):
        source = SETTINGS_PAGE.read_text()

        self.assertIn("BoardIoModal", source)
        self.assertIn('t("ioConfigOpen")', source)
        self.assertIn("setShowIoModal", source)

    def test_settings_page_has_no_secondary_header_nav(self):
        source = SETTINGS_PAGE.read_text()

        self.assertNotIn("page-header-actions", source)
        self.assertNotIn('className="device-settings-subnav"', source)

    def test_settings_sidebar_is_single_label_and_scan_io_live_under_pins(self):
        source = SETTINGS_PAGE.read_text()

        self.assertNotIn('| "scan"', source)
        self.assertNotIn('| "io"', source)
        self.assertNotIn("detail:", source)
        self.assertNotIn("<span>{section.detail}</span>", source)
        self.assertNotIn('activeSection === "scan"', source)
        self.assertNotIn('activeSection === "io"', source)
        self.assertIn('activeSection === "pins"', source)
        self.assertIn('t("scanPerformance")', source)
        self.assertIn('t("ioConfigOpen")', source)

    def test_settings_gateway_section_shows_heartbeat_state(self):
        source = SETTINGS_PAGE.read_text()

        self.assertIn('t("heartbeat")', source)
        self.assertIn("heartbeat_interval_ms", source)
        self.assertIn("last_heartbeat_at", source)
        self.assertIn("transport_path", source)

    def test_diagnostics_overview_does_not_render_service_or_heap_cards(self):
        source = SETTINGS_PAGE.read_text()

        self.assertNotIn('t("runningServices")', source)
        self.assertNotIn("overviewHeapFree", source)
        self.assertNotIn('t("deviceRam")', source)
        self.assertNotIn("scanHealth.resource_state", source)
        self.assertNotIn('command: "service_control"', source)
        self.assertIn('command: "memory_status"', source)

    def test_diagnostics_stream_backpressure_uses_arduino_scan_udp_health(self):
        source = SETTINGS_PAGE.read_text()

        for field in (
            "scanHealthSource",
            "actual_scan_fps",
            "overrun_frames",
            "udp_sent_frames",
            "udp_send_failures",
            "last_udp_send_us",
        ):
            self.assertIn(field, source)

    def test_diagnostics_ram_monitor_is_manual_and_polling(self):
        source = SETTINGS_PAGE.read_text()

        self.assertIn("ramMonitorEnabled", source)
        self.assertIn("ramUsedPercent", source)
        self.assertIn("ram-bar-track", source)
        self.assertIn("heap_total", source)
        self.assertIn("setRamMonitorEnabled", source)
        self.assertIn("window.setInterval", source)
        self.assertIn("window.clearInterval", source)
        self.assertIn("3000", source)
        self.assertIn('command: "memory_status"', source)
        self.assertIn('t("viewRam")', source)
        self.assertIn('t("closeRam")', source)

    def test_diagnostics_exposes_bq25180_charge_profile_controls(self):
        source = SETTINGS_PAGE.read_text()

        self.assertIn("batteryStatus", source)
        self.assertIn("chargeProfile", source)
        self.assertIn('command: "set_charge_profile"', source)
        self.assertIn('"compatible"', source)
        self.assertIn('"fast"', source)
        self.assertNotIn("safe_default", source)
        self.assertNotIn("fast_800mah_only", source)
        self.assertIn('t("compatibleChargingMode")', source)
        self.assertIn('t("fastChargingMode")', source)
        self.assertIn('isCommandBusy("set_charge_profile")', source)

    def test_diagnostics_exposes_power_state_controls_and_status_metrics(self):
        source = SETTINGS_PAGE.read_text()

        self.assertIn("powerStatus", source)
        self.assertIn("powerState", source)
        self.assertIn('command: "power_set_state"', source)
        self.assertIn("softOffAuto", source)
        self.assertIn("wakeSource", source)
        self.assertIn("softOffReason", source)
        self.assertIn("chargerPresent", source)
        self.assertIn("chargeState", source)
        self.assertIn('isCommandBusy("power_set_state")', source)

    def test_indicators_use_external_ws2812b_and_ssd1306_modes_from_status(self):
        source = SETTINGS_PAGE.read_text()
        profile_source = (ROOT / "frontend" / "src" / "lib" / "boardProfile.ts").read_text(encoding="utf-8")
        i18n = (ROOT / "frontend" / "src" / "i18n.tsx").read_text(encoding="utf-8")

        self.assertIn("externalLedMode", source)
        self.assertIn("oledMode", source)
        self.assertIn('value="off"', source)
        self.assertIn('value="enabled"', source)
        self.assertIn('value="auto"', source)
        self.assertIn('command: "set_indicators"', source)
        self.assertIn('external_led: { mode: externalLedMode', source)
        self.assertIn('oled: { mode: oledMode', source)
        self.assertIn("externalLed.preset", source)
        self.assertIn("oled.mode", source)
        self.assertIn("externalLedPreset", source)
        self.assertIn('t("testExternalLed")', source)
        self.assertIn('preset: "identify"', source)
        self.assertIn("externalLed.pin", source)
        self.assertIn("externalLed.initialized", source)
        self.assertIn("externalLed.last_show_ms", source)
        self.assertIn("externalLed.last_error", source)
        self.assertIn("lastIndicatorsStatusAutoRefreshKeyRef", source)
        self.assertIn("runIndicatorsStatusRefresh", source)
        self.assertIn('activeSection !== "indicators"', source)
        self.assertIn("lastIndicatorsStatusAutoRefreshKeyRef.current = \"\"", source)
        self.assertIn('command: "status"', source)
        self.assertNotIn("manual_preset", source)
        self.assertNotIn("externalLedMode, \"auto\"", source)
        self.assertNotIn("oled.enabled === true", source)
        self.assertIn("supportsExternalLed", profile_source)
        self.assertIn("supportsOled", profile_source)

    def test_v21_gcu_lts_profile_uses_remote_only_gcu_pin_layout_copy(self):
        source = SETTINGS_PAGE.read_text(encoding="utf-8")
        helper = (ROOT / "frontend" / "src" / "lib" / "boardProfile.ts").read_text(encoding="utf-8")
        i18n = (ROOT / "frontend" / "src" / "i18n.tsx").read_text(encoding="utf-8")

        self.assertIn('const V21_GCU_HARDWARE_MODEL = "VD-CTL/R v2.1 GCU LTS";', helper)
        self.assertIn("wikiSlug: \"vd-ctl-r-v2-1-gcu-lts\"", helper)
        self.assertIn("arduino-gcu-v21-lts-latest.json", helper)
        self.assertIn("defaultAnalogPins: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]", helper)
        self.assertIn("defaultSelectPins: [18, 19, 20, 21, 35, 36, 37, 39, 40, 41, 42, 45]", helper)
        self.assertIn('boardProfile.powerUx === "remote_only" ? t("pinLayoutCopyGcu") : t("pinLayoutCopyV1")', source)
        self.assertIn("unsupportedOnThisBoard", i18n)
        self.assertIn("externalLedUnsupportedCopy", i18n)
        self.assertIn("oledUnsupportedCopy", i18n)

    def test_indicators_limit_brightness_to_fixed_safe_presets(self):
        source = SETTINGS_PAGE.read_text()

        self.assertIn("EXTERNAL_LED_BRIGHTNESS_OPTIONS", source)
        self.assertIn("brightnessOption_10", source)
        self.assertIn("brightnessOption_20", source)
        self.assertIn("brightnessOption_35", source)
        self.assertIn("brightnessOption_50", source)
        self.assertIn("brightnessOption_100_danger", source)
        self.assertIn('value={String(brightness)}', source)
        self.assertNotIn('step="0.05"', source)
        self.assertNotIn('type="number" step="0.05" value={brightness}', source)

    def test_indicators_keep_last_known_snapshot_when_status_refresh_has_no_indicator_payload(self):
        source = SETTINGS_PAGE.read_text()

        self.assertIn("hasIndicatorData", source)
        self.assertIn("lastKnownIndicatorsRef", source)
        self.assertIn("indicatorSources", source)
        self.assertIn("lastKnownIndicatorsRef.current = nextIndicators", source)
        self.assertIn("lastKnownIndicatorsRef.current", source)

    def test_pin_layout_auto_loads_status_and_uses_operation_specific_loading(self):
        source = SETTINGS_PAGE.read_text()

        self.assertIn("pinStatusAutoRequestedRef", source)
        self.assertIn('activeSection === "pins"', source)
        self.assertIn('command: "status"', source)
        self.assertIn("busyCommand", source)
        self.assertIn("isCommandBusy", source)
        self.assertIn('isCommandBusy("set_matrix_layout")', source)
        self.assertIn('isCommandBusy("scan_health")', source)

    def test_settings_uses_toast_and_operation_log_for_command_feedback(self):
        source = SETTINGS_PAGE.read_text()
        styles = STYLES.read_text()

        self.assertIn("operationToast", source)
        self.assertIn("operationLog", source)
        self.assertIn("toastTimerRef", source)
        self.assertIn('className="operation-toast"', source)
        self.assertNotIn('className="operation-toast-backdrop"', source)
        self.assertNotIn(".operation-toast-backdrop", styles)
        self.assertNotIn("backdrop-filter", styles)
        self.assertIn('className="operation-toast-close"', source)
        self.assertIn('aria-label={t("closeToast")}', source)
        self.assertIn("setOperationToast(null)", source)
        self.assertIn("left: 24px", styles)
        self.assertIn("bottom: 24px", styles)
        self.assertIn("transform: none", styles)
        self.assertIn('className="operation-log"', source)
        self.assertNotIn('{message ? <p className="notice success">{message}</p> : null}', source)

    def test_device_flash_is_own_settings_tab_with_storage_status_and_file_browser(self):
        source = SETTINGS_PAGE.read_text()

        self.assertIn('| "flash"', source)
        self.assertIn('{ id: "flash", label: t("deviceFlash") }', source)
        self.assertIn('activeSection === "flash"', source)
        self.assertIn('command: "storage_status"', source)
        self.assertIn("storageUsage", source)
        self.assertIn("storage-bar-track", source)
        self.assertIn('target="_blank"', source)
        self.assertIn('rel="noreferrer"', source)

    def test_update_section_exposes_auto_ota_boot_setting(self):
        source = SETTINGS_PAGE.read_text()

        self.assertIn("autoOtaOnBoot", source)
        self.assertIn("setAutoOtaOnBoot", source)
        self.assertIn('command: "set_ota_config"', source)
        self.assertIn("auto_apply_on_boot", source)

    def test_update_section_can_view_release_changelog_after_check(self):
        source = SETTINGS_PAGE.read_text()

        self.assertIn("updateChangelogUrl", source)
        self.assertIn("updateChangelogBody", source)
        self.assertIn("loadUpdateChangelog", source)
        self.assertIn('t("viewChangelog")', source)
        self.assertIn('t("hideChangelog")', source)
        self.assertIn('t("changelogUnavailable")', source)
        self.assertIn("fetch(updateChangelogUrl)", source)
        self.assertIn('className="changelog-panel"', source)

    def test_status_driven_tabs_auto_refresh_status_when_opened(self):
        source = SETTINGS_PAGE.read_text()

        self.assertIn("statusDrivenSectionAutoRefreshKeyRef", source)
        self.assertIn("shouldAutoRefreshStatusForSection", source)
        self.assertIn('const STATUS_DRIVEN_SECTIONS: SettingsSection[] = ["about", "gateway", "update", "diagnostics", "flash"]', source)
        self.assertIn('command: "status"', source)

    def test_offline_device_skips_auto_refresh_and_disables_live_queries(self):
        source = SETTINGS_PAGE.read_text()

        self.assertIn("const isDeviceOffline = normalized?.isOffline === true", source)
        self.assertIn("if (!ramMonitorEnabled || !deviceUid || isDeviceOffline) return undefined;", source)
        self.assertIn("if (!deviceUid || !shouldAutoRefreshStatusForSection(activeSection) || isDeviceOffline)", source)
        self.assertIn('if (activeSection !== "pins" || !deviceUid || busyCommand || isDeviceOffline) return;', source)
        self.assertIn('if (activeSection !== "indicators" || !deviceUid || isDeviceOffline)', source)
        self.assertIn("if (!deviceUid || isDeviceOffline) return;", source)
        self.assertIn('disabled={isCommandBusy("status") || !deviceUid || isDeviceOffline}', source)
        self.assertIn('disabled={isCommandBusy("findme_discover") || !deviceUid || isDeviceOffline}', source)
        self.assertIn('disabled={busyCommand === "storage_status" || !deviceUid || isDeviceOffline}', source)
        self.assertIn('disabled={busyCommand === "calibration_status" || !deviceUid || isDeviceOffline}', source)

    def test_flash_tab_exposes_log_settings(self):
        source = SETTINGS_PAGE.read_text()
        i18n = (ROOT / "frontend" / "src" / "i18n.tsx").read_text(encoding="utf-8")

        self.assertIn("logEnabled", source)
        self.assertIn("logLevel", source)
        self.assertIn("logMode", source)
        self.assertIn('command: "set_log"', source)
        self.assertIn("max_bytes", source)
        self.assertIn('const STANDARD_LOG_BYTES = 12 * 1024;', source)
        self.assertIn('const EXTENDED_LOG_BYTES = 24 * 1024;', source)
        self.assertIn('useState(stringValue(logging.level, "error"))', source)
        self.assertIn('value="standard"', source)
        self.assertIn('value="extended"', source)
        self.assertIn('<option value="warn">warn</option>', source)
        self.assertNotIn("warning", source)
        self.assertIn('logModeStandard: "Standard 12KB (up to 24KB on flash)"', i18n)
        self.assertIn('logModeExtended: "Extended 24KB (up to 48KB on flash)"', i18n)

    def test_maintenance_section_exposes_calibration_workbench_commands(self):
        source = SETTINGS_PAGE.read_text()

        for command in (
            'command: "calibration_status"',
            'command: "calibration_enable"',
            'command: "calibration_disable"',
            'command: "calibration_clear_profile"',
            'command: "calibration_session_begin"',
            'command: "calibration_session_abort"',
            'command: "calibration_session_commit"',
            'command: "calibration_capture_cell"',
            'command: "calibration_capture_all"',
            'command: "calibration_dump_level"',
            'command: "calibration_delete_level"',
            'command: "storage_status"',
            'command: "log_clear"',
        ):
            self.assertIn(command, source)
        self.assertIn("CalibrationWorkbench", source)
        self.assertIn("selectedCalibrationSensor", source)
        self.assertIn("calibrationLevelPreview", source)
        self.assertIn("captureAllSensors", source)
        self.assertIn("captureSelectedSensor", source)
        self.assertNotIn("calibrationAnalogPin", source)
        self.assertNotIn("calibrationSelectPin", source)
        self.assertIn("appHref(`device/${encodeURIComponent(deviceUid)}/files`)", source)

    def test_pressure_calibration_low_end_stability_uses_effective_floor_target(self):
        source = SETTINGS_PAGE.read_text(encoding="utf-8")

        self.assertIn("const PRESSURE_STABLE_TOLERANCE_KPA = 0.5;", source)
        self.assertIn("const PRESSURE_STABLE_CONFIRMATION_SAMPLES = 5;", source)
        self.assertIn("const PRESSURE_STABLE_ADAPTIVE_DELAY_MS = 8000;", source)
        self.assertIn("const PRESSURE_STABLE_ADAPTIVE_WINDOW_SAMPLES = 8;", source)
        self.assertIn("const PRESSURE_STABLE_ADAPTIVE_RANGE_KPA = 0.25;", source)
        self.assertIn("const PRESSURE_STABLE_ADAPTIVE_TARGET_SLACK_KPA = 1.0;", source)
        self.assertIn("const PRESSURE_STABLE_MAX_WAIT_MS = 20000;", source)
        self.assertIn("function hasStablePressureWindow(", source)
        self.assertIn("Math.abs(r.uno.pressure_kpa - targetKpa) < PRESSURE_STABLE_TOLERANCE_KPA", source)
        self.assertIn("elapsedMs >= PRESSURE_STABLE_ADAPTIVE_DELAY_MS", source)
        self.assertIn("elapsedMs >= PRESSURE_STABLE_MAX_WAIT_MS", source)
        self.assertIn('reason: "adaptive_window"', source)
        self.assertIn('reason: "timeout_window"', source)
        self.assertIn("Pressure settled at ${stability.settledKpa?.toFixed(3) ?? \"-\"} kPa after", source)
        self.assertIn("Pressure held within ${PRESSURE_STABLE_TIMEOUT_RANGE_KPA.toFixed(2)} kPa window", source)
        self.assertNotIn("Math.abs(r.uno.pressure_kpa - targetKpa) < 0.5", source)

    def test_pressure_calibration_stabilizing_ui_and_manual_confirm_exist(self):
        source = SETTINGS_PAGE.read_text(encoding="utf-8")
        i18n = (ROOT / "frontend" / "src" / "i18n.tsx").read_text(encoding="utf-8")

        self.assertIn('pressureCalLiveStatusCard', i18n)
        self.assertIn('pressureCalTargetKpa', i18n)
        self.assertIn('pressureCalMaxKpa', i18n)
        self.assertIn('manualConfirmCapture', i18n)
        self.assertIn("const [activeTargetKpa, setActiveTargetKpa] = useState<number | null>(null);", source)
        self.assertIn("const manualConfirmRef = useRef<PressureStableResult | null>(null);", source)
        self.assertIn('manualConfirmRef.current = {', source)
        self.assertIn('reason: "manual_confirm"', source)
        self.assertIn('phase === "stabilizing"', source)
        self.assertIn('t("pressureCalLiveStatusCard")', source)
        self.assertIn('t("pressureCalTargetKpa")', source)
        self.assertIn('t("pressureCalMaxKpa")', source)
        self.assertIn('className="pressure-live-bar-track"', source)
        self.assertIn('className="pressure-live-bar-fill"', source)
        self.assertIn('Math.max(0, Math.min(100, ((currentKpa ?? 0) / PRESSURE_MAX_KPA) * 100))', source)
        self.assertIn('t("manualConfirmCapture")', source)
        self.assertIn('Manual confirm at target ${targetKpa} kPa, UNO ${stability.settledKpa?.toFixed(3) ?? "-"} kPa, IMADA ${stability.imadaValue.toFixed(3)} N', source)

    def test_unused_filter_ui_is_removed_from_settings(self):
        source = SETTINGS_PAGE.read_text()

        self.assertNotIn("filterEnabled", source)
        self.assertNotIn('command: "set_filter"', source)
        self.assertNotIn(">Filter<", source)

    def test_scan_timing_sends_full_runtime_timing_controls(self):
        source = SETTINGS_PAGE.read_text()

        self.assertIn("send_every_n_frames", source)
        self.assertIn("settle_us", source)

    def test_scan_timing_uses_pending_apply_state_to_prevent_stale_status_reset(self):
        source = SETTINGS_PAGE.read_text()

        self.assertIn("pendingScanTimingApply", source)
        self.assertIn("setPendingScanTimingApply", source)
        self.assertIn("lastAppliedScanTiming", source)
        self.assertIn("pendingScanTimingApply ?? lastAppliedScanTiming ?? scanTiming", source)
        self.assertIn("if (scanDraftDirty || pendingScanTimingApply)", source)
        self.assertNotIn("setScanDraftDirty(false);\n  }", source)

    def test_scan_timing_prefers_set_scan_timing_result_before_status_health_fallback(self):
        source = SETTINGS_PAGE.read_text()

        self.assertIn('lastResultCommand === "set_scan_timing"', source)
        self.assertIn("recordValue(lastResult.runtime).scan_timing", source)
        self.assertIn("scanHealth.requested_target_fps", source)
        self.assertIn("scanHealth.settle_us", source)
        self.assertIn("scanHealth.send_every_n_frames", source)

    def test_pin_layout_inputs_sync_from_device_status_not_hardcoded_defaults(self):
        source = SETTINGS_PAGE.read_text()

        self.assertNotIn("DEFAULT_ANALOG_PINS", source)
        self.assertNotIn("DEFAULT_SELECT_PINS", source)
        self.assertIn("matrixLayout", source)
        self.assertIn("analogPinsFromStatus", source)
        self.assertIn("selectPinsFromStatus", source)
        self.assertIn("boardProfileForHardwareModel", source)
        self.assertIn("setPinDraftDirty(true)", source)

    def test_update_manifest_and_io_modal_use_board_profile_defaults(self):
        source = SETTINGS_PAGE.read_text()
        helper = (ROOT / "frontend" / "src" / "lib" / "boardProfile.ts").read_text(encoding="utf-8")
        terminal = (ROOT / "frontend" / "src" / "pages" / "TerminalPage.tsx").read_text(encoding="utf-8")

        self.assertIn("defaultManifestUrlForHardwareModel", source)
        self.assertIn("defaultManifestUrl", helper)
        self.assertIn("arduino-gcu-lts-latest.json", helper)
        self.assertIn("overviewAsset", helper)
        self.assertIn("digitalPinOrder", helper)
        self.assertIn("analogPinOrder", helper)
        self.assertIn("VDCTLV23DGCULTSOVERVIEW.png", helper)
        self.assertIn("defaultAnalogPins={boardProfile.defaultAnalogPins}", source)
        self.assertIn("supportsPinVisualizer={boardProfile.supportsIoVisualizer}", source)
        self.assertIn("boardProfile.overviewAsset", terminal)
        self.assertIn("boardProfile.digitalPinOrder", terminal)
        self.assertIn("boardProfile.analogPinOrder", terminal)

    def test_power_and_indicator_copy_are_board_aware(self):
        source = SETTINGS_PAGE.read_text()
        i18n = (ROOT / "frontend" / "src" / "i18n.tsx").read_text(encoding="utf-8")

        self.assertIn("boardProfile.powerUx", source)
        self.assertIn("powerStatusCopyRemoteOnly", i18n)
        self.assertIn("supportsLocalButtonWake", (ROOT / "frontend" / "src" / "lib" / "boardProfile.ts").read_text(encoding="utf-8"))

    def test_device_flash_uses_shared_storage_snapshot_helper(self):
        settings_source = SETTINGS_PAGE.read_text(encoding="utf-8")
        files_source = (ROOT / "frontend" / "src" / "pages" / "DeviceFilesPage.tsx").read_text(encoding="utf-8")

        self.assertIn("storageSnapshotFromDevice", settings_source)
        self.assertIn("storageSnapshotFromResult", files_source)

    def test_recovery_release_ui_is_removed_for_arduino(self):
        settings_source = SETTINGS_PAGE.read_text()
        device_source = DEVICE_LIB.read_text()
        app_source = (ROOT / "frontend" / "src" / "App.tsx").read_text(encoding="utf-8")

        self.assertNotIn("WizardPage", app_source)
        self.assertNotIn('path="/wizard"', app_source)
        for legacy in (
            "latestRootVersion",
            "rootVersion",
            "recoveryVersion",
            "check_os_release",
            "write_os",
            "check_recovery_release",
            "write_recovery",
            "reboot_to_recovery",
            "reboot_to_os",
            "release_recovery_resources",
            "root_version",
        ):
            self.assertNotIn(legacy, settings_source)
            self.assertNotIn(legacy, device_source)

    def test_diagnostics_exposes_imu_and_memory_controls_for_arduino(self):
        source = SETTINGS_PAGE.read_text()

        self.assertIn('command: "set_imu"', source)
        self.assertIn("imuEnabled", source)
        self.assertIn('command: "memory_status"', source)

    def test_diagnostics_exposes_stream_buffer_controls_and_metrics(self):
        source = SETTINGS_PAGE.read_text()
        i18n = (ROOT / "frontend" / "src" / "i18n.tsx").read_text(encoding="utf-8")

        self.assertIn('command: "set_stream_buffer"', source)
        self.assertIn("streamBufferEnabled", source)
        self.assertIn("streamBufferMode", source)
        self.assertIn("queue_capacity_frames", source)
        self.assertIn("queue_dropped_frames", source)
        self.assertIn("queue_max_occupied_frames", source)
        self.assertIn("streamBufferDiagnostics", i18n)
        self.assertIn("streamBufferStandardMode", i18n)
        self.assertIn("streamBufferExtendedMode", i18n)

    def test_device_command_hook_keeps_stream_buffer_and_storage_status_fallbacks(self):
        source = DEVICE_COMMAND_LIB.read_text()
        device_source = DEVICE_LIB.read_text()

        self.assertIn("resultFromDeviceState", source)
        self.assertIn('command === "set_stream_buffer"', device_source)
        self.assertIn('"stream_buffer_updated"', device_source)
        self.assertIn('"storage_status"', device_source)

    def test_app_shell_displays_desktop_version(self):
        source = APP_TSX.read_text(encoding="utf-8")
        styles = STYLES.read_text(encoding="utf-8")

        self.assertIn('import packageJson from "../package.json"', source)
        self.assertIn("const APP_VERSION = `v${packageJson.version}`", source)
        self.assertIn('className="app-version"', source)
        self.assertIn(".app-version", styles)

    def test_backend_service_keeps_arduino_tcp_fallback_for_current_firmware(self):
        source = SERVICE.read_text(encoding="utf-8")

        self.assertIn("_arduino_control_sessions", source)
        self.assertIn("send_control_command", source)
        self.assertIn('"transport_path": "arduino_tcp"', source)
        self.assertIn('"transport_path": "arduino_udp"', source)

    def test_booting_device_is_not_normalized_as_offline(self):
        source = DEVICE_LIB.read_text()

        self.assertIn('device.booting === true', source)
        self.assertIn('isOffline: !isBooting', source)

    def test_device_normalization_uses_top_level_arduino_status_fallbacks(self):
        source = DEVICE_LIB.read_text()

        self.assertIn("device.firmware_version", source)
        self.assertIn("device.hardware_model", source)
        self.assertIn("device.matrix_shape ?? status.matrix_shape", source)

    def test_terminal_result_uses_json_labels(self):
        source = (ROOT / "frontend" / "src" / "pages" / "TerminalPage.tsx").read_text(encoding="utf-8")

        self.assertIn("terminal-json-details", source)
        self.assertIn("boardProfileForHardwareModel", source)
        self.assertIn("commandParamDefaultValue", source)

    def test_device_files_page_uses_arduino_file_read_write_commands(self):
        source = (ROOT / "frontend" / "src" / "pages" / "DeviceFilesPage.tsx").read_text(encoding="utf-8")

        for command in ("file_read_begin", "file_read_chunk", "file_write_begin", "file_write_chunk", "file_write_finish", "file_delete"):
            self.assertIn(command, source)
        for legacy in ("file_download_begin", "file_download_chunk", "file_upload_begin", "file_upload_chunk", "file_upload_finish", "offlineSegmentToCsv"):
            self.assertNotIn(legacy, source)

    def test_device_files_page_defaults_to_log_preview_workspace(self):
        source = (ROOT / "frontend" / "src" / "pages" / "DeviceFilesPage.tsx").read_text(encoding="utf-8")

        self.assertIn('const [activeScope, setActiveScope] = useState<FileScope>("logs")', source)
        self.assertIn("selectedFile", source)
        self.assertIn("previewOpen", source)
        self.assertIn("previewText", source)
        self.assertIn("device.log", source)
        self.assertIn("device.log.1", source)
        self.assertIn("setPreviewOpen(false)", source)
        self.assertIn("file-preview-panel", source)
        self.assertIn('t("preview")', source)
        self.assertIn("chunkResult.data", source)
        self.assertNotIn('String(chunk.result?.data ?? "")', source)

    def test_device_files_page_shows_storage_usage_and_maintenance_actions(self):
        source = (ROOT / "frontend" / "src" / "pages" / "DeviceFilesPage.tsx").read_text(encoding="utf-8")

        self.assertIn('command: "storage_status"', source)
        self.assertIn("file-ops-toolbar", source)
        self.assertIn("storage-card", source)
        self.assertIn("storage-stat-grid", source)
        self.assertIn("maintenance-strip", source)
        self.assertIn("upload-inline-form", source)
        self.assertIn("upload-submit", source)
        self.assertIn('t("deviceStorage")', source)
        self.assertIn('t("refreshFlashUsage")', source)
        self.assertIn('t("maintenanceModeLabel")', source)
        self.assertIn('command: "enter_maintenance"', source)
        self.assertIn('command: "exit_maintenance"', source)
        self.assertIn('t("fileWriteRequiresMaintenance")', source)
        self.assertNotIn('className="field-grid"', source)
        self.assertNotIn('className="upload-panel"', source)


if __name__ == "__main__":
    unittest.main()
