import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
SETTINGS_PAGE = ROOT / "frontend" / "src" / "pages" / "DeviceSettingsPage.tsx"
DEVICE_LIB = ROOT / "frontend" / "src" / "lib" / "device.ts"
STYLES = ROOT / "frontend" / "src" / "styles.css"


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
        self.assertIn('disabled={busyCommand === "log_tail" || !deviceUid || isDeviceOffline}', source)
        self.assertIn('disabled={busyCommand === "calibration_status" || !deviceUid || isDeviceOffline}', source)

    def test_flash_tab_exposes_log_settings(self):
        source = SETTINGS_PAGE.read_text()

        self.assertIn("logEnabled", source)
        self.assertIn("logLevel", source)
        self.assertIn("logMode", source)
        self.assertIn('command: "set_log"', source)
        self.assertIn("max_bytes", source)
        self.assertIn('value="standard"', source)
        self.assertIn('value="extended"', source)

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
            'command: "log_tail"',
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
        self.assertIn("setPinDraftDirty(true)", source)

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

    def test_device_files_page_uses_arduino_file_read_write_commands(self):
        source = (ROOT / "frontend" / "src" / "pages" / "DeviceFilesPage.tsx").read_text(encoding="utf-8")

        for command in ("file_read_begin", "file_read_chunk", "file_write_begin", "file_write_chunk", "file_write_finish", "file_delete"):
            self.assertIn(command, source)
        for legacy in ("file_download_begin", "file_download_chunk", "file_upload_begin", "file_upload_chunk", "file_upload_finish", "offlineSegmentToCsv"):
            self.assertNotIn(legacy, source)


if __name__ == "__main__":
    unittest.main()
