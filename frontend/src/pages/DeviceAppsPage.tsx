import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useParams, useSearchParams } from "react-router-dom";
import { Store, Wrench } from "lucide-react";
import { AppInstallDialog } from "../components/AppInstallDialog";
import { DeviceAppsPanel } from "../components/DeviceAppsPanel";
import { useI18n } from "../i18n";
import { api } from "../lib/api";
import type { AppCatalogEntry } from "../lib/appLibrary";
import { compareVersionCores } from "../lib/versioning";
import { normalizeDevice, useDevicesPolling } from "../lib/device";
import { pollDeviceCommand, useDeviceCommand } from "../lib/deviceCommand";
import { type CommandRunner } from "../lib/deviceFileTransfer";

function isMaintenance(mode: string | undefined): boolean {
  return mode === "maintenance" || mode === "safe_maintenance" || mode === "SafeMaintenance";
}

export function DeviceAppsPage() {
  const { t } = useI18n();
  const { deviceUid = "" } = useParams();
  const [params, setParams] = useSearchParams();
  const { devices } = useDevicesPolling();
  const { queue: rawQueue, running, errorMessage } = useDeviceCommand(deviceUid);

  // The live preview polls app_view on the same device. Operator commands
  // (and every chunk of an install) wait out a poll in flight, and a poll
  // skips while any of them runs: a Hub relays one command per device at a
  // time, so the two must never overlap.
  const pollInFlightRef = useRef<Promise<unknown> | null>(null);
  const actionsInFlightRef = useRef(0);
  const queue = useCallback<CommandRunner>(
    async (payload, timeoutMs) => {
      actionsInFlightRef.current += 1;
      try {
        if (pollInFlightRef.current) await pollInFlightRef.current.catch(() => undefined);
        return await rawQueue(payload, timeoutMs);
      } finally {
        actionsInFlightRef.current -= 1;
      }
    },
    [rawQueue],
  );
  const poll = useCallback<CommandRunner>(
    async (payload, timeoutMs) => {
      if (actionsInFlightRef.current > 0 || pollInFlightRef.current) return { result: null };
      const pending = pollDeviceCommand(deviceUid, payload, timeoutMs);
      pollInFlightRef.current = pending;
      try {
        return await pending;
      } finally {
        pollInFlightRef.current = null;
      }
    },
    [deviceUid],
  );

  const device = devices.find((item) => item.device_uid === deviceUid);
  const normalized = device ? normalizeDevice(device) : null;
  const maintenanceMode = isMaintenance(normalized?.mode);
  const firmwareVersion = device?.firmware_version;
  // The registry only exists from v1.1.0; on an older device the install and
  // package controls are hidden rather than shown and then failing.
  const supportsRegistry = !firmwareVersion || compareVersionCores(firmwareVersion, "v1.1.0") >= 0;

  const installId = params.get("install") || "";
  const [catalogEntry, setCatalogEntry] = useState<AppCatalogEntry | null>(null);
  const [notice, setNotice] = useState<{ text: string; kind: "success" | "error" } | null>(null);

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

  const toggleMaintenance = useCallback(
    async (enable: boolean) => {
      await queue({ command: enable ? "enter_maintenance" : "exit_maintenance",
                    ...(enable ? { reason: "app_install" } : {}) });
    },
    [queue],
  );

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
        <AppInstallDialog
          app={catalogEntry}
          devices={devices}
          initialDeviceUid={deviceUid}
          onClose={() => {
            params.delete("install");
            setParams(params, { replace: true });
          }}
        />
      ) : null}

      <DeviceAppsPanel
        runner={queue}
        poll={poll}
        maintenanceMode={maintenanceMode}
        supportsRegistry={supportsRegistry}
        busy={running}
      />
    </div>
  );
}
