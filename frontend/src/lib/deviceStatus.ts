import type { DeviceConnectionState } from "./connectionState";

// The presentation half of a device's connection state, shared by the Launchpad
// grid and the Visualization "add device view" picker so the two never drift
// apart on what "offline" looks like. Kept free of React and asset imports so it
// stays directly loadable by `node --experimental-strip-types --test`.
type StatusShapedDevice = {
  connectionState: DeviceConnectionState;
  mode: string;
};

export function deviceClassName(device: StatusShapedDevice) {
  if (device.connectionState === "reconnecting") return "reconnecting";
  if (device.connectionState === "offline") return "offline";
  if (device.mode === "maintenance" || device.mode === "safe_maintenance") return "maintenance";
  if (device.connectionState === "booting") return "booting";
  return "normal";
}

export function statusDot(device: StatusShapedDevice) {
  if (device.connectionState === "booting") return "status-dot booting";
  if (device.connectionState === "reconnecting") return "status-dot reconnecting";
  if (device.connectionState === "offline") return "status-dot offline";
  return "status-dot online";
}

// Unlike LaunchpadPage's deviceStateLabel, which falls through to the raw
// untranslated `mode` string ("normal") when a device is online, every branch
// here resolves to a translated connection state -- the picker is answering
// "is this thing reachable right now?", not "what mode is it in?".
export function connectionStateLabel(device: StatusShapedDevice, t: (key: string) => string) {
  if (device.connectionState === "booting") return t("booting");
  if (device.connectionState === "reconnecting") return t("reconnecting");
  if (device.connectionState === "offline") return t("offline");
  return t("online");
}

// Sort key that floats reachable devices to the top of a picker.
export function connectionRank(device: StatusShapedDevice) {
  switch (device.connectionState) {
    case "online":
      return 0;
    case "booting":
      return 1;
    case "reconnecting":
      return 2;
    default:
      return 3;
  }
}
