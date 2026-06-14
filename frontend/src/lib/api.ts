import { appHref } from "./runtime";

export type DeviceEntry = {
  device_uid: string;
  device_name?: string;
  nickname?: string;
  display_name?: string;
  channel?: string;
  mode?: "normal" | "maintenance" | "safe_maintenance" | string;
  transport_mode?: string;
  transport_path?: string;
  matrix_shape?: { rows: number; cols: number };
  logging?: { enabled?: boolean; capacity?: string; serial?: string };
  services?: Record<string, unknown>[];
  update_state?: Record<string, unknown> | null;
  system_summary?: Record<string, unknown> | null;
  runtime?: Record<string, unknown> | null;
  firmware_version?: string;
  hardware_model?: string;
  protocol?: string;
  findme?: Record<string, unknown> | null;
  scan_stopped?: boolean;
  booting?: boolean;
  gateway_connected?: boolean;
  gateway_id?: string;
  last_gateway_seen_at?: string;
  gateway_state?: Record<string, unknown> | null;
  last_seen_at?: string;
  last_heartbeat_at?: string;
  last_status?: Record<string, unknown> | null;
  last_result?: Record<string, unknown> | null;
  latest_sample?: VisualizationEntry;
  recording_enabled?: boolean;
  recording_error?: string;
};

export type BackendHealth = {
  status: string;
  transport_mode: string;
  udp_started: boolean;
  devices_seen: number;
  visualization?: {
    udp_received_fps?: number;
    udp_received_frames?: number;
  };
  websocket?: {
    clients?: number;
    dropped_visualization?: number;
    ws_coalesced_frames?: number;
    ws_sent_frames?: number;
    ws_sent_fps?: number;
  };
};

export type VisualizationEntry = {
  dn: string;
  sn: number;
  p: number[];
  ts?: number;
  timestamp_ms?: number;
  received_at_ms?: number;
  device_udp_fps?: number;
  target_fps?: number;
  mag?: number[] | null;
  acc?: number[] | null;
  gyro?: number[] | null;
  imu?: {
    acc?: number[];
    gyro?: number[];
    mag?: number[];
    temperature_c?: number;
  } | null;
};

export type GatewayClaimEntry = {
  claim_id: string;
  device_uid?: string;
  gateway_id?: string;
  state?: string;
  reason?: string;
  error?: string;
  created_at?: string;
  updated_at?: string;
  expires_at?: string;
  ttl_ms?: number;
};

export type GatewayEntry = {
  gateway_id: string;
  gateway_name?: string;
  status?: string;
  last_seen?: string;
  version?: string;
  target_mode?: string;
  server_url?: string;
  upstream_path?: string;
  upstream?: Record<string, unknown> | null;
  local_ports?: {
    udp?: number;
    findme?: number;
    web?: number;
  };
  serving_devices?: string[];
  serving_device_count?: number;
  denied_devices?: string[];
  denied_count?: number;
  udp_forwarded?: number;
  udp_dropped?: number;
  last_error?: string;
  claims?: GatewayClaimEntry[];
};

export type ProfileListEntry = {
  name: string;
  displayName: string;
};

export type TerminalHelpEntry = {
  command: string;
  description: string;
  example: string;
};

export type QueuedCommandResponse = {
  status: string;
  request_id?: string;
  items: {
    status: string;
    transport?: string;
    peer?: string;
    device_uid: string;
    payload: Record<string, unknown>;
    mock?: boolean;
  }[];
};

export type TerminalExecuteResponse = {
  status: string;
  request_id: string;
  compiled: {
    command: string;
    payload: Record<string, unknown>;
    argv: string[];
    request_id?: string;
  };
  transport: {
    status: string;
    transport?: string;
    peer?: string;
    device_uid: string;
    payload: Record<string, unknown>;
    mock?: boolean;
    warning?: string;
  };
};

export type DeviceFileEntry = {
  scope: "user" | "logs" | "calibration" | string;
  path: string;
  name?: string;
  size?: number;
  is_dir?: boolean;
  kind?: string;
};

export type CsvExplorerEntry = {
  name: string;
  path: string;
  is_dir: boolean;
  size: number;
  kind: "directory" | "csv" | string;
};

export type CsvDirectoryResponse = {
  device_uid: string;
  path: string;
  parent_path: string;
  items: CsvExplorerEntry[];
};

export type CsvPreviewResponse = {
  path: string;
  name: string;
  size: number;
  columns: number;
  row_count_previewed: number;
  has_header: boolean;
  header: string[];
  rows: string[][];
};

export type WikiDeviceEntry = {
  slug: string;
  name: string;
  path: string;
  document_count: number;
};

export type WikiEntry = {
  name: string;
  path: string;
  is_dir: boolean;
  kind: string;
  size?: number;
};

export type WikiDirectoryResponse = {
  device: string;
  path: string;
  items: WikiEntry[];
};

export type WikiDocumentResponse = {
  device: string;
  path: string;
  name: string;
  content: string;
  github_url: string;
  raw_url: string;
};

export type AuthSession = {
  authenticated: boolean;
  username?: string;
  role?: "admin" | "user" | string;
};

export type PressureCalSettings = {
  url: string;
  token_hint: string;
  configured: boolean;
};

export type PressureCalHealth = {
  uno: {
    configured_port: string;
    connected: boolean;
    last_error: string | null;
    last_observed_at: string | null;
  };
  imada: {
    configured_port: string;
    connected: boolean;
    last_error: string | null;
    last_observed_at: string | null;
  };
};

export type PressureCalUnoReading = {
  pressure_kpa: number;
  target_kpa: number;
  adc: number;
  voltage: number;
  control_enabled: boolean;
  hold_mode: boolean;
  valve_open: boolean;
  observed_at: string;
};

export type PressureCalImadaReading = {
  value: number;
  unit: string;
  raw_status: string;
  raw_line: string;
  observed_at: string;
};

export type PressureCalReadings = {
  uno: PressureCalUnoReading;
  imada: PressureCalImadaReading;
};

export class RequestError extends Error {
  status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = "RequestError";
    this.status = status;
  }
}

const API_BASE = appHref("api");

function collapseWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

async function readResponsePayload(response: Response): Promise<{
  contentType: string;
  text: string;
  payload: unknown | null;
}> {
  const contentType = (response.headers.get("content-type") ?? "").toLowerCase();
  const text = await response.text();
  if (contentType.includes("application/json") && text) {
    return { contentType, text, payload: JSON.parse(text) };
  }
  return { contentType, text, payload: null };
}

type JsonRequestInit = Omit<RequestInit, "body"> & {
  body?: unknown;
};

async function request<T>(path: string, init?: JsonRequestInit): Promise<T> {
  const body = init && "body" in init && init.body !== undefined ? JSON.stringify(init.body) : undefined;
  const headers = new Headers(init?.headers ?? {});
  headers.set("Accept", "application/json");
  if (body && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }

  const response = await fetch(`${API_BASE}${path}`, {
    credentials: "same-origin",
    ...init,
    headers,
    body,
  });
  const payload = await readResponsePayload(response);

  if (!response.ok) {
    let detail = response.statusText;
    if (payload.payload && typeof payload.payload === "object") {
      const data = payload.payload as Record<string, unknown>;
      detail = String(data.error ?? data.detail ?? data.message ?? detail);
    } else if (payload.text) {
      const snippet = collapseWhitespace(payload.text).slice(0, 180);
      if (snippet) detail = snippet;
    }
    throw new RequestError(detail || "request_failed", response.status);
  }

  if (payload.payload === null) {
    const snippet = collapseWhitespace(payload.text).slice(0, 180);
    throw new RequestError(
      snippet ? `Expected JSON response but received: ${snippet}` : `Expected JSON response from ${API_BASE}${path}`,
      response.status,
    );
  }

  return payload.payload as T;
}

async function requestRaw(path: string): Promise<Uint8Array> {
  const response = await fetch(`${API_BASE}${path}`, {
    credentials: "same-origin",
    headers: { Accept: "application/octet-stream,application/json" },
  });
  if (!response.ok) throw new Error(response.statusText || "request_failed");
  return new Uint8Array(await response.arrayBuffer());
}

export const api = {
  authMe: () => request<AuthSession>("/auth/me"),
  login: (username: string, password: string) =>
    request<{ status: string; user: AuthSession }>("/auth/login", {
      method: "POST",
      body: { username, password },
    }),
  logout: () => request<{ status: string }>("/auth/logout", { method: "POST" }),
  health: () => request<BackendHealth>("/health"),
  devices: () => request<{ items: DeviceEntry[] }>("/devices"),
  gateways: () => request<{ items: GatewayEntry[] }>("/gateways"),
  deleteGateway: (gatewayId: string) =>
    request<{ status: string; gateway_id: string }>(`/gateways/${encodeURIComponent(gatewayId)}`, {
      method: "DELETE",
    }),
  visualization: () => request<{ items: VisualizationEntry[] }>("/visualization/latest"),
  terminalHelp: () => request<{ items: TerminalHelpEntry[] }>("/terminal/help"),
  queueDeviceCommand: (deviceUid: string, payload: Record<string, unknown>) =>
    request<QueuedCommandResponse>("/device-command", {
      method: "POST",
      body: { device_uid: deviceUid, payload },
    }),
  executeTerminal: (deviceUid: string, commandLine: string) =>
    request<TerminalExecuteResponse>("/terminal/execute", {
      method: "POST",
      body: { device_uid: deviceUid, command_line: commandLine },
    }),
  saveDeviceNickname: (deviceUid: string, nickname: string) =>
    request<{ status: string; device_uid: string; nickname: string }>(`/devices/${encodeURIComponent(deviceUid)}/nickname`, {
      method: "PUT",
      body: { nickname },
    }),
  profiles: () => request<{ items: ProfileListEntry[] }>("/profiles"),
  profile: (name: string) => request<Record<string, unknown>>(`/profiles/${encodeURIComponent(name)}`),
  profileRaw: (name: string) => requestRaw(`/profiles/${encodeURIComponent(name)}`),
  saveProfile: (name: string, payload: unknown) =>
    request(`/profiles/${encodeURIComponent(name)}`, {
      method: "POST",
      body: payload,
    }),
  deleteProfile: (name: string) =>
    request(`/profiles/${encodeURIComponent(name)}`, {
      method: "DELETE",
    }),
  csvDirectory: (deviceUid: string, path = "") =>
    request<CsvDirectoryResponse>(`/files?device_uid=${encodeURIComponent(deviceUid)}&path=${encodeURIComponent(path)}`),
  previewCsv: (deviceUid: string, path: string) =>
    request<CsvPreviewResponse>(`/files/preview?device_uid=${encodeURIComponent(deviceUid)}&path=${encodeURIComponent(path)}`),
  wikiDevices: () => request<{ items: WikiDeviceEntry[] }>("/wiki/devices"),
  wikiDirectory: (device: string, path = "") =>
    request<WikiDirectoryResponse>(`/wiki?device=${encodeURIComponent(device)}&path=${encodeURIComponent(path)}`),
  wikiDocument: (device: string, path: string) =>
    request<WikiDocumentResponse>(`/wiki/document?device=${encodeURIComponent(device)}&path=${encodeURIComponent(path)}`),
  deleteCsvEntry: (deviceUid: string, path: string) =>
    request<{ status: string; deleted_path: string; deleted_kind: "file" | "directory" }>(
      `/files?device_uid=${encodeURIComponent(deviceUid)}&path=${encodeURIComponent(path)}`,
      { method: "DELETE" },
    ),
  downloadCsvUrl: (path: string) => `${API_BASE}/files/download?path=${encodeURIComponent(path)}`,
  pressureCalSettings: () => request<PressureCalSettings>("/pressure-cal/settings"),
  savePressureCalSettings: (url: string, token: string) =>
    request<{ status: string }>("/pressure-cal/settings", {
      method: "POST",
      body: { url, token },
    }),
  pressureCalHealth: () => request<PressureCalHealth>("/pressure-cal/health"),
  pressureCalReadings: () => request<PressureCalReadings>("/pressure-cal/readings"),
  pressureCalSetTarget: (kpa: number) =>
    request<{ accepted: boolean; target_kpa: number; command: string; observed_at: string }>(
      "/pressure-cal/target",
      { method: "POST", body: { target_kpa: kpa } },
    ),
  pressureCalStop: () =>
    request<{ accepted: boolean; command: string; observed_at: string }>("/pressure-cal/stop", {
      method: "POST",
    }),
};
