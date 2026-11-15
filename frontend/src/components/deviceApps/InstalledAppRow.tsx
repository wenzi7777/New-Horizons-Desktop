import { ChevronRight } from "lucide-react";
import { useI18n } from "../../i18n";
import { type AppResources, type DeviceApp, admissionBlocker, formatBytes } from "../../lib/deviceApps";
import { AppGlyph, AppSwitch, isViewKind } from "./AppParts";

/**
 * An installed app that is not running: a settings-list row with a switch
 * that starts it. When the device would refuse it, the row says why next to
 * the switch instead of letting the operator find out by trying.
 */
export function InstalledAppRow({
  app,
  resources,
  disabled,
  pending,
  onToggle,
  onOpen,
}: {
  app: DeviceApp;
  resources: AppResources | null;
  disabled: boolean;
  pending: boolean;
  onToggle: () => void;
  onOpen: () => void;
}) {
  const { t } = useI18n();
  const view = isViewKind(app.kind);
  const blocker = view ? null : admissionBlocker(app, resources);

  return (
    <li className={`apps-row${pending ? " pending" : ""}`}>
      <button type="button" className="apps-row-main" onClick={onOpen}>
        <AppGlyph kind={app.kind} />
        <span className="apps-row-body">
          <span className="apps-row-title">
            <strong>{app.name}</strong>
            <span className="apps-row-version">v{app.version}</span>
          </span>
          <span className="apps-row-meta">
            {view
              ? t(app.kind === "panel" ? "appKindPanel" : "appKindReadout")
              : app.memoryBytes > 0
                ? formatBytes(app.memoryBytes)
                : formatBytes(app.size)}
            {app.burst ? <span className="apps-chip">{t("appsBurst")}</span> : null}
            {app.packageState === "needs_update" ? (
              <span className="app-pill danger" title={t("appNeedsUpdateHint")}>{t("appNeedsUpdate")}</span>
            ) : app.packageState === "load_failed" ? (
              <span className="app-pill danger">{t("appLoadFailed")}</span>
            ) : null}
          </span>
        </span>
        {view ? <ChevronRight className="apps-row-chevron" size={16} strokeWidth={2} aria-hidden="true" /> : null}
      </button>
      {view ? null : (
        <span className="apps-row-side">
          {blocker ? (
            <span className="apps-row-blocker">
              {blocker.kind === "memory"
                ? t("appsNoMemory").replace("{need}", formatBytes(blocker.needBytes))
                : t("appsNoTime").replace("{need}", String(blocker.needUs))}
            </span>
          ) : null}
          <AppSwitch
            checked={false}
            disabled={disabled || Boolean(blocker) || app.packageState === "needs_update"}
            pending={pending}
            label={t("appsTurnOn").replace("{app}", app.name)}
            onChange={() => onToggle()}
          />
        </span>
      )}
    </li>
  );
}
