import { useState } from "react";

import { api, type DeviceEntry } from "./api";
import { deviceStatusToken, resultFromDeviceState } from "./device";
import { sendDeviceCommand } from "./wsClient";

function sleep(ms: number) {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

function findDevice(items: DeviceEntry[], deviceUid: string) {
  return items.find((device) => device.device_uid === deviceUid);
}

export function useDeviceCommand(deviceUid: string) {
  const [running, setRunning] = useState(false);
  const [errorMessage, setErrorMessage] = useState("");

  async function waitForResult(
    requestId: string,
    command: string,
    previousStatusToken = "",
    timeoutMs = 20000,
  ) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      await sleep(500);
      const response = await api.devices();
      const device = findDevice(response.items, deviceUid);
      const result = device?.last_result;
      if (result && String(result.request_id ?? "") === requestId) {
        return result as Record<string, unknown>;
      }
      if (device && deviceStatusToken(device) !== previousStatusToken) {
        const stateResult = resultFromDeviceState(command, requestId, device);
        if (stateResult) {
          return stateResult;
        }
      }
    }
    return null;
  }

  async function queue(payload: Record<string, unknown>, timeoutMs?: number) {
    if (!deviceUid) throw new Error("device_uid_required");
    setRunning(true);
    setErrorMessage("");
    try {
      const before = await api.devices();
      const previousDevice = findDevice(before.items, deviceUid);
      const previousStatusToken = deviceStatusToken(previousDevice);
      const command = String(payload.command ?? "");
      const defaultTimeout = timeoutMs ?? (command === "apply_update" ? 90000 : undefined);
      try {
        const response = await sendDeviceCommand(deviceUid, payload, defaultTimeout);
        if (response.result) {
          return { queued: response.queued, result: response.result };
        }
        const requestId = response.queued?.request_id ?? String(response.queued?.items[0]?.payload?.request_id ?? payload.request_id ?? "");
        const queuedCommand = String(payload.command ?? response.queued?.items[0]?.payload?.command ?? "");
        const result = requestId ? await waitForResult(requestId, queuedCommand, previousStatusToken, defaultTimeout) : null;
        return { queued: response.queued, result };
      } catch {
        const queued = await api.queueDeviceCommand(deviceUid, payload);
        const requestId = queued.request_id ?? String(queued.items[0]?.payload?.request_id ?? "");
        const queuedCommand = String(payload.command ?? queued.items[0]?.payload?.command ?? "");
        const result = requestId ? await waitForResult(requestId, queuedCommand, previousStatusToken, defaultTimeout) : null;
        return { queued, result };
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "device_command_failed";
      setErrorMessage(message);
      throw error;
    } finally {
      setRunning(false);
    }
  }

  return { queue, running, errorMessage };
}
