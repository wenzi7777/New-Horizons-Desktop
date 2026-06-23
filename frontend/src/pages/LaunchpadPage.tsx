import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { Folder, X } from "lucide-react";

import { useI18n } from "../i18n";
import { useDevicesPolling, type NormalizedDevice } from "../lib/device";

const GLOBAL_APPS = [
  { to: "/visualization", icon: "VIS", titleKey: "visualization" },
  { to: "/gateways", icon: "GW", titleKey: "navGateways" },
  { to: "/profiles", icon: "PF", titleKey: "profileEditor" },
  { to: "/csv", icon: "CSV", titleKey: "csvExport" },
];
const FOLDER_PREVIEW_SLOTS = 4;

type LaunchpadFolder = {
  id: string;
  label: string;
  devices: NormalizedDevice[];
  tone: "online" | "offline" | "custom";
};

function deviceClassName(device: NormalizedDevice) {
  if (device.connectionState === "reconnecting") return "reconnecting";
  if (device.connectionState === "offline") return "offline";
  if (device.mode === "maintenance" || device.mode === "safe_maintenance") return "maintenance";
  if (device.connectionState === "booting") return "booting";
  return "normal";
}

function deviceStateLabel(device: NormalizedDevice, t: (key: string) => string) {
  if (device.connectionState === "reconnecting") return t("reconnecting");
  if (device.connectionState === "offline") return t("offline");
  return device.mode;
}

function batteryLabel(device: NormalizedDevice, t: (key: string) => string) {
  if (device.batteryState === "charging") return t("batteryChargingOrMissing");
  if (device.batteryState === "charge_done") return t("batteryChargeDone");
  if (device.batteryState === "not_charging") return t("batteryNotCharging");
  return "-";
}

function deviceMacSuffix(uid: string) {
  return uid.slice(-4).toUpperCase();
}

function renderDeviceCode(uid: string) {
  const suffix = deviceMacSuffix(uid);
  return (
    <span className="device-code-mark">
      <span>{suffix.slice(0, 2)}</span>
      <span>{suffix.slice(2, 4)}</span>
    </span>
  );
}

function folderPreviewCaption(devices: NormalizedDevice[]) {
  if (devices.length === 0) return "";
  if (devices.length === 1) return devices[0].displayName;
  const visible = devices.slice(0, 2).map((device) => device.displayName);
  return devices.length > 2 ? `${visible.join(" · ")} · +${devices.length - 2}` : visible.join(" · ");
}

function renderDeviceCard(device: NormalizedDevice, t: (key: string) => string) {
  return (
    <article key={device.uid} className={`device-card ${deviceClassName(device)}`}>
      <Link className="device-main-link" to={`/device/${encodeURIComponent(device.uid)}/settings`}>
        <div className="device-icon" aria-hidden="true">{renderDeviceCode(device.uid)}</div>
        <div className="device-card-copy">
          <div className="device-card-header">
            <h3>{device.displayName}</h3>
            <span className={`device-badge ${deviceClassName(device)}`}>
              {deviceStateLabel(device, t)}
            </span>
          </div>
          <div className="device-uid">{device.uid}</div>
          <div className="device-meta-grid">
            <span>{t("hardwareModel")}: {device.hardwareModel}</span>
            <span>Firmware: {device.firmwareVersion}</span>
            <span>Protocol: {device.protocol}</span>
            <span>{t("battery")}: {batteryLabel(device, t)}</span>
            <span>{t("transport")}: {device.transportMode}</span>
            <span>{t("log")}: {device.logging}</span>
            <span>{t("lastSeen")}: {device.lastSeen}</span>
          </div>
        </div>
      </Link>
      <div className="device-card-actions">
        <Link className="button" to={`/device/${encodeURIComponent(device.uid)}/settings`}>
          {t("settingsApp")}
        </Link>
        <Link className="button" to={`/device/${encodeURIComponent(device.uid)}/files`}>
          {t("deviceFiles")}
        </Link>
        <Link className="button" to={`/device/${encodeURIComponent(device.uid)}/commands`}>
          {t("advancedCommands")}
        </Link>
        <Link className="button" to={`/device/${encodeURIComponent(device.uid)}/wiki`}>
          {t("deviceWiki")}
        </Link>
      </div>
    </article>
  );
}

export function LaunchpadPage() {
  const { t } = useI18n();
  const { normalized, errorMessage } = useDevicesPolling();
  const [activeFolder, setActiveFolder] = useState<LaunchpadFolder | null>(null);

  const folders = useMemo<LaunchpadFolder[]>(() => {
    const online: NormalizedDevice[] = [];
    const offline: NormalizedDevice[] = [];
    const customGroups = new Map<string, NormalizedDevice[]>();

    normalized.forEach((device) => {
      if (device.connectionState === "online") {
        online.push(device);
      } else {
        offline.push(device);
      }
      // device.device_group remains the backend payload source-of-truth for custom folders.
      const customGroup = String(device.raw.device_group ?? device.deviceGroup ?? "");
      if (customGroup) {
        const current = customGroups.get(customGroup) ?? [];
        current.push(device);
        customGroups.set(customGroup, current);
      }
    });

    const sortDevices = (items: NormalizedDevice[]) =>
      items.slice().sort((left, right) => left.displayName.localeCompare(right.displayName));

    return [
      {
        id: "default-online",
        label: t("deviceGroupOnline"),
        devices: sortDevices(online),
        tone: "online",
      },
      {
        id: "default-offline",
        label: t("deviceGroupOffline"),
        devices: sortDevices(offline),
        tone: "offline",
      },
      ...Array.from(customGroups.entries())
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([label, devices]) => ({
          id: `custom:${label}`,
          label,
          devices: sortDevices(devices),
          tone: "custom" as const,
        })),
    ];
  }, [normalized, t]);

  const activeFolderSnapshot = activeFolder ? folders.find((folder) => folder.id === activeFolder.id) ?? activeFolder : null;

  return (
    <>
      <section className="page-header desktop-header">
        <div>
          <h2>{t("desktopTitle")}</h2>
        </div>
      </section>
      {errorMessage ? <p className="notice error">{errorMessage}</p> : null}

      <section className="desktop-section launchpad-groups">
        <h3>{t("discoveredDevices")}</h3>
        {normalized.length === 0 ? (
          <div className="panel empty-device-state">
            <div className="empty-device-visual" aria-hidden="true">
              <div className="empty-device-rings">
                <span />
                <span />
                <span />
              </div>
              <div className="empty-device-icon">NH</div>
            </div>
            <div className="empty-device-copy">
              <h4>{t("emptyDevicesTitle")}</h4>
              <p>{t("emptyDevicesCopy")}</p>
              <div className="empty-device-checks" aria-label={t("emptyDevicesChecklist")}>
                <span>{t("emptyDevicesServer")}</span>
                <span>{t("emptyDevicesWifi")}</span>
                <span>{t("emptyDevicesControl")}</span>
              </div>
            </div>
          </div>
        ) : null}
        <div className="folder-grid">
          {folders.map((folder) => (
            <button
              key={folder.id}
              className={`folder-preview-card ${folder.tone}${folder.devices.length === 0 ? " is-empty" : ""}`}
              type="button"
              disabled={folder.devices.length === 0}
              onClick={() => setActiveFolder(folder)}
            >
              <div className="folder-preview-header">
                <div className="folder-preview-title">
                  <Folder size={18} strokeWidth={1.8} />
                  <strong>{folder.label}</strong>
                </div>
                <span className="folder-count-badge">{folder.devices.length}</span>
              </div>
              {folder.devices.length > 0 ? (
                <>
                  <div className="folder-preview-grid">
                    {Array.from({ length: FOLDER_PREVIEW_SLOTS }).map((_, index) => {
                      const device = folder.devices[index];
                      if (!device) {
                        return <div key={`${folder.id}-placeholder-${index}`} className="folder-device-chip placeholder" aria-hidden="true" />;
                      }
                      return (
                        <div key={device.uid} className={`folder-device-chip ${deviceClassName(device)}`}>
                          {renderDeviceCode(device.uid)}
                        </div>
                      );
                    })}
                  </div>
                  <p className="folder-preview-caption">{folderPreviewCaption(folder.devices)}</p>
                </>
              ) : (
                <div className="folder-preview-empty" aria-hidden="true">
                  <span />
                  <span />
                  <span />
                  <span />
                </div>
              )}
            </button>
          ))}
        </div>
      </section>

      <section className="desktop-section launchpad-apps">
        <h3>{t("globalApps")}</h3>
        <div className="launch-grid">
          {GLOBAL_APPS.map((card) => (
            <Link key={card.to} to={card.to} className="launch-card">
              <div className="launch-icon">{card.icon}</div>
              <div>
                <h3>{t(card.titleKey)}</h3>
              </div>
            </Link>
          ))}
        </div>
      </section>

      {activeFolderSnapshot ? (
        <div className="folder-overlay" role="dialog" aria-modal="true" aria-label={activeFolderSnapshot.label}>
          <div className="folder-overlay-backdrop" onClick={() => setActiveFolder(null)} />
          <div className="folder-overlay-panel">
            <div className="folder-overlay-header">
              <div>
                <h3>{activeFolderSnapshot.label}</h3>
                <p>{activeFolderSnapshot.devices.length} {t("discoveredDevices").toLowerCase()}</p>
              </div>
              <button className="button icon-button" type="button" aria-label={t("closeToast")} onClick={() => setActiveFolder(null)}>
                <X size={18} />
              </button>
            </div>
            <div className="device-grid folder-overlay-grid">
              {activeFolderSnapshot.devices.map((device) => renderDeviceCard(device, t))}
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}
