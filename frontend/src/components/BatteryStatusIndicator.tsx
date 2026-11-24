import { useId } from "react";

/** The charging bolt, nearly the battery's full height (viewBox 0 0 28 22). */
export const BATTERY_BOLT_PATH = "M14.2 2.6 7.4 12.3h4.5l-1.6 7.1 6.9-10h-4.6Z";

type BatteryStatusIndicatorProps = {
  fillPercent: number | null;
  charging: boolean;
  ariaLabel: string;
  className?: string;
};

export function BatteryStatusIndicator({
  fillPercent,
  charging,
  ariaLabel,
  className = "",
}: BatteryStatusIndicatorProps) {
  const maskId = useId();
  const fillWidth = fillPercent === null ? 0 : (16 * fillPercent) / 100;

  return (
    <span className={`battery-status-indicator${charging ? " is-charging" : ""} ${className}`.trim()} role="img" aria-label={ariaLabel}>
      <svg viewBox="0 0 28 22" aria-hidden="true" focusable="false">
        {charging ? (
          // A gap cut around the bolt (solid, in the battery's colour), so it
          // stands clear over the fill and the empty part, on any background.
          <mask id={maskId} maskUnits="userSpaceOnUse" x="0" y="0" width="28" height="22">
            <rect x="0" y="0" width="28" height="22" fill="#fff" />
            <path d={BATTERY_BOLT_PATH} fill="#000" stroke="#000" strokeWidth="3" strokeLinejoin="round" />
          </mask>
        ) : null}
        <g mask={charging ? `url(#${CSS.escape(maskId)})` : undefined}>
          <rect className="battery-status-indicator-outline" x="2" y="3" width="20" height="16" rx="3" />
          <rect className="battery-status-indicator-terminal" x="23" y="8" width="3" height="6" rx="1" />
          {fillWidth > 0 ? (
            <rect
              className="battery-status-indicator-fill"
              x="4"
              y="5"
              width={fillWidth}
              height="12"
              rx="1"
            />
          ) : null}
        </g>
        {charging ? <path className="battery-status-indicator-bolt" d={BATTERY_BOLT_PATH} /> : null}
      </svg>
    </span>
  );
}
