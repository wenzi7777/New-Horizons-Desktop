import { useI18n } from "../../i18n";
import type { OledRow } from "../../sdk/lib/index.mjs";

// The panel's geometry: AppDisplay.h's kOledRows / kOledRowPx / kOledWidthPx,
// which the SDK's opset.mjs also pins. Restated rather than imported so the
// device Apps panel, which is in the main bundle, does not pull in the whole
// SDK (the simulator and compiler) along with three numbers.
const OLED_ROWS = 4;
const OLED_ROW_PX = 8;
const OLED_WIDTH_PX = 128;

/**
 * The device's outputs drawn as plain data, shared by the SDK emulator (which
 * computes them in the browser) and the device Apps panel (which mirrors what
 * the device reports through app_view).
 */

export function LedDot({ rgb }: { rgb: readonly [number, number, number] }) {
  const { t } = useI18n();
  const lit = rgb.some((channel) => channel > 0);
  return (
    <span className="sdk-led" title={t("sdkEmuLed")}>
      <i style={{ background: lit ? `rgb(${rgb.join(",")})` : undefined }} className={lit ? "lit" : undefined} />
      LED
    </span>
  );
}

const GLYPH_PX = 6;

/**
 * The OLED as the device's "app" page draws it. Rows come from the SDK's
 * oled.mjs, which mirrors the firmware to the character and the pixel; only
 * the glyphs here are the browser's font rather than the panel's.
 */
export function OledPanel({ rows }: { rows: readonly (Pick<OledRow, "kind" | "label" | "text" | "bar"> | null)[] }) {
  const { t } = useI18n();
  return (
    <div className="sdk-oled-panel">
      <svg viewBox={`0 0 ${OLED_WIDTH_PX} ${OLED_ROWS * OLED_ROW_PX}`} role="img" aria-label={t("sdkEmuOled")}>
        {rows.map((row, index) => {
          if (!row) return null;
          const y = index * OLED_ROW_PX;
          const text = row.kind === "text" ? row.text ?? "" : row.label;
          return (
            <g key={index}>
              {text ? (
                <text x={0} y={y + 7} fontSize={8} fill="currentColor" textLength={text.length * GLYPH_PX} lengthAdjust="spacingAndGlyphs" style={{ whiteSpace: "pre" }}>
                  {text}
                </text>
              ) : null}
              {row.kind === "bar" && row.bar ? (
                <>
                  <rect x={row.bar.x0 + 0.5} y={y + 0.5} width={row.bar.width - 1} height={OLED_ROW_PX - 2} fill="none" stroke="currentColor" strokeWidth={1} />
                  {row.bar.fillPx > 0 ? <rect x={row.bar.x0 + 1} y={y + 1} width={row.bar.fillPx} height={OLED_ROW_PX - 3} fill="currentColor" /> : null}
                </>
              ) : null}
            </g>
          );
        })}
      </svg>
    </div>
  );
}

/** One swatch per strip pixel, numbered; unlit pixels show dark. */
export function StripPixels({ pixels }: { pixels: readonly (readonly number[])[] }) {
  const { t } = useI18n();
  return (
    <div className="sdk-strip" role="img" aria-label={t("sdkEmuExtLed")}>
      {pixels.map((rgb, index) => {
        const lit = rgb.some((channel) => channel > 0);
        return (
          <span key={index} className={`sdk-strip-pixel${lit ? " lit" : ""}`} title={`${index}`} style={lit ? { background: `rgb(${rgb.join(",")})`, color: `rgb(${rgb.join(",")})` } : undefined}>
            <small>{index}</small>
          </span>
        );
      })}
    </div>
  );
}
