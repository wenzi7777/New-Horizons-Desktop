import { ChangelogPanel } from "./ChangelogPanel";
import { Select } from "./Select";
import { useI18n } from "../i18n";
import type { RelayUpdateInfo } from "../lib/relayUpdateInfo";
import { normalizeUpdateChannel, waitingForStableToCatchUp } from "../lib/versioning";

// The "update" section of a relay's management dialog (Hub or Gateway):
// current/latest version, check + apply, the stable/beta channel and the
// release notes. The dialog owns the commands and confirmations; this only
// lays them out.

// i18n keys for the text that names the relay.
export type RelayUpdateText = {
  title: string;
  copy: string;
  currentVersion: string;
  latestVersion: string;
  check: string;
  apply: string;
  updating: string;
  inProgress: string;
  // Shown when the relay reports no update block (too old to update remotely).
  needsUpdate: string;
  // Shown when it has an update block but no channel.
  channelNeedsUpdate: string;
};

export function RelayUpdateSection({
  version,
  info,
  checked,
  applying,
  busy,
  disabled,
  text,
  onCheck,
  onRequestApply,
  onChannelStable,
  onRequestBeta,
}: {
  version: string;
  info: RelayUpdateInfo;
  // A check_update has answered (the latest version is then known even if it equals `version`).
  checked: boolean;
  applying: boolean;
  busy: string;
  disabled: boolean;
  text: RelayUpdateText;
  onCheck: () => void;
  onRequestApply: () => void;
  onChannelStable: () => void;
  onRequestBeta: () => void;
}) {
  const { t } = useI18n();
  return (
    <div className="settings-stack">
      <div className="settings-detail-header">
        <div>
          <h3>{t(text.title)}</h3>
          <p>{t(text.copy)}</p>
        </div>
      </div>
      <div className="settings-card">
        <div className="settings-detail-header">
          <div className="metric-row">
            <div className="metric"><div className="metric-label">{t(text.currentVersion)}</div><div className="metric-value">{version || "-"}</div></div>
            <div className="metric"><div className="metric-label">{t(text.latestVersion)}</div><div className="metric-value">{info.latestVersion || (checked ? version || "-" : "-")}</div></div>
          </div>
          <div className="actions compact">
            <button className="button" type="button" disabled={disabled || !info.supportsUpdate} onClick={onCheck}>
              {busy === "check_update" ? t("running") : t(text.check)}
            </button>
            <button
              className={`button${info.updateAvailable ? " primary" : ""}`}
              type="button"
              disabled={disabled || !info.supportsUpdate}
              onClick={onRequestApply}
            >
              {applying ? t(text.updating) : t(text.apply)}
            </button>
          </div>
        </div>
        {info.supportsChannel ? (
          <>
            <div className="field">
              <label>{t("updateChannel")}</label>
              <Select
                value={info.channel}
                disabled={disabled}
                onChange={(event) => {
                  if (normalizeUpdateChannel(event.target.value) === "beta") onRequestBeta();
                  else onChannelStable();
                }}
              >
                <option value="stable">{t("updateChannelStable")}</option>
                <option value="beta">{t("updateChannelBeta")}</option>
              </Select>
            </div>
            {waitingForStableToCatchUp(info.channel, version) ? (
              <p className="cal-hint">{t("updateChannelWaitingStable").replace("{version}", version)}</p>
            ) : null}
            {info.channel === "beta" ? <p className="cal-hint">{t("updateChannelBetaActive")}</p> : null}
          </>
        ) : info.supportsUpdate ? (
          <p className="service-muted">{t(text.channelNeedsUpdate)}</p>
        ) : null}
        {applying ? <p className="cal-hint">{t(text.inProgress)}</p> : null}
        {info.changelogUrl ? <ChangelogPanel url={info.changelogUrl} /> : null}
        {!info.supportsUpdate ? <p className="service-muted">{t(text.needsUpdate)}</p> : null}
      </div>
    </div>
  );
}

// The banner a dialog shows while its relay is behind a required update.
// `auto_apply: "retry_later"` means the last automatic attempt failed.
export function RelayRequiredUpdateBanner({
  info,
  applying,
  textKey,
  retryTextKey,
}: {
  info: RelayUpdateInfo;
  applying: boolean;
  textKey: string;
  retryTextKey: string;
}) {
  const { t } = useI18n();
  if (!info.requiredUpdate || applying) return null;
  return (
    <p className="notice error">
      {t(info.autoApply === "retry_later" ? retryTextKey : textKey).replace("{version}", info.requiredVersion || info.latestVersion)}
    </p>
  );
}
