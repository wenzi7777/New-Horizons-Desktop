from __future__ import annotations

import json
import sys
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
BACKEND_ROOT = ROOT / "backend"
if str(BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(BACKEND_ROOT))

from newhorizons_backend.profile_import import import_legacy_profiles  # noqa: E402


DEFAULT_SOURCE = Path("/Users/nickxu/Documents/Researches/mqtt_test/web/profiles")
DEFAULT_TARGET = ROOT / "data" / "profiles"


def main() -> None:
    source_dir = Path(sys.argv[1]) if len(sys.argv) > 1 else DEFAULT_SOURCE
    target_dir = Path(sys.argv[2]) if len(sys.argv) > 2 else DEFAULT_TARGET
    imported = import_legacy_profiles(source_dir, target_dir)
    print(json.dumps({"imported": imported}, indent=2, ensure_ascii=True))


if __name__ == "__main__":
    main()
