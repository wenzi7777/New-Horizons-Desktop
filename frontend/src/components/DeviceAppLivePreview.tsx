import { useEffect, useRef, useState } from "react";
import { useI18n } from "../i18n";
import { type AppViewState, isUnknownCommand, parseAppView } from "../lib/deviceApps";
import type { CommandRunner } from "../lib/deviceFileTransfer";
import { LedDot, OledPanel, StripPixels } from "./sdk/IndicatorViews";

/** The fastest the preview asks; a slow link (ESP-NOW via a Hub) slows it further. */
const MIN_INTERVAL_MS = 500;
const POLL_TIMEOUT_MS = 4000;

type Props = {
  /**
   * Background runner: it must skip, not queue, while an operator's command is
   * in flight, and must not log or mark the page busy. Every poll is one
   * command on the device's only command pipe.
   */
  poll: CommandRunner;
  /** At least one slot is running a graph; with none there is nothing to show. */
  active: boolean;
  /** An operator action is in flight; the preview holds off until it is done. */
  paused: boolean;
};

/**
 * What the running apps put on the OLED, the status LED and the strip, as the
 * device reports it through app_view -- after the lowest-slot-wins rules and
 * the system's own claim on the LED, which a browser-side simulation of one
 * package cannot know.
 */
export function DeviceAppLivePreview({ poll, active, paused }: Props) {
  const { t } = useI18n();
  const [enabled, setEnabled] = useState(true);
  const [view, setView] = useState<AppViewState | null>(null);
  const [unsupported, setUnsupported] = useState(false);
  const [stale, setStale] = useState(false);

  // Read through refs so the loop is not torn down by a parent re-render.
  const pollRef = useRef(poll);
  pollRef.current = poll;
  const pausedRef = useRef(paused);
  pausedRef.current = paused;

  useEffect(() => {
    if (!active) setView(null);
  }, [active]);

  useEffect(() => {
    if (!enabled || !active || unsupported) return undefined;
    let cancelled = false;
    let timer = 0;
    let intervalMs = MIN_INTERVAL_MS;
    const tick = async () => {
      if (cancelled) return;
      if (!pausedRef.current && document.visibilityState === "visible") {
        const started = performance.now();
        try {
          const response = await pollRef.current({ command: "app_view" }, POLL_TIMEOUT_MS);
          const result = response.result;
          if (!cancelled && result) {
            if (isUnknownCommand(result)) {
              setUnsupported(true);
            } else if (result.status !== "error" && result.ok !== false) {
              setView(parseAppView(result));
              setStale(false);
            }
            // Twice the round trip, so the preview never takes more than half
            // the link: a UDP device answers in tens of ms, a Hub hop in
            // hundreds.
            intervalMs = Math.max(MIN_INTERVAL_MS, Math.round((performance.now() - started) * 2));
          }
        } catch {
          if (!cancelled) setStale(true);
        }
      }
      if (!cancelled) timer = window.setTimeout(() => void tick(), intervalMs);
    };
    void tick();
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [enabled, active, unsupported]);

  const toggle = (
    <label className="app-live-toggle">
      <input type="checkbox" checked={enabled} onChange={(event) => setEnabled(event.target.checked)} />
      {t("appLiveToggle")}
    </label>
  );

  if (unsupported) {
    return (
      <section className="app-live">
        <header className="app-live-head">
          <h4>{t("appLiveTitle")}</h4>
        </header>
        <p className="app-events-note">{t("appLiveUnsupported")}</p>
      </section>
    );
  }

  const rows = view?.oled.rows ?? [null, null, null, null];
  const led = view?.statusLed;
  const ext = view?.extLed;
  const request = led?.request ?? null;
  const conflicts = rows.flatMap((row, index) =>
    row && row.contended.length ? [{ row: index + 1, winner: row.slot, losers: row.contended }] : [],
  );

  return (
    <section className={`app-live${stale ? " stale" : ""}`}>
      <header className="app-live-head">
        <h4>{t("appLiveTitle")}</h4>
        {toggle}
      </header>

      {!active ? (
        <p className="app-events-note">{t("appLiveIdle")}</p>
      ) : (
        <div className="app-live-grid">
          <div className="app-live-oled">
            <div className="app-live-caption">
              <span>OLED</span>
              {view ? (
                <span className={`app-pill${view.oled.onScreen ? "" : " warning"}`}>
                  {!view.oled.hw
                    ? t("appLiveNoPanel")
                    : view.oled.onScreen
                      ? t("appLiveOnScreen")
                      : `${t("appLiveOffScreen")}: ${view.oled.page || "-"}`}
                </span>
              ) : null}
            </div>
            <OledPanel rows={rows} />
            <ol className="app-live-rows">
              {rows.map((row, index) => (
                <li key={index}>
                  <span className="app-mono">{index + 1}</span>
                  <span>{row ? row.slot : "—"}</span>
                </li>
              ))}
            </ol>
          </div>

          <div className="app-live-side">
            <div className="app-live-led">
              <div className="app-live-caption">
                <span>{t("appLiveStatusLed")}</span>
              </div>
              <div className="app-live-led-row">
                <LedDot rgb={led?.rgb ?? [0, 0, 0]} />
                <span>
                  {led
                    ? led.owner === "system"
                      ? `${t("appLiveSystem")}: ${led.signal || "-"}`
                      : led.owner
                    : "—"}
                </span>
              </div>
              {request?.suppressed ? (
                <p className="app-live-note">
                  {t("appLiveLedSuppressed").replace("{slot}", request.slot)}
                  <i className="app-live-swatch" style={{ background: `rgb(${request.rgb.join(",")})` }} />
                </p>
              ) : null}
            </div>

            {ext && ext.count > 0 ? (
              <div className="app-live-strip">
                <div className="app-live-caption">
                  <span>{t("sdkEmuExtLed")}</span>
                  <span className="app-mono">{ext.owner === "app" ? "app" : ext.owner || "-"}</span>
                </div>
                {ext.pixels ? (
                  <StripPixels pixels={ext.pixels} />
                ) : (
                  <p className="app-live-note">{t("appLiveStripPreset")}</p>
                )}
              </div>
            ) : null}
          </div>
        </div>
      )}

      {active && (conflicts.length || request?.contended.length) ? (
        <ul className="app-live-conflicts">
          {conflicts.map((conflict) => (
            <li key={conflict.row} className="app-pill warning">
              {t("appLiveRowConflict")
                .replace("{row}", String(conflict.row))
                .replace("{slots}", [conflict.winner, ...conflict.losers].join(", "))
                .replace("{winner}", conflict.winner)}
            </li>
          ))}
          {request && request.contended.length ? (
            <li className="app-pill warning">
              {t("appLiveLedConflict")
                .replace("{slots}", [request.slot, ...request.contended].join(", "))
                .replace("{winner}", request.slot)}
            </li>
          ) : null}
        </ul>
      ) : null}
    </section>
  );
}
