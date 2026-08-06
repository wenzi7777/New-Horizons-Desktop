import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
BACKEND_ROOT = ROOT / "backend"
if str(BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(BACKEND_ROOT))

from newhorizons_backend.hub_channel_watch import HubChannelWatcher  # noqa: E402


class FakeClock:
    def __init__(self, start: float = 1000.0) -> None:
        self.value = start

    def __call__(self) -> float:
        return self.value

    def advance(self, seconds: float) -> None:
        self.value += seconds


class HubChannelWatcherTest(unittest.TestCase):
    def test_unreported_hub_has_no_channel(self) -> None:
        watcher = HubChannelWatcher(now=FakeClock())
        self.assertEqual(watcher.channel_for("hub-a"), 0)

    def test_report_channel_is_readable_back(self) -> None:
        watcher = HubChannelWatcher(now=FakeClock())
        watcher.report_channel("hub-a", 9)
        self.assertEqual(watcher.channel_for("hub-a"), 9)

    def test_report_channel_zero_or_missing_is_ignored(self) -> None:
        watcher = HubChannelWatcher(now=FakeClock())
        watcher.report_channel("hub-a", 0)
        self.assertEqual(watcher.channel_for("hub-a"), 0)

    def test_report_channel_overwrites_previous_value(self) -> None:
        watcher = HubChannelWatcher(now=FakeClock())
        watcher.report_channel("hub-a", 6)
        watcher.report_channel("hub-a", 11)
        self.assertEqual(watcher.channel_for("hub-a"), 11)

    def test_clear_channel_resets_to_unknown(self) -> None:
        watcher = HubChannelWatcher(now=FakeClock())
        watcher.report_channel("hub-a", 9)
        watcher.clear_channel("hub-a")
        self.assertEqual(watcher.channel_for("hub-a"), 0)

    def test_delete_environment_clears_assignments_only_not_channels(self) -> None:
        # Deleting an environment un-groups a Hub, but its last-reported
        # channel is independent state -- it shouldn't be wiped just
        # because the admin removed the grouping.
        watcher = HubChannelWatcher(now=FakeClock())
        env = watcher.create_environment("Room 1")
        watcher.set_hub_environment("hub-a", env["environment_id"])
        watcher.report_channel("hub-a", 9)

        self.assertTrue(watcher.delete_environment(env["environment_id"]))

        self.assertIsNone(watcher.hub_environment("hub-a"))
        self.assertEqual(watcher.channel_for("hub-a"), 9)

    def test_persists_environments_and_assignments_across_instances(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "hub_environments.json"
            watcher1 = HubChannelWatcher(path=path, now=FakeClock())
            env = watcher1.create_environment("Room 1")
            watcher1.set_hub_environment("hub-a", env["environment_id"])

            watcher2 = HubChannelWatcher(path=path, now=FakeClock())
            self.assertEqual(watcher2.hub_environment("hub-a"), env["environment_id"])
            self.assertEqual(len(watcher2.list_environments()), 1)

    def test_does_not_persist_reported_channels(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "hub_environments.json"
            watcher1 = HubChannelWatcher(path=path, now=FakeClock())
            env = watcher1.create_environment("Room 1")
            watcher1.set_hub_environment("hub-a", env["environment_id"])
            watcher1.report_channel("hub-a", 9)

            watcher2 = HubChannelWatcher(path=path, now=FakeClock())
            self.assertEqual(watcher2.channel_for("hub-a"), 0)

    def test_invalid_environment_name_rejected(self) -> None:
        watcher = HubChannelWatcher(now=FakeClock())
        with self.assertRaises(ValueError):
            watcher.create_environment("")
        with self.assertRaises(ValueError):
            watcher.create_environment("x" * 65)

    def test_set_hub_environment_rejects_unknown_environment(self) -> None:
        watcher = HubChannelWatcher(now=FakeClock())
        with self.assertRaises(ValueError):
            watcher.set_hub_environment("hub-a", "env-does-not-exist")


if __name__ == "__main__":
    unittest.main()
