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


if __name__ == "__main__":
    unittest.main()
