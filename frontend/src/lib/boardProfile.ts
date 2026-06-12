export type BoardProfile = {
  hardwareModel: string;
  wikiSlug: string;
  defaultManifestUrl: string;
  defaultAnalogPins: number[];
  defaultSelectPins: number[];
  supportsIoVisualizer: boolean;
};

const V1_HARDWARE_MODEL = "VD-CTL/R v1.0.F 2026.4";
const GCU_HARDWARE_MODEL = "VD-CTL/R v2.3.D GCU LTS";

const V1_PROFILE: BoardProfile = {
  hardwareModel: V1_HARDWARE_MODEL,
  wikiSlug: "vd-ctl-r-v1.0f",
  defaultManifestUrl: "https://raw.githubusercontent.com/wenzi7777/New-Horizons-OS/main/releases/arduino-latest.json",
  defaultAnalogPins: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10],
  defaultSelectPins: [13, 14, 15, 16, 17, 18, 19, 20, 21, 26, 47, 33, 34, 48, 40, 41, 35, 36, 37, 38, 39],
  supportsIoVisualizer: true,
};

const GCU_PROFILE: BoardProfile = {
  hardwareModel: GCU_HARDWARE_MODEL,
  wikiSlug: "vd-ctl-r-v2-3-d-gcu-lts",
  defaultManifestUrl: "https://raw.githubusercontent.com/wenzi7777/New-Horizons-OS/main/releases/arduino-gcu-lts-latest.json",
  defaultAnalogPins: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15],
  defaultSelectPins: [16, 17, 18, 19, 20, 21, 35, 36, 37, 39, 40, 41, 42, 45, 46],
  supportsIoVisualizer: false,
};

const KNOWN_PROFILES = [GCU_PROFILE, V1_PROFILE];

function normalizeHardwareModel(value: string) {
  return value.trim().toLowerCase();
}

function slugifyHardwareModel(value: string) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/-2026-4$/, "")
    .replace(/-v1-0-f$/, "-v1.0f")
    .replace(/^-+|-+$/g, "");
}

export const DEFAULT_BOARD_PROFILE = V1_PROFILE;

export function boardProfileForHardwareModel(value: string | null | undefined): BoardProfile {
  const normalized = normalizeHardwareModel(String(value ?? ""));
  const matched = KNOWN_PROFILES.find((profile) => normalizeHardwareModel(profile.hardwareModel) === normalized);
  return matched ?? DEFAULT_BOARD_PROFILE;
}

export function defaultManifestUrlForHardwareModel(value: string | null | undefined): string {
  return boardProfileForHardwareModel(value).defaultManifestUrl;
}

export function wikiSlugFromHardwareModel(value: string | null | undefined): string {
  const input = String(value ?? "").trim();
  if (!input) return DEFAULT_BOARD_PROFILE.wikiSlug;
  const normalized = normalizeHardwareModel(input);
  const matched = KNOWN_PROFILES.find((profile) => normalizeHardwareModel(profile.hardwareModel) === normalized);
  return matched?.wikiSlug ?? slugifyHardwareModel(input);
}
