import { useEffect, useState, type FormEvent } from "react";

import { useI18n } from "../i18n";
import { api, type GatewayClaimEntry, type GatewayEntry, type HubEnvironmentEntry, type HubLanDeviceEntry } from "../lib/api";
import { requestGatewaySnapshot, sendGatewayCommand, useWsState } from "../lib/wsClient";

const GATEWAY_REPO_URL = "https://github.com/wenzi7777/New-Horizons-Gateway";
const GATEWAY_ZIP_URL = "https://github.com/wenzi7777/New-Horizons-Gateway/archive/refs/heads/main.zip";

function formatLastSeen(value: unknown) {
  if (!value) return "-";
  const timestamp = Date.parse(String(value));
  if (!Number.isFinite(timestamp)) return String(value);
  const ageMs = Math.max(0, Date.now() - timestamp);
  if (ageMs < 3000) return "now";
  if (ageMs < 60000) return `${Math.round(ageMs / 1000)}s ago`;
  return new Date(timestamp).toLocaleString();
}

function gatewayStatus(gateway: GatewayEntry) {
  return String(gateway.status ?? "offline");
}

function gatewayPorts(gateway: GatewayEntry) {
  const ports = gateway.local_ports ?? {};
  const items = [
    ports.udp ? `UDP ${ports.udp}` : "",
    ports.findme ? `FindMe ${ports.findme}` : "",
  ].filter(Boolean);
  return items.length ? items.join(" / ") : "-";
}

function claimLabel(claim: GatewayClaimEntry) {
  const device = claim.device_uid ? ` ${claim.device_uid}` : "";
  const reason = claim.reason || claim.error ? ` (${claim.reason || claim.error})` : "";
  return `${claim.state ?? "pending"}${device}${reason}`;
}

function GatewayCard({
  gateway,
  deleting,
  onDelete,
}: {
  gateway: GatewayEntry;
  deleting: boolean;
  onDelete: (gateway: GatewayEntry) => void;
}) {
  const { t } = useI18n();
  const status = gatewayStatus(gateway);
  const servingDevices = gateway.serving_devices ?? [];
  const claims = gateway.claims ?? [];

  return (
    <article className="gateway-card">
      <div className="gateway-card-header">
        <div>
          <h3>{gateway.gateway_name || gateway.gateway_id}</h3>
          <div className="gateway-id">{gateway.gateway_id}</div>
        </div>
        <div className="gateway-card-actions">
          <span className={`status-pill ${status === "online" ? "live" : "offline"}`}>{status}</span>
          <button className="button danger" type="button" onClick={() => onDelete(gateway)} disabled={deleting}>
            {t("deleteGateway")}
          </button>
        </div>
      </div>

      <div className="gateway-facts">
        <div>
          <span>{t("lastSeen")}</span>
          <strong>{formatLastSeen(gateway.last_seen)}</strong>
        </div>
        <div>
          <span>{t("gatewayTarget")}</span>
          <strong>{gateway.target_mode || "-"}</strong>
        </div>
        <div>
          <span>{t("gatewayPorts")}</span>
          <strong>{gatewayPorts(gateway)}</strong>
        </div>
        <div>
          <span>{t("gatewayServingDevices")}</span>
          <strong>{gateway.serving_device_count ?? servingDevices.length}</strong>
        </div>
        <div>
          <span>{t("gatewayDeniedDevices")}</span>
          <strong>{gateway.denied_count ?? gateway.denied_devices?.length ?? 0}</strong>
        </div>
        <div>
          <span>{t("gatewayUdpForwarded")}</span>
          <strong>{gateway.udp_forwarded ?? 0}</strong>
        </div>
        <div>
          <span>{t("gatewayUdpDropped")}</span>
          <strong>{gateway.udp_dropped ?? 0}</strong>
        </div>
        <div>
          <span>{t("gatewayVersion")}</span>
          <strong>{gateway.version || "-"}</strong>
        </div>
        <div>
          <span>{t("gatewayChannel")}</span>
          <strong>{gateway.channel || "-"}</strong>
        </div>
      </div>

      <div className="gateway-section">
        <h4>{t("gatewayUpstream")}</h4>
        <p>{gateway.server_url || gateway.upstream_path || "-"}</p>
        {gateway.last_error ? <p className="notice error">{gateway.last_error}</p> : null}
      </div>

      <div className="gateway-section">
        <h4>{t("gatewayServingDevices")}</h4>
        {servingDevices.length ? (
          <div className="gateway-chip-list">
            {servingDevices.map((deviceUid) => <span key={deviceUid}>{deviceUid}</span>)}
          </div>
        ) : (
          <p className="empty">{t("gatewayNoServingDevices")}</p>
        )}
      </div>

      <div className="gateway-section">
        <h4>{t("gatewayClaims")}</h4>
        {claims.length ? (
          <ul className="gateway-claim-list">
            {claims.slice(0, 5).map((claim) => (
              <li key={claim.claim_id}>
                <span>{claimLabel(claim)}</span>
                <small>{formatLastSeen(claim.updated_at ?? claim.created_at)}</small>
              </li>
            ))}
          </ul>
        ) : (
          <p className="empty">{t("gatewayNoClaims")}</p>
        )}
      </div>
    </article>
  );
}

function HubCard({ hub, onManage }: { hub: GatewayEntry; onManage: (hub: GatewayEntry) => void }) {
  const { t } = useI18n();
  const status = gatewayStatus(hub);
  const servingDevices = hub.serving_devices ?? [];

  return (
    <article className="gateway-card hub-card">
      <div className="gateway-card-header">
        <div>
          <h3>{hub.gateway_name || hub.gateway_id}</h3>
          <div className="gateway-id">{hub.gateway_id}</div>
        </div>
        <div className="gateway-card-actions">
          <span className={`status-pill ${status === "online" ? "live" : "offline"}`}>{status}</span>
          <button className="button" type="button" onClick={() => onManage(hub)}>
            {t("hubManage")}
          </button>
        </div>
      </div>

      <div className="gateway-facts">
        <div>
          <span>{t("lastSeen")}</span>
          <strong>{formatLastSeen(hub.last_seen)}</strong>
        </div>
        <div>
          <span>{t("gatewayVersion")}</span>
          <strong>{hub.version || "-"}</strong>
        </div>
        <div>
          <span>{t("gatewayChannel")}</span>
          <strong>{hub.channel || "-"}</strong>
        </div>
        <div>
          <span>{t("hubMac")}</span>
          <strong className="mono">{hub.mac || "-"}</strong>
        </div>
        <div>
          <span>IP</span>
          <strong className="mono">{hub.ip || "-"}</strong>
        </div>
        <div>
          <span>{t("gatewayServingDevices")}</span>
          <strong>{hub.serving_device_count ?? servingDevices.length}</strong>
        </div>
      </div>

      <div className="gateway-section">
        <h4>{t("gatewayServingDevices")}</h4>
        {servingDevices.length ? (
          <div className="gateway-chip-list">
            {servingDevices.map((deviceUid) => <span key={deviceUid}>{deviceUid}</span>)}
          </div>
        ) : (
          <p className="empty">{t("gatewayNoServingDevices")}</p>
        )}
      </div>
    </article>
  );
}

function HubManageModal({ hub, onClose, onSaved }: { hub: GatewayEntry; onClose: () => void; onSaved: () => void }) {
  const { t } = useI18n();
  const [busyCommand, setBusyCommand] = useState("");
  const [notice, setNotice] = useState("");
  const [noticeClass, setNoticeClass] = useState<"" | "success" | "error">("");
  const [gatewayId, setGatewayId] = useState(hub.gateway_id);
  const [targetMode, setTargetMode] = useState(hub.target_mode || "production");
  const [manualUrl, setManualUrl] = useState(hub.server_url || "");
  const [authToken, setAuthToken] = useState("");
  const [lanDevices, setLanDevices] = useState<HubLanDeviceEntry[]>([]);
  const [lanScanned, setLanScanned] = useState(false);
  const pairedDevices = hub.paired_devices ?? [];

  async function runGatewayCommand(command: string, payload: Record<string, unknown>) {
    setBusyCommand(command);
    setNotice("");
    setNoticeClass("");
    try {
      const { result } = await sendGatewayCommand(hub.gateway_id, { command, ...payload });
      const ok = result === null || result.ok !== false;
      setNotice(String(result?.message ?? (ok ? t("hubCommandQueued") : t("hubCommandFailed"))));
      setNoticeClass(ok ? "success" : "error");
      return { ok, result };
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      setNotice(detail);
      setNoticeClass("error");
      return { ok: false, result: null };
    } finally {
      setBusyCommand("");
    }
  }

  async function handleSaveSettings(event: FormEvent) {
    event.preventDefault();
    await runGatewayCommand("set_config", {
      gateway_id: gatewayId,
      target_mode: targetMode,
      manual_url: manualUrl,
      auth_token: authToken,
    });
    onSaved();
  }

  async function handleFactoryReset() {
    if (!window.confirm(t("hubFactoryResetConfirm"))) return;
    await runGatewayCommand("factory_reset", {});
    onSaved();
  }

  async function handleLanScan() {
    setBusyCommand("scan_lan_devices");
    setNotice("");
    setNoticeClass("");
    try {
      const { items } = await api.listHubLanDevices(hub.gateway_id);
      setLanDevices(items);
      setLanScanned(true);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      setNotice(detail);
      setNoticeClass("error");
    } finally {
      setBusyCommand("");
    }
  }

  async function handleMigrate(deviceUid: string) {
    setBusyCommand(`migrate:${deviceUid}`);
    setNotice("");
    setNoticeClass("");
    try {
      await api.migrateDeviceToHub(hub.gateway_id, deviceUid);
      setNotice(`${t("hubMigrateQueued")} ${deviceUid}`);
      setNoticeClass("success");
      setLanDevices((current) => current.filter((item) => item.device_uid !== deviceUid));
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      setNotice(detail);
      setNoticeClass("error");
    } finally {
      setBusyCommand("");
    }
  }

  return (
    <div className="modal-backdrop" role="presentation" onClick={onClose}>
      <div className="modal-panel hub-manage-modal" role="dialog" aria-modal="true" onClick={(event) => event.stopPropagation()}>
        <div className="modal-header">
          <div>
            <h3>{hub.gateway_name || hub.gateway_id}</h3>
            <p>{hub.gateway_id}</p>
          </div>
          <button className="button" type="button" onClick={onClose}>
            {t("cancel")}
          </button>
        </div>

        {notice ? <p className={`notice ${noticeClass}`.trim()}>{notice}</p> : null}

        <div className="gateway-facts">
          <div>
            <span>{t("gatewaysConnected")}</span>
            <strong>{gatewayStatus(hub) === "online" ? t("hubOnline") : t("hubOffline")}</strong>
          </div>
          <div>
            <span>{t("gatewayVersion")}</span>
            <strong>{hub.version || "-"}</strong>
          </div>
          <div>
            <span>{t("hubMac")}</span>
            <strong className="mono">{hub.mac || "-"}</strong>
          </div>
          <div>
            <span>{t("gatewayChannel")}</span>
            <strong>{hub.channel || "-"}</strong>
          </div>
          <div>
            <span>IP</span>
            <strong className="mono">{hub.ip || "-"}</strong>
          </div>
        </div>

        <form className="gateway-section" onSubmit={(event) => void handleSaveSettings(event)}>
          <h4>{t("hubSettingsTitle")}</h4>
          <div className="field-grid">
            <div className="field">
              <label htmlFor="hub-gateway-id">{t("hubGatewayId")}</label>
              <input id="hub-gateway-id" value={gatewayId} onChange={(event) => setGatewayId(event.target.value)} required />
            </div>
            <div className="field">
              <label htmlFor="hub-target-mode">{t("gatewayTarget")}</label>
              <select id="hub-target-mode" value={targetMode} onChange={(event) => setTargetMode(event.target.value)}>
                <option value="production">Production</option>
                <option value="local">Local</option>
                <option value="manual">Manual</option>
              </select>
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
          <button className="button primary" type="submit" disabled={busyCommand === "set_config"}>
            {busyCommand === "set_config" ? t("running") : t("hubSaveAndReboot")}
          </button>
        </form>

        <div className="gateway-section">
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

        <div className="gateway-section">
          <h4>{t("hubLanDevices")}</h4>
          <button className="button" type="button" onClick={() => void handleLanScan()} disabled={busyCommand === "scan_lan_devices"}>
            {busyCommand === "scan_lan_devices" ? t("running") : t("hubLanScan")}
          </button>
          {lanScanned && !lanDevices.length ? <p className="empty">{t("hubLanNoDevices")}</p> : null}
          {lanDevices.length ? (
            <ul className="gateway-claim-list">
              {lanDevices.map((device) => (
                <li key={device.device_uid}>
                  <span>{device.device_name || device.device_uid}</span>
                  <button
                    className="button tiny"
                    type="button"
                    disabled={busyCommand === `migrate:${device.device_uid}`}
                    onClick={() => void handleMigrate(device.device_uid)}
                  >
                    {busyCommand === `migrate:${device.device_uid}` ? t("running") : t("hubMigrateToHub")}
                  </button>
                </li>
              ))}
            </ul>
          ) : null}
        </div>

        <div className="gateway-section">
          <button className="button danger" type="button" onClick={() => void handleFactoryReset()} disabled={busyCommand === "factory_reset"}>
            {busyCommand === "factory_reset" ? t("running") : t("hubFactoryReset")}
          </button>
        </div>
      </div>
    </div>
  );
}

function HubsSection({ hubs, onManage }: { hubs: GatewayEntry[]; onManage: (hub: GatewayEntry) => void }) {
  const { t } = useI18n();
  const [environments, setEnvironments] = useState<HubEnvironmentEntry[]>([]);

  useEffect(() => {
    let cancelled = false;
    api
      .hubEnvironments()
      .then((res) => {
        if (!cancelled) setEnvironments(res.items ?? []);
      })
      .catch(() => {
        if (!cancelled) setEnvironments([]);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const environmentIdByGatewayId = new Map<string, string>();
  for (const env of environments) {
    for (const gatewayId of env.hub_ids ?? []) {
      environmentIdByGatewayId.set(gatewayId, env.environment_id);
    }
  }
  const grouped = new Map<string, GatewayEntry[]>();
  for (const hub of hubs) {
    const key = environmentIdByGatewayId.get(hub.gateway_id) ?? "";
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key)!.push(hub);
  }

  return (
    <section className="gateways-section">
      <h2>{t("sectionHubs")}</h2>
      <p className="page-copy">{t("hubEnvironmentsCopy")}</p>
      {hubs.length ? (
        Array.from(grouped.entries()).map(([environmentId, groupHubs]) => {
          const env = environmentId ? environments.find((entry) => entry.environment_id === environmentId) : null;
          return (
            <div key={environmentId || "ungrouped"} className="hub-environment-group">
              <div className="hub-environment-header">
                <strong>{env?.name || t("hubUngrouped")}</strong>
                {env?.conflict ? (
                  <span className="status-pill offline">
                    {t("hubEnvironmentConflictWarning")} ({(env.conflicting_channels ?? []).join(", ")})
                  </span>
                ) : null}
              </div>
              <div className="gateway-grid">
                {groupHubs.map((hub) => (
                  <HubCard key={hub.gateway_id} hub={hub} onManage={onManage} />
                ))}
              </div>
            </div>
          );
        })
      ) : (
        <section className="panel empty-gateway-state">
          <h3>{t("hubNoHubs")}</h3>
          <p>{t("hubNoHubsCopy")}</p>
        </section>
      )}
    </section>
  );
}

export function GatewaysPage() {
  const { t } = useI18n();
  const { gateways, status, errorMessage } = useWsState();
  const softwareGateways = gateways.filter((gateway) => gateway.client_type !== "hub");
  const hubs = gateways.filter((gateway) => gateway.client_type === "hub");
  const [notice, setNotice] = useState("");
  const [noticeClass, setNoticeClass] = useState<"" | "success" | "error">("");
  const [deletingGatewayId, setDeletingGatewayId] = useState("");
  const [manageHubId, setManageHubId] = useState("");
  const managedHub = manageHubId ? hubs.find((hub) => hub.gateway_id === manageHubId) ?? null : null;

  useEffect(() => {
    requestGatewaySnapshot();
  }, []);

  async function handleDelete(gateway: GatewayEntry) {
    const gatewayId = String(gateway.gateway_id || "").trim();
    if (!gatewayId) return;
    if (!window.confirm(`${t("deleteGatewayConfirm")} ${gatewayId}`)) return;
    setDeletingGatewayId(gatewayId);
    setNotice("");
    setNoticeClass("");
    try {
      await api.deleteGateway(gatewayId);
      setNotice(`${t("gatewayDeleted")} ${gatewayId}`);
      setNoticeClass("success");
      requestGatewaySnapshot();
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      setNotice(`${t("gatewayDeleteFailed")} ${detail}`);
      setNoticeClass("error");
    } finally {
      setDeletingGatewayId("");
    }
  }

  return (
    <>
      <section className="page-header">
        <div>
          <h2>{t("gatewaysTitle")}</h2>
          <p className="page-copy">{t("gatewaysCopy")}</p>
        </div>
        <div className="page-header-actions">
          <span className={`status-pill ${status === "connected" ? "live" : "waiting"}`}>
            {t("wsStatus")}: {status}
          </span>
          <button className="button" type="button" onClick={requestGatewaySnapshot}>
            {t("refreshGateways")}
          </button>
        </div>
      </section>

      {errorMessage ? <p className="notice error">{errorMessage}</p> : null}
      {notice ? <p className={`notice ${noticeClass}`.trim()}>{notice}</p> : null}

      <section className="gateway-tools panel">
        <div className="gateway-tools-copy">
          <h3>{t("gatewayToolsTitle")}</h3>
          <p>{t("gatewayToolsCopy")}</p>
        </div>
        <div className="gateway-tool-actions">
          <a className="button primary" href={GATEWAY_ZIP_URL}>
            {t("gatewayDownload")}
          </a>
          <a className="button" href={GATEWAY_REPO_URL} target="_blank" rel="noreferrer">
            GitHub
          </a>
        </div>
        <ol className="gateway-instructions">
          <li>{t("gatewayStepDownload")}</li>
          <li>{t("gatewayStepStart")}</li>
          <li>{t("gatewayStepOpen")}</li>
          <li>{t("gatewayStepId")}</li>
          <li>{t("gatewayStepEnable")}</li>
          <li>{t("gatewayStepVerify")}</li>
        </ol>
      </section>

      <section className="gateway-summary panel">
        <div>
          <span>{t("gatewaysConnected")}</span>
          <strong>{gateways.filter((gateway) => gatewayStatus(gateway) === "online").length} / {gateways.length}</strong>
        </div>
        <div>
          <span>{t("gatewayServingDevices")}</span>
          <strong>{gateways.reduce((sum, gateway) => sum + Number(gateway.serving_device_count ?? gateway.serving_devices?.length ?? 0), 0)}</strong>
        </div>
        <div>
          <span>{t("gatewayClaims")}</span>
          <strong>{gateways.reduce((sum, gateway) => sum + Number(gateway.claims?.length ?? 0), 0)}</strong>
        </div>
      </section>

      <section className="gateways-section">
        <h2>{t("sectionGateways")}</h2>
        {softwareGateways.length ? (
          <section className="gateway-grid">
            {softwareGateways.map((gateway) => (
              <GatewayCard
                key={gateway.gateway_id}
                gateway={gateway}
                deleting={deletingGatewayId === gateway.gateway_id}
                onDelete={handleDelete}
              />
            ))}
          </section>
        ) : (
          <section className="panel empty-gateway-state">
            <h3>{t("gatewayNoGateways")}</h3>
            <p>{t("gatewayNoGatewaysCopy")}</p>
          </section>
        )}
      </section>

      <HubsSection hubs={hubs} onManage={(hub) => setManageHubId(hub.gateway_id)} />

      {managedHub ? (
        <HubManageModal
          hub={managedHub}
          onClose={() => setManageHubId("")}
          onSaved={requestGatewaySnapshot}
        />
      ) : null}
    </>
  );
}
