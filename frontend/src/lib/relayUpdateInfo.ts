import { normalizeUpdateChannel, type UpdateChannel } from "./versioning";

// Reads a relay's update block (gateway_status `update`) the same way for a
// Hub and a Gateway. The two name a few fields differently: a Hub says
// `latest_hub_version` / `changelog_url`, a Gateway `latest_version` /
// `notes_url`; everything else (channel, required_update, available,
// version, phase, operation, error, auto_apply) is shared.

export function relayRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

export type RelayUpdateInfo = {
  // The relay reports an update block at all (Hub v0.8.0+, Gateway v1.0.0+).
  supportsUpdate: boolean;
  // It reports its channel there (Hub v0.9.0+, Gateway v1.0.0+).
  supportsChannel: boolean;
  channel: UpdateChannel;
  requiredUpdate: boolean;
  requiredVersion: string;
  latestVersion: string;
  updateAvailable: boolean;
  changelogUrl: string;
  autoApply: string;
};

// `checkResult` is the last check_update reply (its `update` block), or null.
export function relayUpdateInfo(update: unknown, checkResult: Record<string, unknown> | null): RelayUpdateInfo {
  const state = relayRecord(update);
  const checked = relayRecord(checkResult?.update);
  const requiredUpdate = state.required_update === true;
  const requiredVersion = String(state.latest_hub_version || state.latest_version || "");
  const latestVersion = String(
    checked.version || (state.available === true ? state.version : "") || (requiredUpdate ? requiredVersion : "") || "",
  );
  return {
    supportsUpdate: Object.keys(state).length > 0,
    supportsChannel: typeof state.channel === "string",
    channel: normalizeUpdateChannel(state.channel),
    requiredUpdate,
    requiredVersion,
    latestVersion,
    updateAvailable: checked.available === true || (checkResult === null && (state.available === true || requiredUpdate)),
    changelogUrl: String(checked.changelog_url || checked.notes_url || state.changelog_url || state.notes_url || ""),
    autoApply: String(state.auto_apply || ""),
  };
}
