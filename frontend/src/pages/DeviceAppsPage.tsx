import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useParams, useSearchParams } from "react-router-dom";
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
      // Never silent: entering maintenance stops the scan, which on a
      // recording device is not something to do behind the operator's back.
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
          <h1>{t("deviceApps")}</h1>
          <p className="device-apps-subtitle">
            {normalized?.displayName || deviceUid}
            <span className={`mode-badge ${maintenanceMode ? "maintenance" : "normal"}`}>
              {maintenanceMode ? t("maintenanceModeLabel") : t("normalModeLabel")}
            </span>
          </p>
        </div>
        <Link className="button" to="/apps">{t("appStoreTitle")}</Link>
      </header>

      {errorMessage ? <p className="notice error">{errorMessage}</p> : null}
      {notice ? <p className={`notice ${notice.kind}`}>{notice.text}</p> : null}

      {catalogEntry ? (
        <section className="app-install-panel">
          <h3>{t("appInstallTitle")}: {localised(catalogEntry.name)} v{catalogEntry.version}</h3>
          <p className="app-install-summary">{localised(catalogEntry.summary)}</p>
          <dl className="app-detail-facts">
            <div><dt>{t("appMinOs")}</dt><dd>{catalogEntry.min_os}</dd></div>
            <div><dt>{t("appSize")}</dt><dd>{catalogEntry.package.size} B</dd></div>
            {typeof catalogEntry.nodes === "number"
              ? <div><dt>{t("appNodes")}</dt><dd>{catalogEntry.nodes}</dd></div> : null}
          </dl>

          {!supportsRegistry ? (
            <p className="notice error">{t("appRegistryUnsupported")}</p>
          ) : !maintenanceMode ? (
            <p className="notice warning">
              {t("appInstallRequiresMaintenance")}{" "}
              <button type="button" className="button" disabled={running}
                      onClick={() => void toggleMaintenance(true)}>
                {t("appInstallEnterMaintenance")}
              </button>
            </p>
          ) : null}

          {phase ? (
            <div className="app-install-progress">
              <span>{t(`appInstallPhase_${phase}`)}</span>
              <div className="progress-track">
                <div className="progress-bar" style={{ width: `${percent}%` }} />
              </div>
              <span>{percent}%</span>
              <button type="button" className="button"
                      onClick={() => { abortRef.current.current = true; }}>
                {t("appInstallCancel")}
              </button>
            </div>
          ) : (
            <div className="app-install-actions">
              <button
                type="button"
                className="button primary"
                disabled={running || !maintenanceMode || !supportsRegistry}
                onClick={() => void install()}
              >
                {t("appInstall")}
              </button>
              <button type="button" className="button" onClick={() => {
                params.delete("install");
                setParams(params, { replace: true });
              }}>
                {t("cancel")}
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

      {maintenanceMode ? (
        <p className="app-exit-maintenance">
          <button type="button" className="button" disabled={running}
                  onClick={() => void toggleMaintenance(false)}>
            {t("appInstallExitMaintenance")}
          </button>
        </p>
      ) : null}
    </div>
  );
}
