import { useEffect, useState, type FormEvent } from "react";
import { Link } from "react-router-dom";

import { ConfirmModal } from "./ConfirmModal";
import { RelayRequiredUpdateBanner, RelayUpdateSection, type RelayUpdateText } from "./RelayUpdateSection";
import { Select } from "./Select";
import { useI18n } from "../i18n";
import { api, type GatewayEntry, type GatewayNearbyDeviceEntry } from "../lib/api";
import { useRelayCommands, type RelayCommandText } from "../lib/relayCommand";
import { relayRecord, relayUpdateInfo } from "../lib/relayUpdateInfo";
import type { UpdateChannel } from "../lib/versioning";
import { requestGatewaySnapshot, useWsState } from "../lib/wsClient";

// A Gateway's management dialog, the counterpart of HubManageModal. It talks
// to the Gateway process itself through gateway_command (backend
// GATEWAY_COMMANDS), which a Gateway takes from v1.0.0 on ("gateway_command"
// in its hello capabilities). An older one only gets the overview and a
// pointer to its own WebUI.

type GatewaySection = "overview" | "connection" | "update" | "devices" | "maintenance";

type Confirm =
  | { kind: "apply_update" }
  | { kind: "beta_channel" }
  | { kind: "restart" }
  | { kind: "factory_reset" }
  | { kind: "delete" };

const GATEWAY_COMMAND_TEXT: RelayCommandText = {
  noReply: "gatewayCommandNoReply",
  failed: "hubCommandFailed",
  updateDone: "gatewayUpdateDone",
  updateFailed: "hubUpdateFailed",
  updateTimeout: "gatewayUpdateTimeout",
};

const GATEWAY_UPDATE_TEXT: RelayUpdateText = {
  title: "gatewaySection_update",
  copy: "gatewayUpdateCopy",
  currentVersion: "hubCurrentVersion",
  latestVersion: "hubLatestVersion",
  check: "hubUpdateCheck",
  apply: "hubUpdateApply",
  updating: "hubUpdating",
  inProgress: "gatewayUpdateInProgress",
  needsUpdate: "gatewayNeedsV1",
  channelNeedsUpdate: "gatewayNeedsV1",
};

function formatLastSeen(value: unknown) {
  if (!value) return "-";
  const timestamp = Date.parse(String(value));
  if (!Number.isFinite(timestamp)) return String(value);
  const ageMs = Math.max(0, Date.now() - timestamp);
  if (ageMs < 3000) return "now";
  if (ageMs < 60000) return `${Math.round(ageMs / 1000)}s ago`;
  return new Date(timestamp).toLocaleString();
}

function gatewayPorts(gateway: GatewayEntry) {
  const ports = gateway.local_ports ?? {};
  const items = [ports.udp ? `UDP ${ports.udp}` : "", ports.findme ? `FindMe ${ports.findme}` : ""].filter(Boolean);
  return items.length ? items.join(" / ") : "-";
}

export function gatewaySupportsCommands(gateway: GatewayEntry | null | undefined) {
  return Boolean(gateway?.capabilities?.includes("gateway_command"));
}

export function GatewayManageModal({ gatewayId: routeGatewayId, onClose }: { gatewayId: string; onClose: () => void }) {
  const { t } = useI18n();
  const { gateways } = useWsState();
  const gateway: GatewayEntry | null = gateways.find((item) => item.gateway_id === routeGatewayId) ?? null;

  const [section, setSection] = useState<GatewaySection>("overview");
  const { busy, setBusy, notice, noticeClass, showNotice, command, applying, applyUpdate: sendApplyUpdate } =
    useRelayCommands(gateway, GATEWAY_COMMAND_TEXT);
  const [confirm, setConfirm] = useState<Confirm | null>(null);

  // Connection form; seeded from the Gateway's own report, then left alone.
  const [gatewayIdDraft, setGatewayIdDraft] = useState("");
  const [targetMode, setTargetMode] = useState("production");
  const [manualUrl, setManualUrl] = useState("");
  const [formSeeded, setFormSeeded] = useState(false);

  // The last check_update answer.
  const [checkResult, setCheckResult] = useState<Record<string, unknown> | null>(null);

  useEffect(() => {
    requestGatewaySnapshot();
  }, []);

  useEffect(() => {
    if (!gateway || formSeeded) return;
    setGatewayIdDraft(gateway.gateway_id);
    setTargetMode(gateway.target_mode || "production");
    setManualUrl(gateway.target_mode === "manual" ? gateway.server_url || "" : "");
    setFormSeeded(true);
  }, [gateway, formSeeded]);

  const gatewayVersion = gateway?.version ?? "";

  async function saveConnection(event: FormEvent) {
    event.preventDefault();
    if (!gateway) return;
    const renamed = gatewayIdDraft.trim() !== gateway.gateway_id;
    const { ok } = await command("set_config", {
      gateway_id: gatewayIdDraft.trim(),
      target_mode: targetMode,
      manual_url: manualUrl.trim(),
    });
    requestGatewaySnapshot();
    if (!ok) return;
    // Under a new ID it registers as a new entry; this one goes stale.
    if (renamed) onClose();
    else showNotice(t("gatewaySavedReconnecting"), "success");
  }

  async function checkUpdate() {
    const { ok, result } = await command("check_update", {}, 30000);
    if (!result) return;
    setCheckResult(result);
    const update = relayRecord(result.update);
    if (!ok) {
      showNotice(t("hubUpdateCheckFailed").replace("{error}", String(update.error || result.message || "error")), "error");
    } else if (update.available === true) {
      showNotice(t("hubUpdateAvailable").replace("{version}", String(update.version ?? "")), "success");
    } else {
      showNotice(t("gatewayUpToDate"), "success");
    }
  }

  async function applyUpdate() {
    const { ok } = await sendApplyUpdate();
    if (ok) showNotice(t("gatewayUpdateInProgress"), "");
  }

  async function setUpdateChannel(channel: UpdateChannel) {
    const { ok } = await command("set_update_channel", { channel });
    if (!ok) return;
    setCheckResult(null);
    showNotice(t("updateChannelSaved").replace("{channel}", t(channel === "beta" ? "updateChannelBeta" : "updateChannelStable")), "success");
    requestGatewaySnapshot();
  }

  async function restart() {
    const { ok } = await command("restart");
    if (ok) showNotice(t("gatewayRestartDone"), "success");
    requestGatewaySnapshot();
  }

  async function factoryReset() {
    const { ok } = await command("factory_reset");
    if (ok) showNotice(t("gatewayFactoryResetDone"), "success");
    requestGatewaySnapshot();
  }

  async function discover() {
    const { ok } = await command("discover", {}, 30000);
    if (ok) showNotice(t("gatewayDiscoverSent"), "success");
    requestGatewaySnapshot();
  }

  async function deviceAction(name: "device_serve" | "device_reject" | "device_allow", deviceUid: string) {
    const { ok } = await command(name, { device_uid: deviceUid });
    if (ok) showNotice(t("gatewayDeviceActionDone").replace("{device}", deviceUid), "success");
    requestGatewaySnapshot();
  }

  async function deleteGateway() {
    if (!gateway) return;
    setBusy("delete");
    try {
      await api.deleteGateway(gateway.gateway_id);
      requestGatewaySnapshot();
      onClose();
    } catch (error) {
      showNotice(`${t("gatewayDeleteFailed")} ${error instanceof Error ? error.message : String(error)}`, "error");
    } finally {
      setBusy("");
    }
  }

  if (!gateway) {
    return (
      <div className="modal-backdrop" role="presentation" onClick={onClose}>
        <div className="modal-panel hub-manage-modal" role="dialog" aria-modal="true" onClick={(event) => event.stopPropagation()}>
          <div className="modal-header">
            <div>
              <h3>{t("sectionGateways")}</h3>
              <p>{routeGatewayId}</p>
            </div>
            <button className="button" type="button" onClick={onClose}>{t("cancel")}</button>
          </div>
          <p className="empty">{t("gatewayNotFound")}</p>
        </div>
      </div>
    );
  }

  const online = String(gateway.status ?? "offline") === "online";
  const manageable = gatewaySupportsCommands(gateway);
  const servingDevices = gateway.serving_devices ?? [];
  const deniedDevices = gateway.denied_devices ?? [];
  const nearbyDevices = gateway.nearby_devices ?? [];
  const nearbyByUid = new Map(nearbyDevices.map((item) => [item.device_uid, item]));
  const servingSet = new Set(servingDevices);
  const deniedSet = new Set(deniedDevices);
  const idleNearby = nearbyDevices.filter((item) => !servingSet.has(item.device_uid) && !deniedSet.has(item.device_uid) && !item.denied);
  const updateInfo = relayUpdateInfo(gateway.update, checkResult);
  const { requiredUpdate, latestVersion, updateAvailable } = updateInfo;
  const disabled = busy !== "" || !online || applying !== null || !manageable;

  const sections: { id: GatewaySection; label: string }[] = manageable
    ? [
        { id: "overview", label: t("hubSection_overview") },
        { id: "connection", label: t("hubSection_connection") },
        { id: "update", label: t("gatewaySection_update") },
        { id: "devices", label: t("gatewaySection_devices") },
        { id: "maintenance", label: t("hubSection_maintenance") },
      ]
    : [{ id: "overview", label: t("hubSection_overview") }];
  const activeSection: GatewaySection = manageable ? section : "overview";

  function deviceLabel(deviceUid: string, entry?: GatewayNearbyDeviceEntry) {
    const name = entry?.device_name || "";
    return name && name !== deviceUid ? `${name} (${deviceUid})` : deviceUid;
  }

  function deviceDetail(entry?: GatewayNearbyDeviceEntry) {
    if (!entry) return "";
    const parts = [
      entry.addr || "",
      typeof entry.wifi_rssi === "number" ? `${entry.wifi_rssi} dBm` : "",
      entry.last_findme_at ? formatLastSeen(entry.last_findme_at) : "",
    ].filter(Boolean);
    return parts.join(" · ");
  }

  function renderSection() {
    if (activeSection === "overview") {
      return (
        <div className="settings-stack">
          <div className="settings-detail-header">
            <div>
              <h3>{t("hubSection_overview")}</h3>
            </div>
          </div>
          {!manageable ? <p className="notice">{t("gatewayNeedsV1")}</p> : null}
          <div className="settings-card">
            <div className="gateway-facts">
              <div><span>{t("lastSeen")}</span><strong>{formatLastSeen(gateway!.last_seen)}</strong></div>
              <div><span>{t("gatewayVersion")}</span><strong>{gateway!.version || "-"}</strong></div>
              <div><span>{t("gatewayTarget")}</span><strong>{gateway!.target_mode || "-"}</strong></div>
              <div><span>{t("gatewayUpstream")}</span><strong className="mono">{gateway!.server_url || gateway!.upstream_path || "-"}</strong></div>
              <div><span>{t("gatewayPorts")}</span><strong>{gatewayPorts(gateway!)}</strong></div>
              <div><span>{t("gatewayUdpForwarded")}</span><strong>{gateway!.udp_forwarded ?? 0}</strong></div>
              <div><span>{t("gatewayUdpDropped")}</span><strong>{gateway!.udp_dropped ?? 0}</strong></div>
            </div>
            {gateway!.last_error ? <p className="notice error">{gateway!.last_error}</p> : null}
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

    if (activeSection === "connection") {
      return (
        <div className="settings-stack">
          <div className="settings-detail-header">
            <div>
              <h3>{t("hubSection_connection")}</h3>
              <p>{t("gatewayConnectionCopy")}</p>
            </div>
          </div>
          <form className="settings-card" onSubmit={(event) => void saveConnection(event)}>
            <div className="field-grid">
              <div className="field">
                <label htmlFor="gw-gateway-id">{t("hubGatewayId")}</label>
                <input id="gw-gateway-id" value={gatewayIdDraft} onChange={(event) => setGatewayIdDraft(event.target.value)} required />
              </div>
              <div className="field">
                <label htmlFor="gw-target-mode">{t("gatewayTarget")}</label>
                <Select id="gw-target-mode" value={targetMode} onChange={(event) => setTargetMode(event.target.value)}>
                  <option value="production">Production</option>
                  <option value="local">Local</option>
                  <option value="manual">Manual</option>
                </Select>
              </div>
              {targetMode === "manual" ? (
                <div className="field">
                  <label htmlFor="gw-manual-url">{t("hubManualUrl")}</label>
                  <input
                    id="gw-manual-url"
                    value={manualUrl}
                    onChange={(event) => setManualUrl(event.target.value)}
                    placeholder="ws://192.168.1.10:5051/newhorizons/gateway/ws"
                    required
                  />
                </div>
              ) : null}
            </div>
            <p className="cal-hint">{t("gatewayConnectionWarning")}</p>
            <div className="actions compact">
              <button className="button primary" type="submit" disabled={disabled || requiredUpdate}>
                {busy === "set_config" ? t("running") : t("gatewaySaveConnection")}
              </button>
            </div>
            {requiredUpdate ? <p className="cal-hint">{t("gatewayLockedUntilUpdate")}</p> : null}
          </form>
        </div>
      );
    }

    if (activeSection === "update") {
      return (
        <RelayUpdateSection
          version={gatewayVersion}
          info={updateInfo}
          checked={checkResult !== null}
          applying={applying !== null}
          busy={busy}
          disabled={disabled}
          text={GATEWAY_UPDATE_TEXT}
          onCheck={() => void checkUpdate()}
          onRequestApply={() => setConfirm({ kind: "apply_update" })}
          onChannelStable={() => void setUpdateChannel("stable")}
          onRequestBeta={() => setConfirm({ kind: "beta_channel" })}
        />
      );
    }

    if (activeSection === "devices") {
      return (
        <div className="settings-stack">
          <div className="settings-detail-header">
            <div>
              <h3>{t("gatewaySection_devices")}</h3>
              <p>{t("gatewayDevicesCopy")}</p>
            </div>
            <button className="button" type="button" disabled={disabled} onClick={() => void discover()}>
              {busy === "discover" ? t("running") : t("gatewayDiscover")}
            </button>
          </div>
          <div className="settings-card">
            <h4>{t("gatewayServingDevices")}</h4>
            {servingDevices.length ? (
              <ul className="gateway-claim-list">
                {servingDevices.map((deviceUid) => {
                  const entry = nearbyByUid.get(deviceUid);
                  return (
                    <li key={deviceUid}>
                      <span>
                        <Link to={`/device/${deviceUid}/settings`}>{deviceLabel(deviceUid, entry)}</Link>
                        {deviceDetail(entry) ? <small> {deviceDetail(entry)}</small> : null}
                      </span>
                      <button className="button tiny danger" type="button" disabled={disabled} onClick={() => void deviceAction("device_reject", deviceUid)}>
                        {busy === "device_reject" ? t("running") : t("gatewayDeny")}
                      </button>
                    </li>
                  );
                })}
              </ul>
            ) : (
              <p className="empty">{t("gatewayNoServingDevices")}</p>
            )}
          </div>
          <div className="settings-card">
            <h4>{t("gatewayNearbyDevices")}</h4>
            <p className="service-muted">{t("gatewayNearbyCopy")}</p>
            {idleNearby.length ? (
              <ul className="gateway-claim-list">
                {idleNearby.map((entry) => (
                  <li key={entry.device_uid}>
                    <span>
                      {deviceLabel(entry.device_uid, entry)}
                      {deviceDetail(entry) ? <small> {deviceDetail(entry)}</small> : null}
                    </span>
                    <span className="actions compact">
                      <button
                        className="button tiny primary"
                        type="button"
                        disabled={disabled || requiredUpdate}
                        onClick={() => void deviceAction("device_serve", entry.device_uid)}
                      >
                        {busy === "device_serve" ? t("running") : t("gatewayServe")}
                      </button>
                      <button className="button tiny" type="button" disabled={disabled} onClick={() => void deviceAction("device_reject", entry.device_uid)}>
                        {t("gatewayDeny")}
                      </button>
                    </span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="empty">{t("gatewayNoNearby")}</p>
            )}
          </div>
          <div className="settings-card">
            <h4>{t("gatewayDeniedDevices")}</h4>
            {deniedDevices.length ? (
              <ul className="gateway-claim-list">
                {deniedDevices.map((deviceUid) => (
                  <li key={deviceUid}>
                    <span>{deviceLabel(deviceUid, nearbyByUid.get(deviceUid))}</span>
                    <button
                      className="button tiny"
                      type="button"
                      disabled={disabled || requiredUpdate}
                      onClick={() => void deviceAction("device_allow", deviceUid)}
                    >
                      {busy === "device_allow" ? t("running") : t("gatewayAllow")}
                    </button>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="empty">{t("gatewayNoDenied")}</p>
            )}
          </div>
          {requiredUpdate ? <p className="cal-hint">{t("gatewayLockedUntilUpdate")}</p> : null}
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
              <h4>{t("gatewayRestart")}</h4>
              <p>{t("gatewayRestartCopy")}</p>
            </div>
            <button className="button" type="button" disabled={disabled} onClick={() => setConfirm({ kind: "restart" })}>
              {busy === "restart" ? t("running") : t("gatewayRestart")}
            </button>
          </div>
        </div>
        <div className="settings-card">
          <div className="settings-detail-header">
            <div>
              <h4>{t("hubFactoryReset")}</h4>
              <p>{t("gatewayFactoryResetCopy")}</p>
            </div>
            <button className="button danger" type="button" disabled={disabled} onClick={() => setConfirm({ kind: "factory_reset" })}>
              {busy === "factory_reset" ? t("running") : t("hubFactoryReset")}
            </button>
          </div>
        </div>
        <div className="settings-card">
          <div className="settings-detail-header">
            <div>
              <h4>{t("deleteGatewayTitle")}</h4>
              <p>{t("deleteGatewayCopy")}</p>
            </div>
            <button className="button danger" type="button" disabled={busy !== ""} onClick={() => setConfirm({ kind: "delete" })}>
              {busy === "delete" ? t("running") : t("deleteGateway")}
            </button>
          </div>
        </div>
      </div>
    );
  }

  const confirmText: Record<Confirm["kind"], { title: string; message: string; label: string; destructive: boolean }> = {
    apply_update: {
      title: t("gatewayUpdateApplyConfirmTitle"),
      message: t("gatewayUpdateApplyConfirmMessage"),
      label: t("hubUpdateApply"),
      destructive: false,
    },
    beta_channel: {
      title: t("updateChannelBetaConfirmTitle"),
      message: t("gatewayBetaConfirmMessage"),
      label: t("updateChannelSwitchToBeta"),
      destructive: false,
    },
    restart: {
      title: t("gatewayRestart"),
      message: t("gatewayRestartConfirm"),
      label: t("gatewayRestart"),
      destructive: false,
    },
    factory_reset: {
      title: t("hubFactoryReset"),
      message: t("gatewayFactoryResetConfirm"),
      label: t("hubFactoryReset"),
      destructive: true,
    },
    delete: {
      title: t("deleteGatewayTitle"),
      message: t("deleteGatewayConfirm"),
      label: t("deleteGateway"),
      destructive: true,
    },
  };

  return (
    <>
      <div className="modal-backdrop" role="presentation" onClick={onClose}>
        <div
          className="modal-panel hub-manage-modal"
          role="dialog"
          aria-modal="true"
          aria-label={gateway.gateway_name || gateway.gateway_id}
          onClick={(event) => event.stopPropagation()}
        >
          <div className="modal-header">
            <div>
              <h3>{gateway.gateway_name || gateway.gateway_id}</h3>
              <p>{gateway.gateway_id}</p>
            </div>
            <button className="button" type="button" onClick={onClose}>{t("cancel")}</button>
          </div>
          {notice ? <p className={`notice ${noticeClass}`.trim()}>{notice}</p> : null}
          <RelayRequiredUpdateBanner
            info={updateInfo}
            applying={applying !== null}
            textKey="gatewayUpdateRequired"
            retryTextKey="gatewayUpdateRequiredRetry"
          />
          <section className="settings-overview">
            <div className="settings-overview-card">
              <span>{t("hubStatus")}</span>
              <strong>{online ? t("hubOnline") : t("hubOffline")}</strong>
              <small>{t("lastSeen")}: {formatLastSeen(gateway.last_seen)}</small>
            </div>
            <div className="settings-overview-card">
              <span>{t("gatewayVersion")}</span>
              <strong>{gateway.version || "-"}</strong>
              <small>{updateAvailable && latestVersion ? t("hubUpdateAvailable").replace("{version}", latestVersion) : " "}</small>
            </div>
            <div className="settings-overview-card">
              <span>{t("gatewayTarget")}</span>
              <strong>{gateway.target_mode || "-"}</strong>
              <small>{gatewayPorts(gateway)}</small>
            </div>
            <div className="settings-overview-card">
              <span>{t("gatewayServingDevices")}</span>
              <strong>{gateway.serving_device_count ?? servingDevices.length}</strong>
              <small>{t("gatewayNearbyDevices")}: {nearbyDevices.length}</small>
            </div>
          </section>
          <section className="settings-shell">
            <aside className="settings-sidebar" aria-label={t("sectionGateways")}>
              {sections.map((item) => (
                <button
                  key={item.id}
                  className={activeSection === item.id ? "active" : ""}
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
      {/* Outside the dialog's backdrop, so clicking this one's backdrop does
          not also close the dialog underneath. */}
      {confirm ? (
        <ConfirmModal
          title={confirmText[confirm.kind].title}
          message={confirmText[confirm.kind].message}
          confirmLabel={confirmText[confirm.kind].label}
          cancelLabel={t("cancel")}
          destructive={confirmText[confirm.kind].destructive}
          onConfirm={() => {
            const kind = confirm.kind;
            setConfirm(null);
            if (kind === "apply_update") void applyUpdate();
            else if (kind === "beta_channel") void setUpdateChannel("beta");
            else if (kind === "restart") void restart();
            else if (kind === "factory_reset") void factoryReset();
            else void deleteGateway();
          }}
          onCancel={() => setConfirm(null)}
        />
      ) : null}
    </>
  );
}
