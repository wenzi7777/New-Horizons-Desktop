import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
PROFILES_PAGE = ROOT / "frontend" / "src" / "pages" / "ProfilesPage.tsx"
STYLES = ROOT / "frontend" / "src" / "styles.css"


class ProfilesPageStaticTest(unittest.TestCase):
    def test_profiles_page_keeps_scene_based_marker_layout_for_background_content(self):
        source = PROFILES_PAGE.read_text()

        self.assertIn("stageViewportRef", source)
        self.assertIn("stageSceneRef", source)
        self.assertIn("sceneRect", source)
        self.assertIn("scenePoint(event)", source)
        self.assertIn("profile-stage-viewport", source)
        self.assertIn("profile-stage-scene", source)
        self.assertIn("background.aspectRatio", source)

    def test_profiles_page_supports_toolbar_zoom_pan_and_fit_controls(self):
        source = PROFILES_PAGE.read_text()

        self.assertIn("wheelHandlerRef", source)
        self.assertIn("e.preventDefault();", source)
        self.assertIn("panMode", source)
        self.assertIn("beginPanning", source)
        self.assertIn("zoomInfo", source)
        self.assertNotIn("handleStageWheel", source)
        self.assertNotIn("onWheel=", source)
        self.assertIn('onClick={() => zoomFromCenter(1.25)}', source)
        self.assertIn('onClick={() => zoomFromCenter(1 / 1.25)}', source)
        self.assertIn('onClick={fitStageContent}', source)

    def test_profile_markers_use_fixed_circle_size_instead_of_content_width(self):
        source = PROFILES_PAGE.read_text()
        styles = STYLES.read_text()

        self.assertIn("markerSize", source)
        self.assertIn("markerFontSize", source)
        self.assertIn("clamp(markerSize * 0.28, 7, 11)", source)
        self.assertIn("--profile-marker-size", source)
        self.assertIn("--profile-marker-font-size", source)
        self.assertIn("width: var(--profile-marker-size);", styles)
        self.assertIn("height: var(--profile-marker-size);", styles)
        self.assertIn("padding: 0;", styles)
        self.assertIn("border-radius: 999px;", styles)

    def test_profile_normalization_accepts_legacy_display_keys(self):
        source = PROFILES_PAGE.read_text()

        self.assertIn("display.pressureMin ?? display.pressure_min", source)
        self.assertIn("display.pressureMax ?? display.pressure_max", source)
        self.assertIn("display.dotSize ?? display.dot_size", source)

    def test_profile_workspace_uses_larger_canvas_with_tighter_sidebars(self):
        source = PROFILES_PAGE.read_text()
        styles = STYLES.read_text()

        self.assertIn("profile-sidebar-primary", source)
        self.assertIn("profile-canvas-panel", source)
        self.assertIn("profile-sidebar-secondary", source)
        self.assertIn("grid-template-columns: 210px minmax(560px, 1fr) 300px;", styles)
        self.assertIn("min-height: 640px;", styles)

    def test_segmented_control_has_one_column_per_segment(self):
        # A fixed three columns left the two-way "Default view" toggle with an
        # empty third slot that read as a missing option.
        styles = STYLES.read_text()
        rule = styles.split("\n.segmented-control {", 1)[1].split("}", 1)[0]
        self.assertIn("grid-auto-flow: column;", rule)
        self.assertNotIn("grid-template-columns", rule)

    def test_destructive_profile_actions_are_confirmed(self):
        source = PROFILES_PAGE.read_text()
        self.assertIn('setConfirming("delete")', source)
        self.assertIn('setConfirming("clear")', source)
        self.assertIn("<ConfirmModal", source)


if __name__ == "__main__":
    unittest.main()
