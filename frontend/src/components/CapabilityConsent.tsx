import { ShieldAlert } from "lucide-react";

import { useI18n } from "../i18n";

// What an app may do to the device beyond reading it (lib/appGrant.ts), and
// the checkbox the operator ticks to allow it. Nothing is installed until it
// is ticked: the device itself refuses a package whose grant is missing.
export function CapabilityConsent({
  capabilities,
  agreed,
  onAgree,
}: {
  capabilities: readonly string[];
  agreed: boolean;
  onAgree: (agreed: boolean) => void;
}) {
  const { t } = useI18n();
  if (!capabilities.length) return null;
  return (
    <div className="panel-permissions capability-consent">
      <span className="panel-permissions-title">
        <ShieldAlert size={14} strokeWidth={2} aria-hidden="true" />
        {t("appConsentTitle")}
      </span>
      <ul>
        {capabilities.map((name) => (
          <li key={name}>{t(`appConsent_${name}`)}</li>
        ))}
      </ul>
      <label className="capability-consent-check">
        <input type="checkbox" checked={agreed} onChange={(event) => onAgree(event.target.checked)} />
        {t("appConsentAgree")}
      </label>
    </div>
  );
}
