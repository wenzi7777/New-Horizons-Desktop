import { useCallback, useEffect, useMemo, useState } from "react";

import type { DeviceEntry } from "./api";
import { valueToCsv } from "./valueFormat";
import { useWsState } from "./wsClient";

export type DeviceMode = "normal" | "maintenance" | "safe_maintenance" | "booting" | "offline" | string;
export type DeviceConnectionState = "online" | "reconnecting" | "offline" | "booting";

export type NormalizedDevice = {
  uid: string;
  name: string;
  nickname: string;
  deviceGroup: string;
  displayName: string;
  mode: DeviceMode;
  connectionState: "online" | "reconnecting" | "offline" | "booting";
  isReconnecting: boolean;
  isOffline: boolean;
  isControlUnavailable: boolean;
  firmwareVersion: string;
  protocol: string;
  hardwareModel: string;
  findme: Record<string, unknown>;
  systemSummary: Record<string, unknown>;
  transportMode: string;
  logging: string;
  matrixShape: string;
  battery: string;
  batteryState: string;
  lastSeen: string;
  lastSeenAt: string;
  raw: DeviceEntry;
};

type UpdateState = {
  phase?: string;
  operation?: string;
  version?: string;
  manifest_url?: string;
  changelog_url?: string;
  total_files?: number;
  applied_files?: number;
  skipped_files?: number;
  downloaded_files?: number;
  deleted_files?: number;
  current_file?: string;
  last_error?: string;
  last_result?: string;
  request_id?: string;
  reboot_required?: boolean;
};

const STATUS_SNAPSHOT_COMMANDS = new Set([
  "status",
  "query",
  "memory_status",
  "scan_health",
  "storage_status",
]);
const RECONNECTING_GRACE_MS = 15000;

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function stringValue(value: unknown, fallback = "") {
  if (value === undefined || value === null || value === "") return fallback;
  return String(value);
}

function dateValue(value: unknown): number {
  if (!value) return 0;
  const parsed = Date.parse(String(value));
  return Number.isFinite(parsed) ? parsed : 0;
}

function formatLastSeen(value: string): string {
  const timestamp = dateValue(value);
  if (!timestamp) return "-";
  const ageMs = Math.max(0, Date.now() - timestamp);
  if (ageMs < 3000) return "now";
  if (ageMs < 60000) return `${Math.round(ageMs / 1000)}s ago`;
  return new Date(timestamp).toLocaleString();
}

function batteryStateOf(battery: Record<string, unknown>): string {
  const state = stringValue(battery.state, "");
  if (state === "charging" || state === "charge_done" || state === "not_charging") return state;
  if (state === "unknown" || state === "fault") return "not_charging";
  const status = stringValue(battery.status, "");
  if (status === "charging_cc" || status === "charging_cv" || status === "charging") return "charging";
  if (status === "done" || status === "charge_done" || status === "complete") return "charge_done";
  if (status === "not_charging" || status === "unknown" || status === "fault") return "not_charging";
  if (battery.charging === true) return "charging";
  if (battery.charge_done === true || battery.done === true) return "charge_done";
  return "";
}

export function updateStateOf(device: DeviceEntry | undefined): UpdateState {
  const value = device?.last_status?.update_state ?? device?.update_state ?? device?.last_result?.update_state;
  return objectValue(value) as UpdateState;
}

export function appliedFileCount(state: UpdateState): number {
  return Number(state.applied_files ?? Number(state.downloaded_files ?? 0) + Number(state.skipped_files ?? 0));
}

export function isAppliedComplete(state: UpdateState): boolean {
  const operation = String(state.operation ?? "");
  const total = Number(state.total_files ?? 0);
  return operation === "apply_update" && total > 0 && appliedFileCount(state) >= total;
}

export function progressOf(state: UpdateState): number {
  if (isAppliedComplete(state)) return 100;
  if (state.phase === "done") return 100;
  if (state.phase === "ready") return 12;
  if (state.phase === "downloading") {
    const total = Number(state.total_files ?? 0);
    return total > 0 ? Math.min(96, Math.max(12, Math.round((appliedFileCount(state) / total) * 100))) : 12;
  }
  if (state.phase === "error") return 100;
  return state.operation ? 8 : 0;
}

export function normalizeDevice(device: DeviceEntry): NormalizedDevice {
  const status = objectValue(device.last_status);
  const runtime = objectValue(device.runtime ?? status.runtime);
  const system = objectValue(status.system);
  const systemSummary = objectValue(device.system_summary ?? status.system_summary);
  const logging = objectValue(device.logging ?? status.logging ?? runtime.logging);
  const matrix = objectValue(device.matrix_shape ?? status.matrix_shape ?? systemSummary.matrix_shape);
  const battery = objectValue(status.battery);
  const gatewayState = objectValue(device.gateway_state);
  const gatewayConnected = device.gateway_connected === true || gatewayState.connected === true;
  const eventSeenAt = stringValue(device.last_seen_at ?? status.received_at ?? device.last_gateway_seen_at, "");
  const lastSeenAt = stringValue(device.last_live_seen_at ?? eventSeenAt, "");
  const isBooting = device.booting === true || status.booting === true;
  const isReconnecting = Boolean(
    !isBooting
      && !gatewayConnected
      && eventSeenAt
      && Date.now() - dateValue(eventSeenAt) <= RECONNECTING_GRACE_MS,
  );
  const offline = Boolean(!isBooting && !gatewayConnected && !isReconnecting);
  const rawMode = stringValue(device.mode ?? status.mode ?? runtime.mode, "normal");
  const mode = isBooting ? "booting" : rawMode;
  const connectionState = isBooting ? "booting" : isReconnecting ? "reconnecting" : offline ? "offline" : "online";
  const nickname = stringValue(device.nickname, "");
  const deviceGroup = stringValue(device.device_group, "");
  const name = stringValue(device.device_name ?? status.device_name ?? system.name, device.device_uid);
  const displayName = stringValue(device.display_name ?? nickname, name);
  const firmwareVersion = stringValue(system.firmware_version ?? runtime.firmware_version ?? status.firmware_version ?? device.firmware_version ?? systemSummary.firmware_version, "unknown");
  const protocol = stringValue(device.protocol ?? status.protocol ?? runtime.protocol, "unknown");
  const hardwareModel = stringValue(system.hardware_model ?? status.hardware_model ?? device.hardware_model ?? systemSummary.hardware_model, "unknown");
  const findme = objectValue(device.findme ?? status.findme ?? runtime.findme);
  const transport = objectValue(runtime.transport);
  const transportMode = stringValue(device.transport_mode ?? transport.mode, "-");
  const loggingLabel = logging.enabled === false ? "off" : stringValue(logging.capacity, "-");
  const rows = Number(matrix.rows ?? 0);
  const cols = Number(matrix.cols ?? 0);
  const matrixShape = rows > 0 && cols > 0 ? `${rows} x ${cols}` : "-";
  const batteryState = batteryStateOf(battery);
  const batteryLabel = batteryState || "-";
  const lastSeen = formatLastSeen(lastSeenAt);
  return {
    uid: device.device_uid,
    name,
    nickname,
    deviceGroup,
    displayName,
    mode,
    connectionState,
    isReconnecting,
    // isOffline: !isBooting once reconnect grace expires and control is unavailable.
    isOffline: connectionState === "offline",
    isControlUnavailable: connectionState === "reconnecting" || connectionState === "offline",
    firmwareVersion,
    protocol,
    hardwareModel,
    findme,
    systemSummary,
    transportMode,
    logging: loggingLabel,
    matrixShape,
    battery: batteryLabel,
    batteryState,
    lastSeen,
    lastSeenAt,
    raw: device,
  };
}

export function useDevicesPolling(intervalMs = 1000) {
  void intervalMs;
  const { devices, errorMessage, requestDeviceSnapshot } = useWsState();
  const [clockTick, setClockTick] = useState(0);

  useEffect(() => {
    const intervalId = window.setInterval(() => {
      setClockTick((current) => current + 1);
    }, 1000);
    return () => {
      window.clearInterval(intervalId);
    };
  }, []);

  const refresh = useCallback(async () => {
    try {
      requestDeviceSnapshot();
    } catch (error) {
      // The shared WebSocket state carries the connection error; keep this helper API stable.
    }
  }, [requestDeviceSnapshot]);

  const boostPolling = useCallback((durationMs = 8000) => {
    void durationMs;
    requestDeviceSnapshot();
  }, [requestDeviceSnapshot]);

  const normalized = useMemo(() => {
    void clockTick;
    return devices.map(normalizeDevice);
  }, [clockTick, devices]);
  return { devices, normalized, errorMessage, refresh, boostPolling };
}

export function resultToken(result: Record<string, unknown> | null | undefined) {
  if (!result) return "";
  return String(result.request_id ?? result.received_at ?? valueToCsv(result));
}

export function statusToken(status: Record<string, unknown> | null | undefined) {
  if (!status) return "";
  return String(status.received_at ?? status.last_seen_at ?? valueToCsv(status));
}

export function deviceStatusToken(device: DeviceEntry | undefined) {
  return `${device?.last_seen_at ?? ""}|${statusToken(device?.last_status)}`;
}

export function resultFromState(command: string, requestId: string, state: UpdateState): Record<string, unknown> | null {
  if (command === "check_update" && state.operation === command && state.phase === "ready") {
    return {
      status: "ok",
      message: "update_checked",
      command,
      request_id: requestId,
      latest_version: state.version ?? "",
      manifest_url: state.manifest_url ?? "",
      changelog_url: state.changelog_url ?? "",
      update_state: state,
      reboot_required: false,
    };
  }
  if (command === "apply_update" && state.operation === command && (state.phase === "done" || isAppliedComplete(state))) {
    const resultState = isAppliedComplete(state)
      ? { ...state, phase: "done", current_file: "", last_result: "applied", reboot_required: true }
      : state;
    return {
      status: "ok",
      message: "update_applied",
      command,
      request_id: requestId,
      version: resultState.version ?? "",
      downloaded_files: Number(resultState.downloaded_files ?? 0),
      skipped_files: Number(resultState.skipped_files ?? 0),
      deleted_files: Number(resultState.deleted_files ?? 0),
      update_state: resultState,
      reboot_required: Boolean(resultState.reboot_required ?? true),
    };
  }
  return null;
}

function statusSnapshotResult(command: string, requestId: string, device: DeviceEntry | undefined): Record<string, unknown> | null {
  if (!STATUS_SNAPSHOT_COMMANDS.has(command)) return null;
  const status = objectValue(device?.last_status);
  if (Object.keys(status).length === 0) return null;
  return {
    ...status,
    command,
    request_id: requestId,
  };
}

function streamBufferResult(requestId: string, device: DeviceEntry | undefined): Record<string, unknown> | null {
  const status = objectValue(device?.last_status);
  const runtime = objectValue(status.runtime);
  const streamBuffer = objectValue(status.stream_buffer ?? runtime.stream_buffer);
  if (Object.keys(streamBuffer).length === 0) return null;
  const scanHealth = objectValue(status.scan_health);
  const result: Record<string, unknown> = {
    status: "ok",
    message: "stream_buffer_updated",
    command: "set_stream_buffer",
    request_id: requestId,
    stream_buffer: streamBuffer,
  };
  if (Object.keys(scanHealth).length > 0) {
    result.scan_health = scanHealth;
  }
  return result;
}

export function resultFromDeviceState(command: string, requestId: string, device: DeviceEntry | undefined): Record<string, unknown> | null {
  const stateResult = resultFromState(command, requestId, updateStateOf(device));
  if (stateResult) return stateResult;
  const snapshotResult = statusSnapshotResult(command, requestId, device);
  if (snapshotResult) return snapshotResult;
  if (command === "set_stream_buffer") {
    return streamBufferResult(requestId, device);
  }
  return null;
}
