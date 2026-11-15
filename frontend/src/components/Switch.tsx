/** An iOS-style on/off switch (styles: `.apps-switch`). `pending` dims it
 * while the device catches up. Used for every on/off setting. */
export function Switch({
  checked,
  disabled,
  pending,
  label,
  stopPropagation,
  onChange,
}: {
  checked: boolean;
  disabled?: boolean;
  pending?: boolean;
  label: string;
  /** Inside a clickable card: keep the click from opening it. */
  stopPropagation?: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      title={label}
      className={`apps-switch${checked ? " on" : ""}${pending ? " pending" : ""}`}
      disabled={disabled}
      onClick={(event) => {
        if (stopPropagation) event.stopPropagation();
        onChange(!checked);
      }}
    >
      <i aria-hidden="true" />
    </button>
  );
}

/** A switch with its label beside it; the label toggles it too. */
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
  return (
    <label className={`switch-row${disabled ? " disabled" : ""}`}>
      <Switch checked={checked} disabled={disabled} label={label} onChange={onChange} />
      <span>{label}</span>
    </label>
  );
}
