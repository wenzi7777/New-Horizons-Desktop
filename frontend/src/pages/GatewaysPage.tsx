import { useEffect, useState, type ReactNode } from "react";

import { HubManageModal } from "../components/HubManageModal";
import { useI18n } from "../i18n";
import { api, type GatewayClaimEntry, type GatewayEntry, type HubEnvironmentEntry } from "../lib/api";
import { requestGatewaySnapshot, useWsState } from "../lib/wsClient";

const GATEWAY_REPO_URL = "https://github.com/wenzi7777/New-Horizons-Gateway";
const GATEWAY_ZIP_URL = "https://github.com/wenzi7777/New-Horizons-Gateway/archive/refs/heads/main.zip";
const HUB_REPO_URL = "https://github.com/wenzi7777/New-Horizons-Hub";

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

// One row of label/value pairs; empty values are left out rather than shown as "-".
function RelayFacts({ facts }: { facts: [string, ReactNode, boolean?][] }) {
  return (
    <dl className="relay-facts">
      {facts.filter(([, value]) => value !== "" && value !== null && value !== undefined).map(([label, value, mono]) => (
        <div key={label}>
          <dt>{label}</dt>
          <dd className={mono ? "mono" : undefined}>{value}</dd>
        </div>
      ))}
    </dl>
  );
}

function RelayCardHeader({ relay, children }: { relay: GatewayEntry; children: ReactNode }) {
  const status = gatewayStatus(relay);
  return (
    <div className="relay-card-header">
      <div className="relay-card-title">
        <span className={`relay-status-dot ${status === "online" ? "online" : ""}`} title={status} aria-label={status} />
        <h3>{relay.gateway_name || relay.gateway_id}</h3>
        {relay.gateway_name && relay.gateway_name !== relay.gateway_id ? (
          <span className="relay-card-id">{relay.gateway_id}</span>
        ) : null}
      </div>
      <div className="relay-card-actions">{children}</div>
    </div>
  );
}

function ServingDevices({ devices }: { devices: string[] }) {
  if (!devices.length) return null;
  return (
    <div className="relay-chip-list">
      {devices.map((deviceUid) => <span key={deviceUid}>{deviceUid}</span>)}
    </div>
  );
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
  const servingDevices = gateway.serving_devices ?? [];
  const claims = gateway.claims ?? [];

  return (
    <article className="relay-card">
      <RelayCardHeader relay={gateway}>
        <button className="button danger compact" type="button" onClick={() => onDelete(gateway)} disabled={deleting}>
          {t("deleteGateway")}
        </button>
      </RelayCardHeader>

      <RelayFacts
        facts={[
          [t("lastSeen"), formatLastSeen(gateway.last_seen)],
          [t("gatewayVersion"), gateway.version || ""],
          [t("gatewayChannel"), gateway.channel || ""],
          [t("gatewayTarget"), gateway.target_mode || ""],
          [t("gatewayPorts"), gatewayPorts(gateway)],
          [t("gatewayServingDevices"), gateway.serving_device_count ?? servingDevices.length],
          [t("gatewayDeniedDevices"), gateway.denied_count ?? gateway.denied_devices?.length ?? 0],
          [t("gatewayUdpForwarded"), gateway.udp_forwarded ?? 0],
          [t("gatewayUdpDropped"), gateway.udp_dropped ?? 0],
        ]}
      />

      <p className="relay-upstream">
        <span>{t("gatewayUpstream")}</span>
        {gateway.server_url || gateway.upstream_path || "-"}
      </p>
      {gateway.last_error ? <p className="notice error">{gateway.last_error}</p> : null}

      <ServingDevices devices={servingDevices} />

      {claims.length ? (
        <div className="relay-claims">
          <h4>{t("gatewayClaims")}</h4>
          <ul className="gateway-claim-list">
            {claims.slice(0, 5).map((claim) => (
              <li key={claim.claim_id}>
                <span>{claimLabel(claim)}</span>
                <small>{formatLastSeen(claim.updated_at ?? claim.created_at)}</small>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </article>
  );
}

function HubCard({
  hub,
  deleting,
  onManage,
  onDelete,
}: {
  hub: GatewayEntry;
  deleting: boolean;
  onManage: (hub: GatewayEntry) => void;
  onDelete: (hub: GatewayEntry) => void;
}) {
  const { t } = useI18n();
  const servingDevices = hub.serving_devices ?? [];

  return (
    <article className="relay-card hub-card">
      <RelayCardHeader relay={hub}>
        <button className="button compact" type="button" onClick={() => onManage(hub)}>
          {t("hubManage")}
        </button>
        <button className="button danger compact" type="button" onClick={() => onDelete(hub)} disabled={deleting}>
          {t("deleteGateway")}
        </button>
      </RelayCardHeader>

      <RelayFacts
        facts={[
          [t("lastSeen"), formatLastSeen(hub.last_seen)],
          [t("gatewayVersion"), hub.version || ""],
          [t("gatewayChannel"), hub.channel || ""],
          [t("gatewayServingDevices"), hub.serving_device_count ?? servingDevices.length],
          [t("hubMac"), hub.mac || "", true],
          ["IP", hub.ip || "", true],
        ]}
      />

      <ServingDevices devices={servingDevices} />
    </article>
  );
}

function HubsSection({
  hubs,
  deletingId,
  onManage,
  onDelete,
}: {
  hubs: GatewayEntry[];
  deletingId: string;
  onManage: (hub: GatewayEntry) => void;
  onDelete: (hub: GatewayEntry) => void;
}) {
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
                  <HubCard
                    key={hub.gateway_id}
                    hub={hub}
                    deleting={deletingId === hub.gateway_id}
                    onManage={onManage}
                    onDelete={onDelete}
                  />
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

      <HubsSection
        hubs={hubs}
        deletingId={deletingGatewayId}
        onManage={(hub) => setManageHubId(hub.gateway_id)}
        onDelete={handleDelete}
      />

      <section className="gateway-tools panel">
        <div className="gateway-tools-copy">
          <h3>{t("gatewayToolsTitle")}</h3>
          <p>{t("gatewayToolsCopy")}</p>
        </div>
        <div className="gateway-setup-grid">
          <div className="gateway-setup">
            <div className="gateway-setup-head">
              <h4>Gateway</h4>
              <div className="gateway-tool-actions">
                <a className="button primary compact" href={GATEWAY_ZIP_URL}>
                  {t("gatewayDownload")}
                </a>
                <a className="button compact" href={GATEWAY_REPO_URL} target="_blank" rel="noreferrer">
                  GitHub
                </a>
              </div>
            </div>
            <p>{t("gatewaySetupGatewayCopy")}</p>
            <ol className="gateway-instructions">
              <li>{t("gatewayStepStart")}</li>
              <li>{t("gatewayStepOpen")}</li>
              <li>{t("gatewayStepDevice")}</li>
            </ol>
          </div>
          <div className="gateway-setup">
            <div className="gateway-setup-head">
              <h4>Hub</h4>
              <div className="gateway-tool-actions">
                <a className="button compact" href={HUB_REPO_URL} target="_blank" rel="noreferrer">
                  GitHub
                </a>
              </div>
            </div>
            <p>{t("gatewaySetupHubCopy")}</p>
            <ol className="gateway-instructions">
              <li>{t("hubStepJoin")}</li>
              <li>{t("hubStepOpen")}</li>
              <li>{t("hubStepDevice")}</li>
            </ol>
          </div>
        </div>
      </section>

      {manageHubId ? <HubManageModal gatewayId={manageHubId} onClose={() => setManageHubId("")} /> : null}
    </>
  );
}
