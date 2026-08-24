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
  const fillHeight = fillPercent === null ? 0 : (12 * fillPercent) / 100;
  const fillY = 17 - fillHeight;

  return (
    <span className={`battery-status-indicator ${className}`.trim()} role="img" aria-label={ariaLabel}>
      <svg viewBox="0 0 28 22" aria-hidden="true" focusable="false">
        <rect className="battery-status-indicator-outline" x="2" y="3" width="20" height="16" rx="3" />
        <rect className="battery-status-indicator-terminal" x="23" y="8" width="3" height="6" rx="1" />
        {fillHeight > 0 ? (
          <rect
            className="battery-status-indicator-fill"
            x="4"
            y={fillY}
            width="16"
            height={fillHeight}
            rx="1"
          />
        ) : null}
        {charging ? <path className="battery-status-indicator-bolt" d="M14 5.5 9.8 12h3l-1 4.5 4.4-6.8h-3Z" /> : null}
      </svg>
    </span>
  );
}
