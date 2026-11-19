import { useEffect, useState, type ReactNode } from "react";

import { ConfirmModal } from "../components/ConfirmModal";
import { GatewayManageModal } from "../components/GatewayManageModal";
import { HubManageModal } from "../components/HubManageModal";
import { useI18n } from "../i18n";
import { api, type GatewayClaimEntry, type GatewayEntry } from "../lib/api";
import { NH_STUDIO_DOWNLOAD_URL, isAppRelay, relayDisplayName, relayKind, splitRelays } from "../lib/relayKind";
import { requestGatewaySnapshot, useWsState } from "../lib/wsClient";

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

// A counter that is 0 (or missing) is left out of the card.
function nonZero(value: unknown) {
  const count = Number(value ?? 0);
  return Number.isFinite(count) && count !== 0 ? count : "";
}

function isOnline(relay: GatewayEntry) {
  return gatewayStatus(relay) === "online";
}

// Signed-in apps first, then by id.
function byOwnership(a: GatewayEntry, b: GatewayEntry) {
  return Number(Boolean(b.authenticated)) - Number(Boolean(a.authenticated)) || String(a.gateway_id).localeCompare(String(b.gateway_id));
}

const INACTIVE_OPEN_KEY = "newhorizons-relays-inactive-open";

function readInactiveOpen() {
  try {
    return window.localStorage.getItem(INACTIVE_OPEN_KEY) === "1";
  } catch {
    return false;
  }
}

function writeInactiveOpen(open: boolean) {
  try {
    window.localStorage.setItem(INACTIVE_OPEN_KEY, open ? "1" : "0");
  } catch {
    // Not remembered; fine.
  }
}

function SectionTitle({ title, relays }: { title: string; relays: GatewayEntry[] }) {
  const { t } = useI18n();
  const online = relays.filter(isOnline).length;
  return (
    <h2 className="relay-section-title">
      {title}
      {relays.length ? <span className={`relay-badge ${online ? "" : "muted"}`.trim()}>{t("relayOnlineCount").replace("{count}", String(online))}</span> : null}
    </h2>
  );
}

// Offline relays of every kind, one compact row each.
function InactiveRelays({
  relays,
  deletingId,
  onDelete,
  onPrune,
}: {
  relays: GatewayEntry[];
  deletingId: string;
  onDelete: (relay: GatewayEntry) => void;
  onPrune: () => void;
}) {
  const { t } = useI18n();
  const [open, setOpen] = useState(readInactiveOpen);
  if (!relays.length) return null;
  const toggle = () => {
    setOpen(!open);
    writeInactiveOpen(!open);
  };
  return (
    <section className="gateways-section relay-inactive">
      <div className="relay-inactive-head">
        <button className="button" type="button" aria-expanded={open} onClick={toggle}>
          {open ? t("relayInactiveHide") : t("relayInactiveToggle").replace("{count}", String(relays.length))}
        </button>
        {open ? (
          <button className="button danger compact" type="button" onClick={onPrune}>
            {t("pruneOfflineRelays")} ({relays.length})
          </button>
        ) : null}
      </div>
      {open ? (
        <div className="panel relay-inactive-panel">
          <p className="page-copy">{t("relayInactiveHint")}</p>
          <div className="relay-inactive-scroll">
            <table className="data-table relay-inactive-table">
              <thead>
                <tr>
                  <th>{t("relayColName")}</th>
                  <th>ID</th>
                  <th>{t("gatewayVersion")}</th>
                  <th>{t("relayColAccount")}</th>
                  <th>{t("lastSeen")}</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {relays.map((relay) => {
                  const app = relayKind(relay) === "studio" || relayKind(relay) === "pocket";
                  return (
                    <tr key={relay.gateway_id}>
                      <td>{relayDisplayName(relay)}</td>
                      <td className="mono">{relay.gateway_id}</td>
                      <td>{relay.version || "-"}</td>
                      <td>{app ? (relay.authenticated ? relay.account || t("relayAuthenticated") : t("relayNotAuthenticated")) : "-"}</td>
                      <td>{formatLastSeen(relay.last_seen)}</td>
                      <td>
                        <button className="button danger compact" type="button" onClick={() => onDelete(relay)} disabled={deletingId === relay.gateway_id}>
                          {t("deleteGateway")}
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      ) : null}
    </section>
  );
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
  const { t } = useI18n();
  const status = gatewayStatus(relay);
  return (
    <div className="relay-card-header">
      <div className="relay-card-title">
        <span className={`relay-status-dot ${status === "online" ? "online" : ""}`} title={status} aria-label={status} />
        <h3>{relayDisplayName(relay)}</h3>
        {relay.gateway_id ? <span className="relay-card-id">{relay.gateway_id}</span> : null}
        {relayKind(relay) === "studio" || relayKind(relay) === "pocket" ? (
          <span className={`relay-badge ${relay.authenticated ? "" : "muted"}`.trim()} title={relay.account || undefined}>
            {relay.authenticated
              ? relay.account
                ? t("relaySignedInAs").replace("{account}", relay.account)
                : t("relayAuthenticated")
              : t("relayNotAuthenticated")}
          </span>
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
  onManage,
  onDelete,
}: {
  gateway: GatewayEntry;
  deleting: boolean;
  onManage: (gateway: GatewayEntry) => void;
  onDelete: (gateway: GatewayEntry) => void;
}) {
  const { t } = useI18n();
  const servingDevices = gateway.serving_devices ?? [];
  const claims = gateway.claims ?? [];
  const legacy = !isAppRelay(gateway);

  return (
    <article className={`relay-card ${legacy ? "legacy-card" : "app-relay-card"}`}>
      <RelayCardHeader relay={gateway}>
        <button className="button compact" type="button" onClick={() => onManage(gateway)}>
          {t("hubManage")}
        </button>
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
          [t("gatewayDeniedDevices"), nonZero(gateway.denied_count ?? gateway.denied_devices?.length)],
          [t("gatewayUdpForwarded"), nonZero(gateway.udp_forwarded)],
          [t("gatewayUdpDropped"), nonZero(gateway.udp_dropped)],
        ]}
      />

      {legacy ? (
        <p className="relay-legacy-hint">
          {t("legacyGatewayHint")}{" "}
          <a href={NH_STUDIO_DOWNLOAD_URL} target="_blank" rel="noreferrer">
            {t("legacyGatewaySwitch")}
          </a>
        </p>
      ) : null}

      {/* Every relay listed here reaches this server, so the upstream only
          says something when it was set by hand (local / manual). */}
      {legacy || gateway.target_mode !== "production" ? (
        <p className="relay-upstream">
          <span>{t("gatewayUpstream")}</span>
          {gateway.server_url || gateway.upstream_path || "-"}
        </p>
      ) : null}
      {gateway.last_error ? <p className="notice error">{gateway.last_error}</p> : null}
      {gateway.update?.required_update === true ? (
        <p className="cal-hint">{t("gatewayUpdateRequiredShort").replace("{version}", String(gateway.update.latest_version || ""))}</p>
      ) : null}

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

      {hub.update?.required_update === true ? (
        <p className="cal-hint">{t("hubUpdateRequiredShort").replace("{version}", String(hub.update.latest_hub_version || ""))}</p>
      ) : null}
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
  const online = hubs.filter(isOnline);
  return (
    <section className="gateways-section">
      <SectionTitle title={t("sectionHubs")} relays={hubs} />
      {online.length ? (
        <div className="gateway-grid">
          {online.map((hub) => (
            <HubCard
              key={hub.gateway_id}
              hub={hub}
              deleting={deletingId === hub.gateway_id}
              onManage={onManage}
              onDelete={onDelete}
            />
          ))}
        </div>
      ) : hubs.length ? (
        <p className="relay-none-online">{t("relayNoneOnline")}</p>
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
  // Studio / Pocket first; the Python Gateway only shows (as legacy) while
  // one is still connected or registered.
  const { apps: appRelays, hubs, legacyGateways } = splitRelays(gateways);
  const [notice, setNotice] = useState("");
  const [noticeClass, setNoticeClass] = useState<"" | "success" | "error">("");
  const [deletingGatewayId, setDeletingGatewayId] = useState("");
  const [manageHubId, setManageHubId] = useState("");
  const [manageGatewayId, setManageGatewayId] = useState("");
  // The relay waiting on the delete confirmation.
  const [confirmDelete, setConfirmDelete] = useState<GatewayEntry | null>(null);
  const [confirmPrune, setConfirmPrune] = useState(false);
  const onlineApps = appRelays.filter(isOnline).sort(byOwnership);
  const onlineLegacy = legacyGateways.filter(isOnline);
  const inactive = [...appRelays, ...hubs, ...legacyGateways]
    .filter((relay) => !isOnline(relay))
    .sort((a, b) => (Date.parse(String(b.last_seen ?? "")) || 0) - (Date.parse(String(a.last_seen ?? "")) || 0));

  useEffect(() => {
    requestGatewaySnapshot();
  }, []);

  function handleDelete(gateway: GatewayEntry) {
    if (String(gateway.gateway_id || "").trim()) setConfirmDelete(gateway);
  }

  async function deleteRelay(gateway: GatewayEntry) {
    const gatewayId = String(gateway.gateway_id || "").trim();
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

  async function pruneOffline() {
    setNotice("");
    setNoticeClass("");
    try {
      const result = await api.pruneOfflineGateways();
      setNotice(`${t("pruneOfflineDone")} ${result.removed.length}`);
      setNoticeClass("success");
      requestGatewaySnapshot();
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      setNotice(`${t("gatewayDeleteFailed")} ${detail}`);
      setNoticeClass("error");
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
        <SectionTitle title={t("sectionAppRelays")} relays={appRelays} />
        {onlineApps.length ? (
          <section className="gateway-grid">
            {onlineApps.map((gateway) => (
              <GatewayCard
                key={gateway.gateway_id}
                gateway={gateway}
                deleting={deletingGatewayId === gateway.gateway_id}
                onManage={(item) => setManageGatewayId(item.gateway_id)}
                onDelete={handleDelete}
              />
            ))}
          </section>
        ) : appRelays.length ? (
          <p className="relay-none-online">{t("relayNoneOnline")}</p>
        ) : (
          <section className="panel empty-gateway-state">
            <h3>{t("appRelayNone")}</h3>
            <p>{t("appRelayNoneCopy")}</p>
            <a className="button primary compact" href={NH_STUDIO_DOWNLOAD_URL} target="_blank" rel="noreferrer">
              {t("appSetupDownload")}
            </a>
          </section>
        )}
      </section>

      <HubsSection
        hubs={hubs}
        deletingId={deletingGatewayId}
        onManage={(hub) => setManageHubId(hub.gateway_id)}
        onDelete={handleDelete}
      />

      {onlineLegacy.length ? (
        <section className="gateways-section">
          <h2>{t("sectionLegacyGateways")}</h2>
          <section className="gateway-grid">
            {onlineLegacy.map((gateway) => (
              <GatewayCard
                key={gateway.gateway_id}
                gateway={gateway}
                deleting={deletingGatewayId === gateway.gateway_id}
                onManage={(item) => setManageGatewayId(item.gateway_id)}
                onDelete={handleDelete}
              />
            ))}
          </section>
        </section>
      ) : null}

      <InactiveRelays relays={inactive} deletingId={deletingGatewayId} onDelete={handleDelete} onPrune={() => setConfirmPrune(true)} />

      <section className="gateway-tools panel">
        <div className="gateway-tools-copy">
          <h3>{t("gatewayToolsTitle")}</h3>
          <p>{t("gatewayToolsCopy")}</p>
        </div>
        <div className="gateway-setup-grid">
          <div className="gateway-setup">
            <div className="gateway-setup-head">
              <h4>{t("sectionAppRelays")}</h4>
              <div className="gateway-tool-actions">
                <a className="button primary compact" href={NH_STUDIO_DOWNLOAD_URL} target="_blank" rel="noreferrer">
                  {t("appSetupDownload")}
                </a>
              </div>
            </div>
            <p>{t("appSetupCopy")}</p>
            <ol className="gateway-instructions">
              <li>{t("appStepInstall")}</li>
              <li>{t("appStepToken")}</li>
              <li>{t("appStepConnect")}</li>
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
      {manageGatewayId ? <GatewayManageModal gatewayId={manageGatewayId} onClose={() => setManageGatewayId("")} /> : null}
      {confirmDelete ? (
        <ConfirmModal
          title={confirmDelete.client_type === "hub" ? t("deleteHubConfirm") : isAppRelay(confirmDelete) ? t("deleteRelayConfirm") : t("deleteGatewayConfirm")}
          message={`${relayDisplayName(confirmDelete)} ${confirmDelete.gateway_id} — ${confirmDelete.client_type === "hub" ? t("deleteHubCopy") : isAppRelay(confirmDelete) ? t("deleteRelayCopy") : t("deleteGatewayCopy")}`}
          confirmLabel={confirmDelete.client_type === "hub" ? t("deleteHub") : t("deleteGateway")}
          cancelLabel={t("cancel")}
          destructive
          onConfirm={() => {
            const gateway = confirmDelete;
            setConfirmDelete(null);
            void deleteRelay(gateway);
          }}
          onCancel={() => setConfirmDelete(null)}
        />
      ) : null}
      {confirmPrune ? (
        <ConfirmModal
          title={t("pruneOfflineConfirm")}
          message={t("pruneOfflineCopy")}
          confirmLabel={t("pruneOfflineRelays")}
          cancelLabel={t("cancel")}
          destructive
          onConfirm={() => {
            setConfirmPrune(false);
            void pruneOffline();
          }}
          onCancel={() => setConfirmPrune(false)}
        />
      ) : null}
    </>
  );
}
