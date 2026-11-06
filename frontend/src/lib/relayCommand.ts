import { useEffect, useState } from "react";

import { useI18n } from "../i18n";
import type { GatewayEntry } from "./api";
import { relayRecord } from "./relayUpdateInfo";
import { sendGatewayCommand } from "./wsClient";

// What the Hub and Gateway management dialogs share: sending a
// gateway_command to the relay itself (backend HUB_COMMANDS /
// GATEWAY_COMMANDS) with a busy/notice state, and following an
// apply_update until the relay comes back on a new version.

export type RelayNoticeKind = "" | "success" | "error";

// i18n keys for the few messages that name the relay ("The Hub did not
// reply." vs "The Gateway did not reply.").
export type RelayCommandText = {
  noReply: string;
  failed: string;
  updateDone: string; // {version}
  updateFailed: string; // {error}
  updateTimeout: string;
};

// How long a requested update may take before the page stops waiting for
// the relay to come back with a new version.
export const RELAY_UPDATE_WAIT_MS = 4 * 60 * 1000;

export type RelayCommandOutcome = { ok: boolean; result: Record<string, unknown> | null };

export function useRelayCommands(relay: GatewayEntry | null, text: RelayCommandText) {
  const { t } = useI18n();
  const [busy, setBusy] = useState("");
  const [notice, setNotice] = useState("");
  const [noticeClass, setNoticeClass] = useState<RelayNoticeKind>("");
  // `updateKey` is the relay's update block when the apply was requested, so
  // an error left over from an earlier attempt is not mistaken for this one.
  const [applying, setApplying] = useState<{ fromVersion: string; startedAt: number; updateKey: string } | null>(null);

  const version = relay?.version ?? "";
  const updateState = relayRecord(relay?.update);

  function showNotice(message: string, kind: RelayNoticeKind) {
    setNotice(message);
    setNoticeClass(kind);
  }

  // An update ends when the relay reconnects with a different version, or
  // reports the attempt failed, or it takes implausibly long.
  useEffect(() => {
    if (!applying) return undefined;
    if (version && version !== applying.fromVersion) {
      setApplying(null);
      showNotice(t(text.updateDone).replace("{version}", version), "success");
      return undefined;
    }
    if (
      updateState.operation === "apply_update" &&
      (updateState.phase === "error" || updateState.phase === "failed") &&
      JSON.stringify(updateState) !== applying.updateKey
    ) {
      setApplying(null);
      showNotice(t(text.updateFailed).replace("{error}", String(updateState.error || "error")), "error");
      return undefined;
    }
    const remaining = applying.startedAt + RELAY_UPDATE_WAIT_MS - Date.now();
    const timer = window.setTimeout(() => {
      setApplying(null);
      showNotice(t(text.updateTimeout), "error");
    }, Math.max(0, remaining));
    return () => window.clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [applying, version, updateState.phase]);

  async function command(name: string, payload: Record<string, unknown> = {}, timeoutMs = 20000): Promise<RelayCommandOutcome> {
    if (!relay) return { ok: false, result: null };
    setBusy(name);
    showNotice("", "");
    try {
      const { result } = await sendGatewayCommand(relay.gateway_id, { command: name, ...payload }, timeoutMs);
      const ok = result !== null && result.ok !== false;
      if (result === null) {
        showNotice(t(text.noReply), "error");
      } else if (!ok && result.message === "remote_management_disabled") {
        // Turned off in the Gateway's own WebUI after this dialog opened.
        showNotice(t("gatewayRemoteManagementOff"), "error");
      } else if (!ok) {
        showNotice(String(result.message ?? t(text.failed)), "error");
      }
      return { ok, result };
    } catch (error) {
      showNotice(error instanceof Error ? error.message : String(error), "error");
      return { ok: false, result: null };
    } finally {
      setBusy("");
    }
  }

  // Sends apply_update and, once the relay accepts it, starts waiting for
  // the new version. The caller reports a refusal its own way.
  async function applyUpdate(): Promise<RelayCommandOutcome> {
    const fromVersion = version;
    const updateKey = JSON.stringify(updateState);
    const outcome = await command("apply_update");
    if (outcome.ok) setApplying({ fromVersion, startedAt: Date.now(), updateKey });
    return outcome;
  }

  return { busy, setBusy, notice, noticeClass, showNotice, command, applying, applyUpdate };
}
