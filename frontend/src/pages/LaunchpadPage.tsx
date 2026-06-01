import { Link } from "react-router-dom";

import { useI18n } from "../i18n";
import { useDevicesPolling, type NormalizedDevice } from "../lib/device";

const GLOBAL_APPS = [
  { to: "/visualization", icon: "VIS", titleKey: "visualization" },
  { to: "/gateways", icon: "GW", titleKey: "navGateways" },
  { to: "/profiles", icon: "PF", titleKey: "profileEditor" },
  { to: "/csv", icon: "CSV", titleKey: "csvExport" },
];

function modeClass(device: NormalizedDevice) {
  if (device.isOffline) return "offline";
  if (device.mode === "maintenance" || device.mode === "safe_maintenance") return "maintenance";
  return "normal";
}

function batteryLabel(device: NormalizedDevice, t: (key: string, vars?: Record<string, string | number>) => string) {
  if (device.batteryState === "charging") return t("batteryChargingOrMissing");
  if (device.batteryState === "charge_done") return t("batteryChargeDone");
  if (device.batteryState === "not_charging") return t("batteryNotCharging");
  return "-";
}

export function LaunchpadPage() {
  const { t } = useI18n();
  const { normalized, errorMessage } = useDevicesPolling();

  return (
    <>
      <section className="page-header desktop-header">
        <div>
          <h2>{t("desktopTitle")}</h2>
        </div>
      </section>
      {errorMessage ? <p className="notice error">{errorMessage}</p> : null}

      <section className="desktop-section">
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
        <div className="device-grid">
          {normalized.map((device) => (
            <article key={device.uid} className={`device-card ${modeClass(device)}`}>
              <Link className="device-main-link" to={`/device/${encodeURIComponent(device.uid)}/settings`}>
                <div className="device-icon" aria-hidden="true">
                  NH
                </div>
                <div className="device-card-copy">
                  <div className="device-card-header">
                    <h3>{device.displayName}</h3>
                    <span className={`device-badge ${modeClass(device)}`}>
                      {device.mode}
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
              </div>
            </article>
          ))}
        </div>
      </section>

      <section className="desktop-section">
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
    </>
  );
}
