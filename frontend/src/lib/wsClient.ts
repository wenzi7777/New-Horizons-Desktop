import { useEffect, useState } from "react";

import type { DeviceEntry, GatewayClaimEntry, GatewayEntry, QueuedCommandResponse, VisualizationEntry } from "./api";
import { wsHref } from "./runtime";
import { shouldPublishGlobalWsError } from "./wsErrorPolicy";

type WsConnectionStatus = "connecting" | "connected" | "disconnected";

type WsState = {
  status: WsConnectionStatus;
  errorMessage: string;
  devices: DeviceEntry[];
  gateways: GatewayEntry[];
  visualizations: VisualizationEntry[];
  recording: Record<string, boolean>;
};

type PendingCommand = {
  queued: QueuedCommandResponse | null;
  resolve: (value: { queued: QueuedCommandResponse | null; result: Record<string, unknown> | null }) => void;
  reject: (error: Error) => void;
  timer: number;
};

const subscribers = new Set<(state: WsState) => void>();
const pendingCommands = new Map<string, PendingCommand>();
const subscribedVisualizations = new Set<string>();
const pendingVisualizationFrames = new Map<string, VisualizationEntry>();
const VISUALIZATION_UI_TARGET_FPS = 60;
const VISUALIZATION_UI_FRAME_INTERVAL_MS = 1000 / VISUALIZATION_UI_TARGET_FPS;

let state: WsState = {
  status: "disconnected",
  errorMessage: "",
  devices: [],
  gateways: [],
  visualizations: [],
  recording: {},
};

let socket: WebSocket | null = null;
let reconnectTimer = 0;
let reconnectAttempt = 0;
let gatewaySnapshotRequested = false;
let visualizationFlushFrame = 0;
let visualizationFlushTimer = 0;
let lastVisualizationFlushAt = 0;

function randomRequestId() {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID().replace(/-/g, "");
  }
  return `${Date.now().toString(16)}${Math.random().toString(16).slice(2)}`;
}

function wsUrl() {
  return wsHref("ws");
}

function publish(next: Partial<WsState>) {
  state = { ...state, ...next };
  subscribers.forEach((subscriber) => subscriber(state));
}

function normalizeUid(value: unknown) {
  const raw = String(value ?? "").trim().toUpperCase();
  const collapsed = raw.replace(/[:\-\s]/g, "");
  return collapsed && /^[0-9A-F]+$/.test(collapsed) ? collapsed : raw;
}

function mergeDevice(item: DeviceEntry) {
  const next = state.devices.slice();
  const index = next.findIndex((device) => device.device_uid === item.device_uid);
  if (index >= 0) {
    next[index] = { ...next[index], ...item };
  } else {
    next.push(item);
  }
  next.sort((a, b) => a.device_uid.localeCompare(b.device_uid));
  publish({ devices: next });
}

function mergeGateway(item: GatewayEntry) {
  if (!item.gateway_id) return;
  const next = state.gateways.slice();
  const index = next.findIndex((gateway) => gateway.gateway_id === item.gateway_id);
  if (index >= 0) {
    next[index] = { ...next[index], ...item };
  } else {
    next.push(item);
  }
  next.sort((a, b) => a.gateway_id.localeCompare(b.gateway_id));
  publish({ gateways: next });
}

function mergeGatewayClaim(claim: GatewayClaimEntry) {
  const gatewayId = String(claim.gateway_id ?? "");
  const claimId = String(claim.claim_id ?? "");
  if (!gatewayId || !claimId) return;
  const next = state.gateways.slice();
  const index = next.findIndex((gateway) => gateway.gateway_id === gatewayId);
  if (index < 0) return;
  const claims = Array.isArray(next[index].claims) ? next[index].claims!.slice() : [];
  const claimIndex = claims.findIndex((existing) => existing.claim_id === claimId);
  if (claimIndex >= 0) {
    claims[claimIndex] = { ...claims[claimIndex], ...claim };
  } else {
    claims.unshift(claim);
  }
  next[index] = { ...next[index], claims: claims.slice(0, 12) };
  publish({ gateways: next });
}

function mergeVisualization(item: VisualizationEntry) {
  const receivedAt =
    typeof performance !== "undefined" && typeof performance.now === "function"
      ? performance.now()
      : Date.now();
  const stamped = { ...item, received_at_ms: receivedAt };
  const deviceUid = normalizeUid(stamped.dn);
  if (!deviceUid) return;
  pendingVisualizationFrames.set(deviceUid, stamped);
  scheduleVisualizationFlush();
}

function scheduleVisualizationFlush() {
  if (visualizationFlushFrame || visualizationFlushTimer) return;
  const now =
    typeof performance !== "undefined" && typeof performance.now === "function"
      ? performance.now()
      : Date.now();
  const delayMs = Math.max(0, VISUALIZATION_UI_FRAME_INTERVAL_MS - (now - lastVisualizationFlushAt));
  if (delayMs > 1) {
    visualizationFlushTimer = window.setTimeout(() => {
      visualizationFlushTimer = 0;
      visualizationFlushFrame = window.requestAnimationFrame(flushVisualizationFrames);
    }, delayMs);
    return;
  }
  visualizationFlushFrame = window.requestAnimationFrame(flushVisualizationFrames);
}

function flushVisualizationFrames(now: number) {
  visualizationFlushFrame = 0;
  lastVisualizationFlushAt = now;
  if (pendingVisualizationFrames.size === 0) return;
  const byDevice = new Map<string, VisualizationEntry>();
  state.visualizations.forEach((entry) => {
    const deviceUid = normalizeUid(entry.dn);
    if (deviceUid) byDevice.set(deviceUid, entry);
  });
  pendingVisualizationFrames.forEach((entry, deviceUid) => {
    byDevice.set(deviceUid, entry);
  });
  pendingVisualizationFrames.clear();
  const next = Array.from(byDevice.values()).sort((a, b) => a.dn.localeCompare(b.dn));
  publish({ visualizations: next });
}

function send(message: Record<string, unknown>) {
  ensureWsConnected();
  if (!socket || socket.readyState !== WebSocket.OPEN) {
    throw new Error("websocket_not_connected");
  }
  socket.send(JSON.stringify(message));
}

function scheduleReconnect() {
  if (reconnectTimer) return;
  const delay = Math.min(1000 * Math.max(1, 2 ** reconnectAttempt), 8000);
  reconnectTimer = window.setTimeout(() => {
    reconnectTimer = 0;
    reconnectAttempt += 1;
    connectWebSocket();
  }, delay);
}

function connectWebSocket() {
  if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) {
    return;
  }
  publish({ status: "connecting" });
  socket = new WebSocket(wsUrl());
  socket.binaryType = "arraybuffer";
  socket.addEventListener("open", () => {
    reconnectAttempt = 0;
    publish({ status: "connected", errorMessage: "" });
    send({ type: "hello" });
    send({ type: "subscribe_devices" });
    if (gatewaySnapshotRequested) {
      send({ type: "subscribe_gateways" });
    }
    subscribedVisualizations.forEach((deviceUid) => send({ type: "subscribe_visualization", device_uid: deviceUid }));
  });
  socket.addEventListener("message", async (event) => {
    try {
      const raw = event.data instanceof Blob ? await event.data.text() : event.data;
      const text =
        raw instanceof ArrayBuffer
          ? new TextDecoder().decode(raw)
          : typeof raw === "string"
            ? raw
            : String(raw);
      const message = JSON.parse(text);
      if (message && typeof message === "object") {
        handleMessage(message as Record<string, unknown>);
      }
    } catch {
      publish({ errorMessage: "invalid_websocket_message" });
    }
  });
  socket.addEventListener("close", () => {
    publish({ status: "disconnected" });
    scheduleReconnect();
  });
  socket.addEventListener("error", () => {
    publish({ status: "disconnected", errorMessage: "websocket_error" });
  });
}

function handleMessage(message: Record<string, unknown>) {
  const type = String(message.type ?? "");
  if (type === "device_snapshot" && Array.isArray(message.items)) {
    const devices = message.items as DeviceEntry[];
    const activeUids = new Set(devices.map((device) => normalizeUid(device.device_uid)).filter(Boolean));
    Array.from(pendingVisualizationFrames.keys()).forEach((deviceUid) => {
      if (!activeUids.has(deviceUid)) pendingVisualizationFrames.delete(deviceUid);
    });
    publish({
      devices,
      visualizations: state.visualizations.filter((item) => activeUids.has(normalizeUid(item.dn))),
    });
    return;
  }
  if (type === "device_update" && message.item && typeof message.item === "object") {
    mergeDevice(message.item as DeviceEntry);
    return;
  }
  if (type === "gateway_snapshot" && Array.isArray(message.items)) {
    publish({ gateways: message.items as GatewayEntry[] });
    return;
  }
  if (type === "gateway_update" && message.item && typeof message.item === "object") {
    mergeGateway(message.item as GatewayEntry);
    return;
  }
  if (type === "gateway_claim_update") {
    mergeGatewayClaim(message as GatewayClaimEntry);
    return;
  }
  if (type === "visualization_snapshot" && Array.isArray(message.items)) {
    for (const item of message.items) {
      if (item && typeof item === "object") mergeVisualization(item as VisualizationEntry);
    }
    return;
  }
  if (type === "visualization_update" && message.data && typeof message.data === "object") {
    mergeVisualization(message.data as VisualizationEntry);
    return;
  }
  if (type === "recording_update") {
    const deviceUid = String(message.device_uid ?? "");
    const enabled = Boolean(message.enabled);
    if (deviceUid) {
      const errorText = String(message.error ?? "");
      publish({
        recording: { ...state.recording, [deviceUid]: enabled },
        errorMessage: errorText || state.errorMessage,
      });
      mergeDevice({ device_uid: deviceUid, recording_enabled: enabled, recording_error: errorText } as DeviceEntry);
    }
    return;
  }
  if (type === "command_queued") {
    const requestId = String(message.request_id ?? "");
    const pending = pendingCommands.get(requestId);
    if (pending) {
      pending.queued = {
        status: "queued",
        request_id: requestId,
        items: [message.transport as QueuedCommandResponse["items"][number]],
      };
      publish({ errorMessage: "" });
    }
    return;
  }
  if (type === "command_result") {
    const requestId = String(message.request_id ?? "");
    const pending = pendingCommands.get(requestId);
    if (pending) {
      window.clearTimeout(pending.timer);
      pendingCommands.delete(requestId);
      pending.resolve({
        queued: pending.queued,
        result: (message.result as Record<string, unknown>) ?? null,
      });
      publish({ errorMessage: "" });
    }
    return;
  }
  if (type === "error") {
    const requestId = String(message.request_id ?? "");
    const messageText = String(message.message ?? message.code ?? "websocket_error");
    const hasPendingCommand = Boolean(requestId && pendingCommands.has(requestId));
    if (requestId && pendingCommands.has(requestId)) {
      const pending = pendingCommands.get(requestId);
      if (pending) {
        window.clearTimeout(pending.timer);
        pendingCommands.delete(requestId);
        pending.reject(new Error(messageText));
      }
    }
    if (shouldPublishGlobalWsError(message, hasPendingCommand)) {
      publish({ errorMessage: messageText });
    }
  }
}

export function ensureWsConnected() {
  connectWebSocket();
}

export function disconnectWebSocket() {
  if (reconnectTimer) {
    window.clearTimeout(reconnectTimer);
    reconnectTimer = 0;
  }
  reconnectAttempt = 0;
  if (visualizationFlushFrame) {
    window.cancelAnimationFrame(visualizationFlushFrame);
    visualizationFlushFrame = 0;
  }
  if (visualizationFlushTimer) {
    window.clearTimeout(visualizationFlushTimer);
    visualizationFlushTimer = 0;
  }
  pendingVisualizationFrames.clear();
  subscribedVisualizations.clear();
  gatewaySnapshotRequested = false;
  if (socket) {
    try {
      socket.close();
    } catch {
      // Ignore browser close errors.
    }
    socket = null;
  }
  publish({
    status: "disconnected",
    errorMessage: "",
    gateways: [],
    visualizations: [],
    recording: {},
  });
}

export function requestDeviceSnapshot() {
  ensureWsConnected();
  if (socket && socket.readyState === WebSocket.OPEN) {
    send({ type: "subscribe_devices" });
  }
}

export function requestGatewaySnapshot() {
  gatewaySnapshotRequested = true;
  ensureWsConnected();
  if (socket && socket.readyState === WebSocket.OPEN) {
    send({ type: "subscribe_gateways" });
  }
}

export function subscribeVisualization(deviceUid: string) {
  if (!deviceUid) return;
  subscribedVisualizations.add(deviceUid);
  ensureWsConnected();
  if (socket && socket.readyState === WebSocket.OPEN) {
    send({ type: "subscribe_visualization", device_uid: deviceUid });
  }
}

export function unsubscribeVisualization(deviceUid: string) {
  if (!deviceUid) return;
  subscribedVisualizations.delete(deviceUid);
  if (socket && socket.readyState === WebSocket.OPEN) {
    send({ type: "unsubscribe_visualization", device_uid: deviceUid });
  }
}

export function setRecording(deviceUid: string, enabled: boolean) {
  send({ type: "recording_set", device_uid: deviceUid, enabled });
}

export function sendDeviceCommand(deviceUid: string, payload: Record<string, unknown>, timeoutMs = 20000) {
  if (!deviceUid) return Promise.reject(new Error("device_uid_required"));
  const requestId = String(payload.request_id ?? randomRequestId());
  const commandPayload = { ...payload, request_id: requestId };
  const promise = new Promise<{ queued: QueuedCommandResponse | null; result: Record<string, unknown> | null }>((resolve, reject) => {
    const timer = window.setTimeout(() => {
      const pending = pendingCommands.get(requestId);
      if (pending) {
        pendingCommands.delete(requestId);
        resolve({ queued: pending.queued, result: null });
      }
    }, timeoutMs);
    pendingCommands.set(requestId, { queued: null, resolve, reject, timer });
  });
  try {
    send({ type: "command", device_uid: deviceUid, request_id: requestId, payload: commandPayload });
  } catch (error) {
    const pending = pendingCommands.get(requestId);
    if (pending) {
      window.clearTimeout(pending.timer);
      pendingCommands.delete(requestId);
    }
    return Promise.reject(error);
  }
  return promise;
}

export function useWsState() {
  const [snapshot, setSnapshot] = useState(state);
  useEffect(() => {
    ensureWsConnected();
    subscribers.add(setSnapshot);
    return () => {
      subscribers.delete(setSnapshot);
    };
  }, []);
  return {
    ...snapshot,
    requestDeviceSnapshot,
    requestGatewaySnapshot,
    subscribeVisualization,
    unsubscribeVisualization,
    setRecording,
    sendDeviceCommand,
  };
}
