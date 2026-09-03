import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
VISUALIZATION_PAGE = ROOT / "frontend" / "src" / "pages" / "VisualizationPage.tsx"
WS_CLIENT = ROOT / "frontend" / "src" / "lib" / "wsClient.ts"
STYLES = ROOT / "frontend" / "src" / "styles.css"


class VisualizationPageStaticTest(unittest.TestCase):
    def test_device_fps_uses_backend_udp_fps_not_browser_arrival_time(self):
        source = VISUALIZATION_PAGE.read_text()

        self.assertIn("kVisualizationStaleMs", source)
        self.assertIn("device_udp_fps", source)
        self.assertIn("const backendFps = Number(item.device_udp_fps", source)
        self.assertNotIn("const tick = Number(item.received_at_ms ?? item.timestamp_ms ?? 0);", source)
        self.assertIn("now - previous.lastTick > kVisualizationStaleMs", source)

    def test_visualization_ui_caps_display_at_sixty_fps_without_large_matrix_data_cap(self):
        page_source = VISUALIZATION_PAGE.read_text()
        ws_source = WS_CLIENT.read_text()

        self.assertIn("VISUALIZATION_UI_TARGET_FPS = 60", ws_source)
        self.assertIn("VISUALIZATION_UI_FRAME_INTERVAL_MS", ws_source)
        self.assertNotIn("VISUALIZATION_LARGE_FRAME_INTERVAL_MS", ws_source)
        self.assertNotIn("pendingVisualizationIntervalMs", ws_source)
        self.assertIn("lastVisualizationFlushAt", ws_source)
        self.assertIn("VISUAL_SURFACE_MAX_INTERPOLATED_POINTS", page_source)
        self.assertIn("surfaceInterpolationSteps", page_source)
        self.assertNotIn("SURFACE_LARGE_MATRIX_INTERPOLATION_STEPS", page_source)
        self.assertIn("reusableFloat32AttributeArray", page_source)
        self.assertIn("reusableIndexArray", page_source)
        self.assertIn("setGeometryAttribute", page_source)
        self.assertIn("setGeometryIndex", page_source)
        self.assertIn("existing.array.length === array.length", page_source)
        self.assertIn("existing.array === array", page_source)

    def test_visualization_prefers_device_matrix_shape_over_stale_sample_length(self):
        source = VISUALIZATION_PAGE.read_text()

        self.assertIn("const deviceRows = asFiniteNumber(device?.matrix_shape?.rows, 0);", source)
        self.assertIn("const deviceCols = asFiniteNumber(device?.matrix_shape?.cols, 0);", source)
        self.assertIn("if (deviceRows > 0 && deviceCols > 0)", source)
        self.assertNotIn("rows * cols >= values.length", source)

    def test_render_fps_comes_from_animation_loop_not_visualization_arrival_only(self):
        source = VISUALIZATION_PAGE.read_text()

        self.assertIn("const renderLoop = (now: number) => {", source)
        self.assertIn("renderLoopFrameRef", source)
        self.assertIn("window.requestAnimationFrame(renderLoop)", source)
        self.assertNotIn("setRenderFpsByDevice((current) => {", source)

    def test_profile_visualization_uses_shared_layout_helper_and_image_overlay_for_2d(self):
        source = VISUALIZATION_PAGE.read_text()
        styles = STYLES.read_text()

        self.assertIn('from "../lib/profileLayout"', source)
        self.assertIn("fitProfileRect", source)
        self.assertIn("profilePointToScreen", source)
        self.assertIn('className="profile-dot-map-image"', source)
        self.assertIn('className="profile-dot-map-overlay"', source)
        self.assertNotIn('backgroundImage: profile?.background?.imageData ? `url(${profile.background.imageData})` : undefined', source)
        self.assertIn(".profile-dot-map-image", styles)
        self.assertIn(".profile-dot-map-overlay", styles)

    def test_profile_visualization_uses_background_plane_for_3d_mode(self):
        source = VISUALIZATION_PAGE.read_text()

        self.assertIn("profilePointToWorld", source)
        self.assertIn("backgroundMesh", source)
        self.assertIn("new THREE.PlaneGeometry", source)
        self.assertIn("new THREE.TextureLoader().load", source)
        self.assertIn("backgroundTexture", source)
        self.assertIn("current.backgroundMesh.visible = Boolean", source)

    def test_visualization_trusts_device_calibrated_stream_and_uses_calibrated_range_hint(self):
        source = VISUALIZATION_PAGE.read_text()

        self.assertNotIn("useCalibratedLevels?: boolean;", source)
        self.assertNotIn("function buildCalibrationLookup(", source)
        self.assertNotIn("function applyCalibrationValue(", source)
        self.assertNotIn('command: "calibration_dump_level"', source)
        self.assertNotIn('{t("useCalibratedLevels")}', source)
        self.assertIn("function calibrationDisplayRange(", source)
        self.assertIn("const hasEnabledCalibration = calibrationState.enabled;", source)
        self.assertIn("const activeRange = hasEnabledCalibration ? calibrationDisplayRange(calibrationState, cardRange) : cardRange;", source)
        self.assertIn('{t("calibratedRangeHint")}', source)

    def test_visualization_card_gates_battery_on_board_profile_and_warns_when_low(self):
        source = VISUALIZATION_PAGE.read_text()

        self.assertIn("boardProfileForHardwareModel", source)
        self.assertIn("deviceBatteryReadout", source)
        self.assertIn("supportsBatteryPercentageIndicator", source)
        # The reading rides in the card header, alongside the live/offline pill.
        self.assertIn("<DeviceBatteryChip readout={batteryReadout} t={t} />", source)
        header = source.split('className="actions compact-actions"', 1)[1]
        self.assertLess(header.index("DeviceBatteryChip"), header.index("stopRecording"))

    def test_low_battery_alarm_survives_reduced_motion(self):
        styles = STYLES.read_text()

        rule = styles.split(".visualization-battery-chip.low {", 1)[1].split("}", 1)[0]
        # The global prefers-reduced-motion block clamps animation-iteration-count
        # to 1, so the warning must be legible from static colour alone.
        self.assertIn("var(--danger)", rule)
        self.assertIn("background:", rule)
        self.assertIn("battery-low-pulse", rule)
        self.assertIn("@keyframes battery-low-pulse", styles)

    def test_add_device_modal_shows_real_connection_state_not_operating_mode(self):
        source = VISUALIZATION_PAGE.read_text()
        modal = source.split('className="modal-panel add-device-modal"', 1)[1]

        # The picker must normalize, so it sees connectionState at all.
        self.assertIn("connectionStateLabel(normalized, t)", modal)
        self.assertIn("statusDot(normalized)", modal)
        self.assertIn("deviceClassName(normalized)", modal)

        # The two bugs being fixed. `device.mode` is the operating mode, not
        # reachability; `last_seen_at` is refreshed by the gateway even for
        # disconnected devices, so it is never a liveness signal.
        self.assertNotIn("device.mode", modal)
        self.assertNotIn("device.last_seen_at", modal)
        self.assertIn("normalized.lastSeen", modal)

        # Detail parity with the Launchpad card.
        self.assertIn("normalized.hardwareModel", modal)
        self.assertIn("normalized.firmwareVersion", modal)
        self.assertIn("normalized.protocol", modal)
        self.assertIn("DeviceBatteryChip", modal)

    def test_add_device_modal_is_searchable_and_sorted_by_reachability(self):
        source = VISUALIZATION_PAGE.read_text()

        self.assertIn("connectionRank(left.normalized) - connectionRank(right.normalized)", source)
        self.assertIn('type="search"', source)
        self.assertIn("autoFocus", source)
        self.assertIn('t("noDevicesMatchFilter")', source)
        # Connection state ages out on a timer, so the list must re-sort itself
        # without the user reopening the modal.
        candidates = source.split("const addCandidates = useMemo(", 1)[1].split("}, [", 1)[1]
        self.assertIn("clockTick", candidates)
        # Dismissing must reset the filter, not leave it primed for next time.
        self.assertIn("function closeAddModal()", source)
        self.assertIn("setAddFilter(\"\")", source)

    def test_add_device_card_stays_readable_when_offline_and_already_added(self):
        styles = STYLES.read_text()

        # .device-card.offline (0.72) x .add-device-card:disabled (0.58) = 0.42.
        self.assertIn(".add-device-card.offline:disabled", styles)
        # The search box must not scroll away with the list.
        self.assertIn(".add-device-modal .device-grid", styles)


if __name__ == "__main__":
    unittest.main()
