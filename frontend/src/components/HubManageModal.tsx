import { useEffect, useState, type FormEvent } from "react";
import { Link } from "react-router-dom";

import { ChangelogPanel } from "./ChangelogPanel";
import { ConfirmModal } from "./ConfirmModal";
import { useI18n } from "../i18n";
import { api, type GatewayEntry, type HubLanDeviceEntry } from "../lib/api";
import { normalizeUpdateChannel, waitingForStableToCatchUp, type UpdateChannel } from "../lib/versioning";
import { requestGatewaySnapshot, sendGatewayCommand, useWsState } from "../lib/wsClient";
import { Select } from "./Select";

// A Hub's management dialog, laid out like a device's settings page
// (overview cards, section sidebar) but kept as an overlay on the Relays
// page. Everything here talks to the Hub itself through gateway_command
// (backend HUB_COMMANDS), not to a device.

type HubSection = "overview" | "connection" | "clock" | "update" | "devices" | "maintenance";

type Confirm = { kind: "apply_update" } | { kind: "beta_channel" } | { kind: "factory_reset" } | { kind: "delete" };

// How long a requested update may take before the page stops waiting for
// the Hub to come back with a new version.
const UPDATE_WAIT_MS = 4 * 60 * 1000;

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function formatLastSeen(value: unknown) {
  if (!value) return "-";
  const timestamp = Date.parse(String(value));
  if (!Number.isFinite(timestamp)) return String(value);
  const ageMs = Math.max(0, Date.now() - timestamp);
  if (ageMs < 3000) return "now";
  if (ageMs < 60000) return `${Math.round(ageMs / 1000)}s ago`;
  return new Date(timestamp).toLocaleString();
}

function ageLabel(ms: unknown): string {
  if (typeof ms !== "number" || !Number.isFinite(ms)) return "-";
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds} s`;
  const minutes = Math.floor(seconds / 60);
  return minutes < 60 ? `${minutes} m` : `${Math.floor(minutes / 60)} h ${minutes % 60} m`;
}

export function HubManageModal({ gatewayId: routeGatewayId, onClose }: { gatewayId: string; onClose: () => void }) {
  const { t } = useI18n();
  const { gateways } = useWsState();
  const hub: GatewayEntry | null = gateways.find((item) => item.gateway_id === routeGatewayId) ?? null;

  const [section, setSection] = useState<HubSection>("overview");
  const [busy, setBusy] = useState("");
  const [notice, setNotice] = useState("");
  const [noticeClass, setNoticeClass] = useState<"" | "success" | "error">("");
  const [confirm, setConfirm] = useState<Confirm | null>(null);

  // Connection form; seeded from the Hub's own report, then left alone.
  const [gatewayIdDraft, setGatewayIdDraft] = useState("");
  const [targetMode, setTargetMode] = useState("production");
  const [manualUrl, setManualUrl] = useState("");
  const [authToken, setAuthToken] = useState("");
  const [formSeeded, setFormSeeded] = useState(false);

  const [lanDevices, setLanDevices] = useState<HubLanDeviceEntry[]>([]);
  const [lanScanned, setLanScanned] = useState(false);

  // Update flow: the last check_update answer, and an apply in progress.
  const [checkResult, setCheckResult] = useState<Record<string, unknown> | null>(null);
  // `updateKey` is the Hub's update block when the apply was requested, so
  // an error left over from an earlier attempt is not mistaken for this one.
  const [applying, setApplying] = useState<{ fromVersion: string; startedAt: number; updateKey: string } | null>(null);

  useEffect(() => {
    requestGatewaySnapshot();
  }, []);

  useEffect(() => {
    if (!hub || formSeeded) return;
    setGatewayIdDraft(hub.gateway_id);
    setTargetMode(hub.target_mode || "production");
    setManualUrl(hub.server_url || "");
    setFormSeeded(true);
  }, [hub, formSeeded]);

  // An update ends when the Hub reconnects with a different version, or
  // reports the attempt failed, or it takes implausibly long.
  const hubVersion = hub?.version ?? "";
  const updateState = record(hub?.update);
  useEffect(() => {
    if (!applying) return undefined;
    if (hubVersion && hubVersion !== applying.fromVersion) {
      setApplying(null);
      showNotice(t("hubUpdateDone").replace("{version}", hubVersion), "success");
      return undefined;
    }
    if (
      updateState.operation === "apply_update" &&
      updateState.phase === "error" &&
      JSON.stringify(updateState) !== applying.updateKey
    ) {
      setApplying(null);
      showNotice(t("hubUpdateFailed").replace("{error}", String(updateState.error || "error")), "error");
      return undefined;
    }
    const remaining = applying.startedAt + UPDATE_WAIT_MS - Date.now();
    const timer = window.setTimeout(() => {
      setApplying(null);
      showNotice(t("hubUpdateTimeout"), "error");
    }, Math.max(0, remaining));
    return () => window.clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [applying, hubVersion, updateState.phase]);

  function showNotice(text: string, kind: "" | "success" | "error") {
    setNotice(text);
    setNoticeClass(kind);
  }

  async function hubCommand(command: string, payload: Record<string, unknown> = {}, timeoutMs = 20000) {
    if (!hub) return { ok: false, result: null as Record<string, unknown> | null };
    setBusy(command);
    showNotice("", "");
    try {
      const { result } = await sendGatewayCommand(hub.gateway_id, { command, ...payload }, timeoutMs);
      const ok = result !== null && result.ok !== false;
      if (result === null) {
        showNotice(t("hubCommandNoReply"), "error");
      } else if (!ok) {
        showNotice(String(result.message ?? t("hubCommandFailed")), "error");
      }
      return { ok, result };
    } catch (error) {
      showNotice(error instanceof Error ? error.message : String(error), "error");
      return { ok: false, result: null };
    } finally {
      setBusy("");
    }
  }

  async function saveConnection(event: FormEvent) {
    event.preventDefault();
    const { ok } = await hubCommand("set_config", {
      gateway_id: gatewayIdDraft,
      target_mode: targetMode,
      manual_url: manualUrl,
      auth_token: authToken,
    });
    if (ok) showNotice(t("hubSavedRebooting"), "success");
    requestGatewaySnapshot();
  }

  async function checkUpdate() {
    const { ok, result } = await hubCommand("check_update", {}, 30000);
    if (!result) return;
    if (String(result.message ?? "") === "unknown_command") {
      showNotice(t("hubUpdateNeedsFirmware"), "error");
      return;
    }
    setCheckResult(result);
    const update = record(result.update);
    if (!ok) {
      showNotice(t("hubUpdateCheckFailed").replace("{error}", String(update.error || result.message || "error")), "error");
    } else if (update.available === true) {
      showNotice(t("hubUpdateAvailable").replace("{version}", String(update.version ?? "")), "success");
    } else {
      showNotice(t("hubUpToDate"), "success");
    }
  }

  async function applyUpdate() {
    const fromVersion = hubVersion;
    const { ok, result } = await hubCommand("apply_update");
    if (!ok) {
      if (result && String(result.message ?? "") === "unknown_command") showNotice(t("hubUpdateNeedsFirmware"), "error");
      return;
    }
    setApplying({ fromVersion, startedAt: Date.now(), updateKey: JSON.stringify(updateState) });
    showNotice(t("hubUpdateInProgress"), "");
  }

  async function setUpdateChannel(channel: UpdateChannel) {
    const { ok, result } = await hubCommand("set_update_channel", { channel });
    if (!ok) {
      if (result && String(result.message ?? "") === "unknown_command") showNotice(t("hubUpdateChannelNeedsFirmware"), "error");
      return;
    }
    setCheckResult(null);
    showNotice(t("updateChannelSaved").replace("{channel}", t(channel === "beta" ? "updateChannelBeta" : "updateChannelStable")), "success");
    requestGatewaySnapshot();
  }

  async function factoryReset() {
    const { ok } = await hubCommand("factory_reset");
    if (ok) showNotice(t("hubFactoryResetDone"), "success");
    requestGatewaySnapshot();
  }

  async function deleteHub() {
    if (!hub) return;
    setBusy("delete");
    try {
      await api.deleteGateway(hub.gateway_id);
      requestGatewaySnapshot();
      onClose();
    } catch (error) {
      showNotice(`${t("gatewayDeleteFailed")} ${error instanceof Error ? error.message : String(error)}`, "error");
    } finally {
      setBusy("");
    }
  }

  async function scanLan() {
    if (!hub) return;
    setBusy("scan_lan_devices");
    showNotice("", "");
    try {
      const { items } = await api.listHubLanDevices(hub.gateway_id);
      setLanDevices(items);
      setLanScanned(true);
    } catch (error) {
      showNotice(error instanceof Error ? error.message : String(error), "error");
    } finally {
      setBusy("");
    }
  }

  async function migrate(deviceUid: string) {
    if (!hub) return;
    setBusy(`migrate:${deviceUid}`);
    showNotice("", "");
    try {
      await api.migrateDeviceToHub(hub.gateway_id, deviceUid);
      showNotice(`${t("hubMigrateQueued")} ${deviceUid}`, "success");
      setLanDevices((current) => current.filter((item) => item.device_uid !== deviceUid));
    } catch (error) {
      showNotice(error instanceof Error ? error.message : String(error), "error");
    } finally {
      setBusy("");
    }
  }

  if (!hub) {
    return (
      <div className="modal-backdrop" role="presentation" onClick={onClose}>
        <div className="modal-panel hub-manage-modal" role="dialog" aria-modal="true" onClick={(event) => event.stopPropagation()}>
          <div className="modal-header">
            <div>
              <h3>{t("sectionHubs")}</h3>
              <p>{routeGatewayId}</p>
            </div>
            <button className="button" type="button" onClick={onClose}>{t("cancel")}</button>
          </div>
          <p className="empty">{t("hubNotFound")}</p>
        </div>
      </div>
    );
  }

  const online = String(hub.status ?? "offline") === "online";
  const pairedDevices = hub.paired_devices ?? [];
  const servingDevices = hub.serving_devices ?? [];
  const clock = record(hub.clock);
  const hasClock = Object.keys(clock).length > 0;
  // Hub firmware before v0.8.0 reports no update block and has no
  // check/apply commands (it still updates itself at boot).
  const supportsUpdate = Object.keys(updateState).length > 0;
  const checked = record(checkResult?.update);
  // Hub v0.12.0+: behind the newest release on its channel, the Hub keeps
  // serving its devices but refuses settings changes and new pairings, and
  // updates itself once no device is online (like a Gateway's required update).
  const requiredUpdate = updateState.required_update === true;
  const requiredVersion = String(updateState.latest_hub_version || "");
  const latestVersion = String(
    checked.version || (updateState.available === true ? updateState.version : "") || (requiredUpdate ? requiredVersion : "") || "",
  );
  const updateAvailable = checked.available === true || (checkResult === null && (updateState.available === true || requiredUpdate));
  const changelogUrl = String(checked.changelog_url || updateState.changelog_url || "");
  const disabled = busy !== "" || !online || applying !== null;
  // Hub v0.9.0+ reports its update channel in the update block.
  const supportsChannel = typeof updateState.channel === "string";
  const hubChannel = normalizeUpdateChannel(updateState.channel);

  const sections: { id: HubSection; label: string }[] = [
    { id: "overview", label: t("hubSection_overview") },
    { id: "connection", label: t("hubSection_connection") },
    { id: "clock", label: t("hubSection_clock") },
    { id: "update", label: t("hubSection_update") },
    { id: "devices", label: t("hubSection_devices") },
    { id: "maintenance", label: t("hubSection_maintenance") },
  ];

  function renderSection() {
    if (section === "overview") {
      return (
        <div className="settings-stack">
          <div className="settings-detail-header">
            <div>
              <h3>{t("hubSection_overview")}</h3>
            </div>
          </div>
          <div className="settings-card">
            <div className="gateway-facts">
              <div><span>{t("lastSeen")}</span><strong>{formatLastSeen(hub!.last_seen)}</strong></div>
              <div><span>{t("gatewayVersion")}</span><strong>{hub!.version || "-"}</strong></div>
              <div><span>{t("hubMac")}</span><strong className="mono">{hub!.mac || "-"}</strong></div>
              <div><span>IP</span><strong className="mono">{hub!.ip || "-"}</strong></div>
              <div><span>{t("gatewayChannel")}</span><strong>{hub!.channel || "-"}</strong></div>
              <div><span>{t("gatewayTarget")}</span><strong>{hub!.target_mode || "-"}</strong></div>
            </div>
          </div>
          <div className="settings-card">
            <h4>{t("gatewayServingDevices")}</h4>
            {servingDevices.length ? (
              <div className="gateway-chip-list">
                {servingDevices.map((deviceUid) => (
                  <Link key={deviceUid} to={`/device/${deviceUid}/settings`}>{deviceUid}</Link>
                ))}
              </div>
            ) : (
              <p className="empty">{t("gatewayNoServingDevices")}</p>
            )}
          </div>
        </div>
      );
    }

    if (section === "connection") {
      return (
        <div className="settings-stack">
          <div className="settings-detail-header">
            <div>
              <h3>{t("hubSection_connection")}</h3>
              <p>{t("hubConnectionCopy")}</p>
            </div>
          </div>
          <form className="settings-card" onSubmit={(event) => void saveConnection(event)}>
            <div className="field-grid">
              <div className="field">
                <label htmlFor="hub-gateway-id">{t("hubGatewayId")}</label>
                <input id="hub-gateway-id" value={gatewayIdDraft} onChange={(event) => setGatewayIdDraft(event.target.value)} required />
              </div>
              <div className="field">
                <label htmlFor="hub-target-mode">{t("gatewayTarget")}</label>
                <Select id="hub-target-mode" value={targetMode} onChange={(event) => setTargetMode(event.target.value)}>
                  <option value="production">Production</option>
                  <option value="local">Local</option>
                  <option value="manual">Manual</option>
                </Select>
              </div>
              <div className="field">
                <label htmlFor="hub-manual-url">{t("hubManualUrl")}</label>
                <input id="hub-manual-url" value={manualUrl} onChange={(event) => setManualUrl(event.target.value)} />
              </div>
              <div className="field">
                <label htmlFor="hub-auth-token">{t("hubAuthToken")}</label>
                <input id="hub-auth-token" value={authToken} onChange={(event) => setAuthToken(event.target.value)} placeholder="········" />
              </div>
            </div>
            <div className="actions compact">
              <button className="button primary" type="submit" disabled={disabled || requiredUpdate}>
                {busy === "set_config" ? t("running") : t("hubSaveAndReboot")}
              </button>
            </div>
            {requiredUpdate ? <p className="cal-hint">{t("hubLockedUntilUpdate")}</p> : null}
          </form>
        </div>
      );
    }

    if (section === "clock") {
      const synced = clock.synced === true;
      const uncertainty = typeof clock.uncertainty_ms === "number" ? clock.uncertainty_ms : null;
      return (
        <div className="settings-stack">
          <div className="settings-detail-header">
            <div>
              <h3>{t("hubSection_clock")}</h3>
              <p>{t("hubClockCopy")}</p>
            </div>
          </div>
          <div className="settings-card">
            {hasClock ? (
              <>
                <div className="metric-row">
                  <div className="metric"><div className="metric-label">{t("clockSource")}</div><div className="metric-value">{t(`clockSource_${String(clock.source ?? "none")}`)}</div></div>
                  <div className="metric"><div className="metric-label">{t("clockSyncAge")}</div><div className="metric-value">{synced ? ageLabel(clock.age_ms) : "-"}</div></div>
                  <div className="metric"><div className="metric-label">{t("clockUncertainty")}</div><div className="metric-value">{synced && uncertainty !== null ? `±${uncertainty.toLocaleString()} ms` : "-"}</div></div>
                </div>
                <div className="actions compact">
                  <button className="button primary" type="button" disabled={disabled} onClick={() => void hubCommand("clock_sync")}>
                    {busy === "clock_sync" ? t("clockSyncing") : t("clockSyncNow")}
                  </button>
                </div>
              </>
            ) : (
              <p className="service-muted">{t("hubClockUnsupported")}</p>
            )}
          </div>
        </div>
      );
    }

    if (section === "update") {
      return (
        <div className="settings-stack">
          <div className="settings-detail-header">
            <div>
              <h3>{t("hubSection_update")}</h3>
              <p>{t("hubUpdateCopy")}</p>
            </div>
          </div>
          <div className="settings-card">
            <div className="settings-detail-header">
              <div className="metric-row">
                <div className="metric"><div className="metric-label">{t("hubCurrentVersion")}</div><div className="metric-value">{hub!.version || "-"}</div></div>
                <div className="metric"><div className="metric-label">{t("hubLatestVersion")}</div><div className="metric-value">{latestVersion || (checkResult ? hub!.version || "-" : "-")}</div></div>
              </div>
              <div className="actions compact">
                <button className="button" type="button" disabled={disabled || !supportsUpdate} onClick={() => void checkUpdate()}>
                  {busy === "check_update" ? t("running") : t("hubUpdateCheck")}
                </button>
                <button
                  className={`button${updateAvailable ? " primary" : ""}`}
                  type="button"
                  disabled={disabled || !supportsUpdate}
                  onClick={() => setConfirm({ kind: "apply_update" })}
                >
                  {applying ? t("hubUpdating") : t("hubUpdateApply")}
                </button>
              </div>
            </div>
            {supportsChannel ? (
              <>
                <div className="field">
                  <label>{t("updateChannel")}</label>
                  <Select
                    value={hubChannel}
                    disabled={disabled}
                    onChange={(event) => {
                      const next = normalizeUpdateChannel(event.target.value);
                      if (next === "beta") setConfirm({ kind: "beta_channel" });
                      else void setUpdateChannel("stable");
                    }}
                  >
                    <option value="stable">{t("updateChannelStable")}</option>
                    <option value="beta">{t("updateChannelBeta")}</option>
                  </Select>
                </div>
                {waitingForStableToCatchUp(hubChannel, hubVersion) ? (
                  <p className="cal-hint">{t("updateChannelWaitingStable").replace("{version}", hubVersion)}</p>
                ) : null}
                {hubChannel === "beta" ? <p className="cal-hint">{t("updateChannelBetaActive")}</p> : null}
              </>
            ) : supportsUpdate ? (
              <p className="service-muted">{t("hubUpdateChannelNeedsFirmware")}</p>
            ) : null}
            {applying ? <p className="cal-hint">{t("hubUpdateInProgress")}</p> : null}
            {changelogUrl ? <ChangelogPanel url={changelogUrl} /> : null}
            {!supportsUpdate ? <p className="service-muted">{t("hubUpdateNeedsFirmware")}</p> : null}
          </div>
        </div>
      );
    }

    if (section === "devices") {
      return (
        <div className="settings-stack">
          <div className="settings-detail-header">
            <div>
              <h3>{t("hubSection_devices")}</h3>
            </div>
          </div>
          <div className="settings-card">
            <h4>{t("hubPairedDevices")}</h4>
            {pairedDevices.length ? (
              <ul className="gateway-claim-list">
                {pairedDevices.map((device) => (
                  <li key={device.mac}>
                    <span>{device.device_uid || t("hubDeviceUidUnknown")}</span>
                    <small>{device.mac} · {device.status}</small>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="empty">{t("hubNoPairedDevices")}</p>
            )}
          </div>
          <div className="settings-card">
            <div className="settings-detail-header">
              <div>
                <h4>{t("hubLanDevices")}</h4>
                <p>{t("hubLanDevicesCopy")}</p>
              </div>
              <button className="button" type="button" onClick={() => void scanLan()} disabled={busy !== ""}>
                {busy === "scan_lan_devices" ? t("running") : t("hubLanScan")}
              </button>
            </div>
            {lanScanned && !lanDevices.length ? <p className="empty">{t("hubLanNoDevices")}</p> : null}
            {lanDevices.length ? (
              <ul className="gateway-claim-list">
                {lanDevices.map((device) => (
                  <li key={device.device_uid}>
                    <span>{device.device_name || device.device_uid}</span>
                    <button
                      className="button tiny"
                      type="button"
                      disabled={busy !== "" || requiredUpdate}
                      onClick={() => void migrate(device.device_uid)}
                    >
                      {busy === `migrate:${device.device_uid}` ? t("running") : t("hubMigrateToHub")}
                    </button>
                  </li>
                ))}
              </ul>
            ) : null}
          </div>
        </div>
      );
    }

    return (
      <div className="settings-stack">
        <div className="settings-detail-header">
          <div>
            <h3>{t("hubSection_maintenance")}</h3>
          </div>
        </div>
        <div className="settings-card">
          <div className="settings-detail-header">
            <div>
              <h4>{t("hubFactoryReset")}</h4>
              <p>{t("hubFactoryResetCopy")}</p>
            </div>
            <button className="button danger" type="button" disabled={disabled} onClick={() => setConfirm({ kind: "factory_reset" })}>
              {busy === "factory_reset" ? t("running") : t("hubFactoryReset")}
            </button>
          </div>
        </div>
        <div className="settings-card">
          <div className="settings-detail-header">
            <div>
              <h4>{t("deleteHub")}</h4>
              <p>{t("deleteHubCopy")}</p>
            </div>
            <button className="button danger" type="button" disabled={busy !== ""} onClick={() => setConfirm({ kind: "delete" })}>
              {busy === "delete" ? t("running") : t("deleteHub")}
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <>
      <div className="modal-backdrop" role="presentation" onClick={onClose}>
        <div
          className="modal-panel hub-manage-modal"
          role="dialog"
          aria-modal="true"
          aria-label={hub.gateway_name || hub.gateway_id}
          onClick={(event) => event.stopPropagation()}
        >
          <div className="modal-header">
            <div>
              <h3>{hub.gateway_name || hub.gateway_id}</h3>
              <p>{hub.gateway_id}</p>
            </div>
            <button className="button" type="button" onClick={onClose}>{t("cancel")}</button>
          </div>
          {notice ? <p className={`notice ${noticeClass}`.trim()}>{notice}</p> : null}
          {requiredUpdate && !applying ? (
            <p className="notice error">
              {t(updateState.auto_apply === "retry_later" ? "hubUpdateRequiredRetry" : "hubUpdateRequired").replace("{version}", requiredVersion || latestVersion)}
            </p>
          ) : null}
          <section className="settings-overview">
            <div className="settings-overview-card">
              <span>{t("hubStatus")}</span>
              <strong>{online ? t("hubOnline") : t("hubOffline")}</strong>
              <small>{t("lastSeen")}: {formatLastSeen(hub.last_seen)}</small>
            </div>
            <div className="settings-overview-card">
              <span>{t("firmwareVersion")}</span>
              <strong>{hub.version || "-"}</strong>
              <small>{updateAvailable && latestVersion ? t("hubUpdateAvailable").replace("{version}", latestVersion) : " "}</small>
            </div>
            <div className="settings-overview-card">
              <span>{t("hubNetwork")}</span>
              <strong className="mono">{hub.ip || "-"}</strong>
              <small>{t("gatewayChannel")}: {hub.channel || "-"}</small>
            </div>
            <div className="settings-overview-card">
              <span>{t("hubPairedDevices")}</span>
              <strong>{pairedDevices.length}</strong>
              <small>{t("gatewayServingDevices")}: {hub.serving_device_count ?? servingDevices.length}</small>
            </div>
          </section>
          <section className="settings-shell">
            <aside className="settings-sidebar" aria-label={t("sectionHubs")}>
              {sections.map((item) => (
                <button
                  key={item.id}
                  className={section === item.id ? "active" : ""}
                  type="button"
                  onClick={() => setSection(item.id)}
                >
                  <strong>{item.label}</strong>
                </button>
              ))}
            </aside>
            <article className="panel settings-detail">{renderSection()}</article>
          </section>
        </div>
      </div>
      {/* Outside the Hub dialog's backdrop, so clicking this one's backdrop
          does not also close the dialog underneath. */}
      {confirm ? (
        <ConfirmModal
          title={
            confirm.kind === "apply_update"
              ? t("hubUpdateApplyConfirmTitle")
              : confirm.kind === "beta_channel"
                ? t("updateChannelBetaConfirmTitle")
                : confirm.kind === "factory_reset"
                ? t("hubFactoryReset")
                : t("deleteHub")
          }
          message={
            confirm.kind === "apply_update"
              ? t("hubUpdateApplyConfirmMessage")
              : confirm.kind === "beta_channel"
                ? t("updateChannelBetaConfirmMessage")
                : confirm.kind === "factory_reset"
                ? t("hubFactoryResetConfirm")
                : t("deleteHubConfirm")
          }
          confirmLabel={
            confirm.kind === "apply_update"
              ? t("hubUpdateApply")
              : confirm.kind === "beta_channel"
                ? t("updateChannelSwitchToBeta")
                : confirm.kind === "factory_reset"
                  ? t("hubFactoryReset")
                  : t("deleteHub")
          }
          cancelLabel={t("cancel")}
          destructive={confirm.kind === "factory_reset" || confirm.kind === "delete"}
          onConfirm={() => {
            const kind = confirm.kind;
            setConfirm(null);
            if (kind === "apply_update") void applyUpdate();
            else if (kind === "beta_channel") void setUpdateChannel("beta");
            else if (kind === "factory_reset") void factoryReset();
            else void deleteHub();
          }}
          onCancel={() => setConfirm(null)}
        />
      ) : null}
    </>
  );
}
