import { useCallback, useState } from "react";

import { api, type DeviceEntry } from "./api";
import { normalizeCommandResult } from "./commandResult";
import { deviceStatusToken, resultFromDeviceState } from "./device";
import { sendDeviceCommand } from "./wsClient";

function sleep(ms: number) {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

function findDevice(items: DeviceEntry[], deviceUid: string) {
  return items.find((device) => device.device_uid === deviceUid);
}

async function waitForResult(
  deviceUid: string,
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
      return normalizeCommandResult(result);
    }
    if (device && deviceStatusToken(device) !== previousStatusToken) {
      const stateResult = resultFromDeviceState(command, requestId, device);
      if (stateResult) {
        return normalizeCommandResult(stateResult);
      }
    }
  }
  return null;
}

/**
 * Marks a command the software sends on its own -- a poll or an automatic
 * refresh -- so the device (firmware v1.7.2+) skips its received/success LED
 * flashes. Without it a poll keeps the status LED flashing, and the flash
 * outranks an app's colour. Never for something an operator clicked: that
 * flash is the only confirmation the device gives. Older firmware ignores it.
 */
export function quietCommand(payload: Record<string, unknown>): Record<string, unknown> {
  return { ...payload, quiet: true };
}

/**
 * One read for a repeating poll: over the WebSocket only, with none of
 * useDeviceCommand's bookkeeping -- no device-list fetch before the command, no
 * REST fallback, no running state to re-render the page. A poll that gets no
 * answer is simply retried on its next tick, so result null is not an error.
 */
export async function pollDeviceCommand(
  deviceUid: string,
  payload: Record<string, unknown>,
  timeoutMs = 4000,
): Promise<{ result: Record<string, unknown> | null }> {
  const response = await sendDeviceCommand(deviceUid, quietCommand(payload), timeoutMs);
  return { result: response.result ? normalizeCommandResult(response.result) : null };
}

export function useDeviceCommand(deviceUid: string) {
  const [running, setRunning] = useState(false);
  const [errorMessage, setErrorMessage] = useState("");

  const queue = useCallback(async (payload: Record<string, unknown>, timeoutMs?: number) => {
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
          return { queued: response.queued, result: normalizeCommandResult(response.result) };
        }
        const requestId = response.queued?.request_id ?? String(response.queued?.items[0]?.payload?.request_id ?? payload.request_id ?? "");
        const queuedCommand = String(payload.command ?? response.queued?.items[0]?.payload?.command ?? "");
        const result = requestId ? await waitForResult(deviceUid, requestId, queuedCommand, previousStatusToken, defaultTimeout) : null;
        return { queued: response.queued, result };
      } catch {
        const queued = await api.queueDeviceCommand(deviceUid, payload);
        const requestId = queued.request_id ?? String(queued.items[0]?.payload?.request_id ?? "");
        const queuedCommand = String(payload.command ?? queued.items[0]?.payload?.command ?? "");
        const result = requestId ? await waitForResult(deviceUid, requestId, queuedCommand, previousStatusToken, defaultTimeout) : null;
        return { queued, result };
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "device_command_failed";
      setErrorMessage(message);
      throw error;
    } finally {
      setRunning(false);
    }
  }, [deviceUid]);

  return { queue, running, errorMessage };
}
