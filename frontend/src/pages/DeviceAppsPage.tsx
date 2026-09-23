import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useParams, useSearchParams } from "react-router-dom";
import { Download, Store, Wrench } from "lucide-react";
import { DeviceAppsPanel } from "../components/DeviceAppsPanel";
import { useI18n } from "../i18n";
import { api } from "../lib/api";
import type { AppCatalogEntry, AppPackage } from "../lib/appLibrary";
import { compareVersions, useLocalised } from "../lib/appLibrary";
import { normalizeDevice, useDevicesPolling } from "../lib/device";
import { appErrorKey } from "../lib/deviceApps";
import { useDeviceCommand } from "../lib/deviceCommand";
import {
  type InstallPhase,
  type TransferProgress,
  installAppPackage,
} from "../lib/deviceFileTransfer";

function isMaintenance(mode: string | undefined): boolean {
  return mode === "maintenance" || mode === "safe_maintenance" || mode === "SafeMaintenance";
}

export function DeviceAppsPage() {
  const { t } = useI18n();
  const localised = useLocalised();
  const { deviceUid = "" } = useParams();
  const [params, setParams] = useSearchParams();
  const { devices } = useDevicesPolling();
  const { queue, running, errorMessage } = useDeviceCommand(deviceUid);

  const device = devices.find((item) => item.device_uid === deviceUid);
  const normalized = device ? normalizeDevice(device) : null;
  const maintenanceMode = isMaintenance(normalized?.mode);
  const firmwareVersion = device?.firmware_version;
  // The registry only exists from v1.1.0; on an older device the install and
  // package controls are hidden rather than shown and then failing.
  const supportsRegistry = !firmwareVersion || compareVersions(firmwareVersion, "v1.1.0") >= 0;

  const installId = params.get("install") || "";
  const [catalogEntry, setCatalogEntry] = useState<AppCatalogEntry | null>(null);
  const [phase, setPhase] = useState<InstallPhase | null>(null);
  const [progress, setProgress] = useState<TransferProgress | null>(null);
  const [notice, setNotice] = useState<{ text: string; kind: "success" | "error" } | null>(null);
  const abortRef = useRef({ current: false });

  useEffect(() => {
    if (!installId) {
      setCatalogEntry(null);
      return;
    }
    let cancelled = false;
    api
      .appLibraryApp(installId)
      .then((response) => {
        if (!cancelled) setCatalogEntry(response.app);
      })
      .catch(() => {
        if (!cancelled) setNotice({ text: t("appNotFound"), kind: "error" });
      });
    return () => {
      cancelled = true;
    };
  }, [installId, t]);

  const describeError = useCallback(
    (raw: string) => {
      const key = appErrorKey(raw);
      return key ? t(key) : `${t("appErrorUnknown")}: ${raw}`;
    },
    [t],
  );

  const install = useCallback(async () => {
    if (!catalogEntry) return;
    setNotice(null);
    abortRef.current.current = false;
    try {
      // The backend fetches, verifies the sha256 and validates the package
      // before any of it reaches the device.
      const { package: pkg }: { package: AppPackage } = await api.appLibraryPackage(catalogEntry.id);
      await installAppPackage(queue, {
        appId: pkg.id,
        devicePath: pkg.device_path,
        dataHex: pkg.data_hex,
        sha256: pkg.sha256,
        // Always replace. The upload has already overwritten apps/<id>.nha by
        // the time app_install runs, so refusing an installed id would leave
        // the index describing the old package while the file is the new one.
        // Replacing keeps the slot binding and rebinds the new graph.
        replace: true,
        onPhase: setPhase,
        onProgress: setProgress,
        abortRef: abortRef.current,
      });
      setNotice({ text: `${t("appInstallComplete")}: ${pkg.id}`, kind: "success" });
      params.delete("install");
      setParams(params, { replace: true });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      setNotice({ text: `${t("appInstallFailed")}: ${describeError(reason)}`, kind: "error" });
    } finally {
      setPhase(null);
      setProgress(null);
    }
  }, [catalogEntry, queue, t, describeError, params, setParams]);

  const toggleMaintenance = useCallback(
    async (enable: boolean) => {
      await queue({ command: enable ? "enter_maintenance" : "exit_maintenance",
                    ...(enable ? { reason: "app_install" } : {}) });
    },
    [queue],
  );

  const percent = progress && progress.total
    ? Math.round((progress.loaded / progress.total) * 100)
    : 0;

  return (
    <div className="device-apps-page">
      <header className="device-apps-page-header">
        <div>
          <p className="device-apps-eyebrow">{normalized?.displayName || deviceUid}</p>
          <h1>{t("deviceApps")}</h1>
        </div>
        <Link className="button" to="/apps">
          <Store size={15} strokeWidth={2} />
          {t("appStoreTitle")}
        </Link>
      </header>

      {supportsRegistry ? (
        <div className={`app-maintenance-banner${maintenanceMode ? " active" : ""}`}>
          <span className="app-maintenance-icon" aria-hidden="true">
            <Wrench size={18} strokeWidth={1.75} />
          </span>
          <div className="app-maintenance-copy">
            <strong>{maintenanceMode ? t("maintenanceModeLabel") : t("normalModeLabel")}</strong>
            <span>{maintenanceMode ? t("appMaintenanceActive") : t("appMaintenanceNeeded")}</span>
          </div>
          {/* Never silent: entering maintenance stops the scan, so it is always
              the operator's explicit step. */}
          <button
            type="button"
            className={`button compact${maintenanceMode ? "" : " primary"}`}
            disabled={running}
            onClick={() => void toggleMaintenance(!maintenanceMode)}
          >
            {maintenanceMode ? t("appInstallExitMaintenance") : t("appInstallEnterMaintenance")}
          </button>
        </div>
      ) : null}

      {errorMessage ? <p className="notice error">{errorMessage}</p> : null}
      {notice ? <p className={`notice ${notice.kind}`}>{notice.text}</p> : null}

      {catalogEntry ? (
        <section className="app-install-panel">
          <div className="app-install-hero">
            {catalogEntry.icon_url ? (
              <img className="app-card-icon" src={catalogEntry.icon_url} alt="" />
            ) : (
              <div className="app-card-icon app-card-icon-fallback" aria-hidden="true" />
            )}
            <div>
              <span className="app-install-eyebrow">{t("appInstallTitle")}</span>
              <h3>{localised(catalogEntry.name)} <span className="app-row-version">v{catalogEntry.version}</span></h3>
              <p className="app-install-summary">{localised(catalogEntry.summary)}</p>
            </div>
          </div>
          <dl className="app-detail-facts">
            <div><dt>{t("appMinOs")}</dt><dd>{catalogEntry.min_os}</dd></div>
            <div><dt>{t("appSize")}</dt><dd>{catalogEntry.package.size} B</dd></div>
            {typeof catalogEntry.nodes === "number"
              ? <div><dt>{t("appNodes")}</dt><dd>{catalogEntry.nodes}</dd></div> : null}
          </dl>

          {!supportsRegistry ? (
            <p className="notice error">{t("appRegistryUnsupported")}</p>
          ) : !maintenanceMode ? (
            <p className="app-install-note">{t("appInstallRequiresMaintenance")}</p>
          ) : null}

          {phase ? (
            <div className="app-install-progress">
              <div className="app-install-progress-label">
                <span>{t(`appInstallPhase_${phase}`)}</span>
                <span className="app-mono">{percent}%</span>
              </div>
              <div className="progress-track">
                <div className="progress-bar" style={{ width: `${percent}%` }} />
              </div>
              <button type="button" className="button ghost compact"
                      onClick={() => { abortRef.current.current = true; }}>
                {t("appInstallCancel")}
              </button>
            </div>
          ) : (
            <div className="app-install-actions">
              <button type="button" className="button ghost" onClick={() => {
                params.delete("install");
                setParams(params, { replace: true });
              }}>
                {t("cancel")}
              </button>
              <button
                type="button"
                className="button primary"
                disabled={running || !maintenanceMode || !supportsRegistry}
                onClick={() => void install()}
              >
                <Download size={15} strokeWidth={2} />
                {t("appInstall")}
              </button>
            </div>
          )}
        </section>
      ) : null}

      <DeviceAppsPanel
        runner={queue}
        maintenanceMode={maintenanceMode}
        supportsRegistry={supportsRegistry}
        busy={running}
      />
    </div>
  );
}
