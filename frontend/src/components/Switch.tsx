import { useEffect, useState } from "react";

import { useI18n } from "../i18n";
import { Select } from "./Select";

/** An on/off setting as a select ("On" / "Off"). It only edits a draft: the
 * setting reaches the device with its section's Apply button. */
export function SwitchRow({
  checked,
  disabled,
  label,
  onChange,
}: {
  checked: boolean;
  disabled?: boolean;
  label: string;
  onChange: (checked: boolean) => void;
}) {
  const { t } = useI18n();
  return (
    <label className={`field onoff-row${disabled ? " disabled" : ""}`}>
      <span>{label}</span>
      <Select value={checked ? "on" : "off"} disabled={disabled} onChange={(event) => onChange(event.target.value === "on")}>
        <option value="on">{t("onOffOn")}</option>
        <option value="off">{t("onOffOff")}</option>
      </Select>
    </label>
  );
}

/** On/off with its own Apply button, for a setting with no section button
 * (an app on a device): nothing is sent until Apply. */
export function OnOffApply({
  checked,
  disabled,
  pending,
  label,
  stopPropagation,
  onApply,
}: {
  checked: boolean;
  disabled?: boolean;
  pending?: boolean;
  label: string;
  /** Inside a clickable card: keep the click from opening it. */
  stopPropagation?: boolean;
  onApply: (checked: boolean) => void;
}) {
  const { t } = useI18n();
  const [draft, setDraft] = useState(checked);
  useEffect(() => setDraft(checked), [checked]);
  const stop = (event: { stopPropagation: () => void }) => {
    if (stopPropagation) event.stopPropagation();
  };
  return (
    <span className={`onoff-apply${pending ? " pending" : ""}`} onClick={stop}>
      <Select
        value={draft ? "on" : "off"}
        disabled={disabled || pending}
        aria-label={label}
        onChange={(event) => setDraft(event.target.value === "on")}
      >
        <option value="on">{t("onOffOn")}</option>
        <option value="off">{t("onOffOff")}</option>
      </Select>
      <button
        type="button"
        className="button compact"
        disabled={disabled || pending || draft === checked}
        title={label}
        onClick={(event) => {
          stop(event);
          onApply(draft);
        }}
      >
        {t("onOffApply")}
      </button>
    </span>
  );
}
