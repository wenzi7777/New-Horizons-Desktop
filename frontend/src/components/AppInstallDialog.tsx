import { useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { Check, Circle, Loader2, X } from "lucide-react";

import { DevicePickCard } from "./DevicePickCard";
import { useI18n } from "../i18n";
import { api, type DeviceEntry } from "../lib/api";
import { compareVersionCores, useLocalised, type AppCatalogEntry, type AppPackage } from "../lib/appLibrary";
import { normalizeDevice, type NormalizedDevice } from "../lib/device";
import { appErrorKey } from "../lib/deviceApps";
import { useDeviceCommand } from "../lib/deviceCommand";
import { installAppPackage, type TransferProgress } from "../lib/deviceFileTransfer";

// Installing a library app from the App Store, start to finish in one dialog:
// pick a device (compatible, online ones first), confirm, then watch each
// step. Maintenance mode is entered for the install and left again after it
// -- but only when this dialog entered it.

type Step = "maintenance" | "upload" | "install" | "restore";
type Stage = "pick" | "confirm" | "installing" | "done" | "error";

// The app registry exists from firmware v1.1.0 on.
const REGISTRY_MIN_FIRMWARE = "v1.1.0";

function isMaintenance(mode: string | undefined): boolean {
  return mode === "maintenance" || mode === "safe_maintenance";
}

type Candidate = {
  entry: DeviceEntry;
  device: NormalizedDevice;
  // i18n key of why it cannot take this app, or "" when it can.
  blocker: string;
};

function resultFailure(result: Record<string, unknown> | null | undefined): string {
  if (!result) return "command_delivery_timeout";
  if (result.ok === false || result.status === "error") {
    return String(result.error || result.message || "device_error");
  }
  return "";
}

export function AppInstallDialog({
  app,
  devices,
  initialDeviceUid = "",
  onClose,
}: {
  app: AppCatalogEntry;
  devices: DeviceEntry[];
  // A device already chosen (the device's own Apps page): starts at confirm.
  initialDeviceUid?: string;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const localised = useLocalised();
  const [stage, setStage] = useState<Stage>(initialDeviceUid ? "confirm" : "pick");
  const [showAll, setShowAll] = useState(false);
  const [selectedUid, setSelectedUid] = useState(initialDeviceUid);
  const [step, setStep] = useState<Step | null>(null);
  const [skipMaintenance, setSkipMaintenance] = useState(false);
  const [progress, setProgress] = useState<TransferProgress | null>(null);
  const [error, setError] = useState("");
  const abortRef = useRef({ current: false });
  const { queue } = useDeviceCommand(selectedUid);

  const minFirmware = compareVersionCores(app.min_os || "v0.0.0", REGISTRY_MIN_FIRMWARE) > 0 ? app.min_os : REGISTRY_MIN_FIRMWARE;
  const candidates = useMemo<Candidate[]>(() => {
    const list = devices.map((entry) => {
      const device = normalizeDevice(entry);
      let blocker = "";
      if (device.isControlUnavailable) blocker = "appInstallBlockedOffline";
      else if (!device.firmwareVersion || compareVersionCores(device.firmwareVersion, minFirmware) < 0) blocker = "appInstallBlockedFirmware";
      return { entry, device, blocker };
    });
    return list.sort((a, b) => Number(Boolean(a.blocker)) - Number(Boolean(b.blocker)) || a.device.displayName.localeCompare(b.device.displayName));
  }, [devices, minFirmware]);
  const usable = candidates.filter((item) => !item.blocker);
  const shown = showAll ? candidates : usable;
  const selected = candidates.find((item) => item.entry.device_uid === selectedUid) ?? null;

  // Escape closes, except while the device is being written to.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape" && stage !== "installing") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [stage, onClose]);

  const describeError = (raw: string) => {
    const key = appErrorKey(raw);
    return key ? t(key) : `${t("appErrorUnknown")}: ${raw}`;
  };

  async function install() {
    if (!selected) return;
    const alreadyInMaintenance = isMaintenance(selected.device.mode);
    setSkipMaintenance(alreadyInMaintenance);
    setStage("installing");
    setError("");
    setProgress(null);
    abortRef.current.current = false;
    let entered = false;
    try {
      // Fetched (and sha256-checked by the backend) before touching the device.
      const { package: pkg }: { package: AppPackage } = await api.appLibraryPackage(app.id);
      if (!alreadyInMaintenance) {
        setStep("maintenance");
        const entering = await queue({ command: "enter_maintenance", reason: "app_install" });
        const failure = resultFailure(entering.result);
        if (failure) throw new Error(failure);
        entered = true;
      }
      await installAppPackage(queue, {
        appId: pkg.id,
        devicePath: pkg.device_path,
        dataHex: pkg.data_hex,
        sha256: pkg.sha256,
        // See DeviceAppsPage: the upload has already replaced the file by the
        // time app_install runs, so the index must follow it.
        replace: true,
        onPhase: (phase) => {
          if (phase === "upload" || phase === "install") setStep(phase);
        },
        onProgress: setProgress,
        abortRef: abortRef.current,
      });
      if (entered) {
        setStep("restore");
        await queue({ command: "exit_maintenance" });
        entered = false;
      }
      setStep(null);
      setStage("done");
    } catch (caught) {
      setError(describeError(caught instanceof Error ? caught.message : String(caught)));
      setStage("error");
      // Leave the device the way we found it, even after a failure.
      if (entered) {
        setStep("restore");
        await queue({ command: "exit_maintenance" }).catch(() => undefined);
      }
      setStep(null);
    }
  }

  const percent = progress && progress.total ? Math.round((progress.loaded / progress.total) * 100) : 0;
  const steps: Step[] = skipMaintenance ? ["upload", "install"] : ["maintenance", "upload", "install", "restore"];
  const stepIndex = step ? steps.indexOf(step) : stage === "done" ? steps.length : -1;

  return (
    <div className="modal-backdrop" role="presentation" onClick={stage === "installing" ? undefined : onClose}>
      <div
        className={`modal-panel app-install-dialog${stage === "pick" ? " picking" : ""}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby="app-install-title"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="modal-header">
          <div>
            <h3 id="app-install-title">{t("appInstallDialogTitle").replace("{app}", localised(app.name))}</h3>
            <p>v{app.version} · {t("appMinOs")} {app.min_os}</p>
          </div>
          <button className="button ghost compact" type="button" aria-label={t("cancel")} disabled={stage === "installing"} onClick={onClose}>
            <X size={16} strokeWidth={2} />
          </button>
        </div>

        {stage === "pick" ? (
          <>
            <div className="app-install-pick-header">
              <span>{t("appInstallPickDevice")}</span>
              <label className="app-install-show-all">
                <input type="checkbox" checked={showAll} onChange={(event) => setShowAll(event.target.checked)} />
                {t("appInstallShowAll").replace("{count}", String(candidates.length - usable.length))}
              </label>
            </div>
            {shown.length ? (
              <div className="device-grid app-install-devices">
                {shown.map(({ entry, device, blocker }) => (
                  <DevicePickCard
                    key={entry.device_uid}
                    entry={entry}
                    device={device}
                    disabled={Boolean(blocker)}
                    selected={selectedUid === entry.device_uid}
                    onClick={() => setSelectedUid(entry.device_uid)}
                    footer={blocker ? (
                      <span className="app-install-blocker">{t(blocker).replace("{version}", minFirmware)}</span>
                    ) : selectedUid === entry.device_uid ? (
                      <span className="app-install-chosen"><Check size={13} strokeWidth={2.4} aria-hidden="true" /> {t("appInstallSelected")}</span>
                    ) : t("appInstallChoose")}
                    t={t}
                  />
                ))}
              </div>
            ) : (
              <p className="app-empty">{candidates.length ? t("appInstallNoCompatible") : t("appInstallNoDevices")}</p>
            )}
            <div className="actions compact app-install-dialog-actions">
              <button className="button" type="button" onClick={onClose}>{t("cancel")}</button>
              <button className="button primary" type="button" disabled={!selected || Boolean(selected.blocker)} onClick={() => setStage("confirm")}>
                {t("appInstallNext")}
              </button>
            </div>
          </>
        ) : null}

        {stage === "confirm" && selected?.blocker ? (
          <>
            <p className="notice error">
              {selected.device.displayName}: {t(selected.blocker).replace("{version}", minFirmware)}
            </p>
            <div className="actions compact app-install-dialog-actions">
              <button className="button" type="button" onClick={() => setStage("pick")}>{t("appInstallBack")}</button>
            </div>
          </>
        ) : null}

        {stage === "confirm" && selected && !selected.blocker ? (
          <>
            <p className="app-install-target">
              <strong>{localised(app.name)}</strong> v{app.version} → <strong>{selected.device.displayName}</strong>
            </p>
            <p className="service-muted">
              {isMaintenance(selected.device.mode) ? t("appInstallMaintenanceKept") : t("appInstallMaintenanceNote")}
            </p>
            <div className="actions compact app-install-dialog-actions">
              <button className="button" type="button" onClick={() => setStage("pick")}>{t("appInstallBack")}</button>
              <button className="button primary" type="button" onClick={() => void install()}>{t("appInstallStart")}</button>
            </div>
          </>
        ) : null}

        {stage === "installing" || stage === "done" || stage === "error" ? (
          <>
            <ol className="app-install-steps">
              {steps.map((item, index) => {
                const state = stage === "done" || index < stepIndex ? "done" : index === stepIndex ? "active" : "pending";
                return (
                  <li key={item} className={`app-install-step ${state}`}>
                    {state === "done" ? <Check size={16} strokeWidth={2.4} aria-hidden="true" />
                      : state === "active" ? <Loader2 size={16} strokeWidth={2} className="app-install-spin" aria-hidden="true" />
                        : <Circle size={16} strokeWidth={2} aria-hidden="true" />}
                    <span>{t(`appInstallStep_${item}`)}</span>
                    {item === "upload" && state === "active" ? <span className="app-install-percent">{percent}%</span> : null}
                  </li>
                );
              })}
            </ol>
            {step === "upload" ? (
              <div className="app-install-bar" aria-hidden="true">
                <div style={{ width: `${percent}%` }} />
              </div>
            ) : null}
            {stage === "done" && selected ? (
              <p className="notice success">{t("appInstallDone").replace("{device}", selected.device.displayName)}</p>
            ) : null}
            {stage === "error" ? <p className="notice error">{t("appInstallFailed")}: {error}</p> : null}
            <div className="actions compact app-install-dialog-actions">
              {stage === "installing" ? (
                <button className="button" type="button" onClick={() => { abortRef.current.current = true; }}>
                  {t("cancel")}
                </button>
              ) : (
                <>
                  {selected ? (
                    <Link className="button" to={`/device/${encodeURIComponent(selected.entry.device_uid)}/apps`}>
                      {t("appInstallOpenDeviceApps")}
                    </Link>
                  ) : null}
                  {stage === "error" ? (
                    <button className="button" type="button" onClick={() => setStage("pick")}>{t("appInstallBack")}</button>
                  ) : null}
                  <button className="button primary" type="button" onClick={onClose}>{t("appInstallClose")}</button>
                </>
              )}
            </div>
          </>
        ) : null}
      </div>
    </div>
  );
}
