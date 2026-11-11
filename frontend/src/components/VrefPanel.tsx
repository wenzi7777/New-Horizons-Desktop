import { useEffect, useState } from "react";

import { useI18n } from "../i18n";
import { rsSpreadFraction, summarizeSweep, sweepCsv, type SweepCalibration, type SweepStep, type SweepSummary } from "../lib/vrefSweep";
import { Select } from "./Select";

// v2.0.F: the Vref DAC, the calibration switch, the measured Rfb per row, the
// range mode and the Vref sweep. The firmware owns every rule (ceiling,
// safe value, what needs a measured Rfb); this only asks and shows the answer.

type PanelRun = (
  label: string,
  payload: Record<string, unknown>,
  timeoutMs?: number,
  options?: { waitForLock?: boolean; background?: boolean },
) => Promise<{ queued?: unknown; result?: Record<string, unknown> | null }>;

type Props = {
  disabled: boolean;
  vref: Record<string, unknown>;
  range: Record<string, unknown>;
  run: PanelRun;
};

type RfbRow = { row: number; off_mv: number; on_mv: number; rfb_ohm: number; offset_mv?: number; method?: string; status: string };
type SweepResult = { rows: number; cols: number; steps: SweepStep[]; calibration: SweepCalibration; fallbackRfbOhm: number };

const SAFE_VREF_MV = 330;
const MIN_VREF_MV = 100;
// The firmware's defaults (VrefPolicy.h): the ceiling, and where the GPIO45
// strap starts to be at risk on a reset that skips the shutdown handler.
const DEFAULT_LIMIT_MV = 700;
const STRAP_MARGIN_MV = 700;
const STRAP_RISK_MV = 800;

type VrefZone = "auto" | "safe" | "raised" | "near" | "risk" | "unknown";

function vrefZone(mv: number | null, mode: string): VrefZone {
  if (mode === "auto") return "auto";
  if (mv === null) return "unknown";
  if (Math.abs(mv - SAFE_VREF_MV) <= 5) return "safe";
  if (mv < STRAP_MARGIN_MV) return "raised";
  if (mv < STRAP_RISK_MV) return "near";
  return "risk";
}

function num(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function kOhm(value: number | null): string {
  return value === null || value <= 0 ? "-" : `${(value / 1000).toFixed(2)} kΩ`;
}

function download(name: string, text: string) {
  const url = URL.createObjectURL(new Blob([text], { type: "text/csv" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  link.click();
  // Revoked right after click(), some browsers cancel the download.
  window.setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

// A number typed in a field, or null when the field is empty or not a number
// (Number("") is 0, which would be sent to the device as a real value).
function fieldNumber(text: string): number | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  const value = Number(trimmed);
  return Number.isFinite(value) ? value : null;
}

// How long a command's own answer outranks the page's status: long enough to
// cover a status poll that was already on its way, not forever.
const ANSWER_FRESH_MS = 10_000;

export function VrefPanel({ disabled, vref: vrefProp, range: rangeProp, run }: Props) {
  const { t } = useI18n();
  // What the device last answered to a command here. The page's own status can
  // lag a command (a status poll lands in between, a relay drops a field), and a
  // Rfb that was just measured must unlock the range modes at once.
  const [answeredVref, setAnsweredVref] = useState<{ at: number; value: Record<string, unknown> } | null>(null);
  const [answeredRange, setAnsweredRange] = useState<{ at: number; value: Record<string, unknown> } | null>(null);
  const now = Date.now();
  const vref = answeredVref && now - answeredVref.at < ANSWER_FRESH_MS ? { ...vrefProp, ...answeredVref.value } : vrefProp;
  const range = answeredRange && now - answeredRange.at < ANSWER_FRESH_MS ? { ...rangeProp, ...answeredRange.value } : rangeProp;
  const currentMv = num(vref.mv);
  const limitMv = num(vref.limit_mv);
  const calibrationOn = vref.calibration_on === true;
  const modeNow = typeof range.mode === "string" ? range.mode : "raw";
  const refRfbNow = num(range.ref_rfb_ohm) ?? 20000;
  const leakNow = range.leak_compensation !== false;
  const rfbTable = Array.isArray(range.rfb_ohm) ? (range.rfb_ohm as unknown[]).map((v) => num(v) ?? 0) : [];
  const rfbOffsets = Array.isArray(range.offset_mv) ? (range.offset_mv as unknown[]).map((v) => num(v) ?? 0) : [];
  const knownRows = num(range.rfb_known_rows) ?? 0;

  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [vrefDraft, setVrefDraft] = useState("330");
  const [limitDraft, setLimitDraft] = useState("700");
  const [measureVref, setMeasureVref] = useState("");
  const [rfbRows, setRfbRows] = useState<RfbRow[] | null>(null);
  const [modeDraft, setModeDraft] = useState(modeNow);
  const [refRfbDraft, setRefRfbDraft] = useState(String(refRfbNow));
  const [leakDraft, setLeakDraft] = useState(leakNow);
  const [sweepStart, setSweepStart] = useState("100");
  const [sweepStop, setSweepStop] = useState("700");
  const [sweepStep, setSweepStep] = useState("100");
  const [sweepSettle, setSweepSettle] = useState("150");
  const [sweepSolderedRfb, setSweepSolderedRfb] = useState("");
  const [sweep, setSweep] = useState<SweepResult | null>(null);

  useEffect(() => { setModeDraft(modeNow); setRefRfbDraft(String(refRfbNow)); setLeakDraft(leakNow); }, [modeNow, refRfbNow, leakNow]);
  useEffect(() => { if (currentMv !== null) setVrefDraft(String(currentMv)); }, [currentMv]);
  useEffect(() => { if (limitMv !== null) setLimitDraft(String(limitMv)); }, [limitMv]);

  async function send(name: string, label: string, payload: Record<string, unknown>, timeoutMs = 20000) {
    setBusy(name);
    setError(null);
    try {
      const response = await run(label, { command: name, ...payload }, timeoutMs, { waitForLock: true });
      const result = response.result;
      if (!result || result.status === "error" || result.ok === false) {
        throw new Error(String(result?.error || result?.message || "no_response"));
      }
      if (result.vref && typeof result.vref === "object") setAnsweredVref({ at: Date.now(), value: result.vref as Record<string, unknown> });
      if (result.range && typeof result.range === "object") setAnsweredRange({ at: Date.now(), value: result.range as Record<string, unknown> });
      return result;
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      return null;
    } finally {
      setBusy(null);
    }
  }

  const working = disabled || busy !== null;
  const eepromMv = num(vref.eeprom_mv);
  const saturatedRows = num(range.saturated_rows);
  // A table that came back from this very measurement counts even if `range` did not.
  const rfbValid = knownRows > 0 || (rfbRows?.some((row) => row.rfb_ohm > 0) ?? false);

  // Sends with the numbers typed; an empty or non-numeric field stops here.
  function numbers(fields: Record<string, string>): Record<string, number> | null {
    const out: Record<string, number> = {};
    for (const [key, text] of Object.entries(fields)) {
      const value = fieldNumber(text);
      if (value === null) {
        setError(t("fieldNumberRequired"));
        return null;
      }
      out[key] = value;
    }
    return out;
  }

  async function sendNumbers(name: string, label: string, fields: Record<string, string>, extra: Record<string, unknown> = {}) {
    const values = numbers(fields);
    if (values === null) return null;
    return send(name, label, { ...extra, ...values });
  }

  // A mode applies at once, with the reference Rfb and leak setting in force.
  async function applyMode(mode: string) {
    if (mode !== "raw" && !rfbValid) return;
    setModeDraft(mode);
    const refRfb = fieldNumber(refRfbDraft) ?? refRfbNow;
    await send("set_range", t("rangeApply"), { mode, ref_rfb_ohm: refRfb, leak_comp: leakDraft });
  }

  async function clearRfb() {
    const result = await send("set_range", t("rfbClear"), { clear_rfb: true });
    // The table measured here is gone on the device too.
    if (result) setRfbRows(null);
  }

  async function measureRfb() {
    const mv = fieldNumber(measureVref);
    const result = await send("rfb_measure", t("rfbMeasure"), mv !== null ? { vref_mv: mv } : {}, 30000);
    if (result && Array.isArray(result.rows)) setRfbRows(result.rows as RfbRow[]);
  }

  async function runSweep() {
    const values = numbers({ start_mv: sweepStart, stop_mv: sweepStop, step_mv: sweepStep, settle_ms: sweepSettle });
    if (values === null) return;
    // The backend waits up to 120 s for a sweep (arduino_response.py); wait a little longer.
    const result = await send("vref_sweep", t("sweepTitle"), values, 130000);
    if (result && Array.isArray(result.steps)) {
      setSweep({
        rows: num(result.rows) ?? 0,
        cols: num(result.cols) ?? 0,
        steps: result.steps as SweepStep[],
        calibration: {
          rfb_ohm: Array.isArray(result.rfb_ohm) ? (result.rfb_ohm as unknown[]).map((v) => num(v) ?? 0) : undefined,
          offset_mv: Array.isArray(result.offset_mv) ? (result.offset_mv as unknown[]).map((v) => num(v) ?? 0) : undefined,
        },
        fallbackRfbOhm: (fieldNumber(sweepSolderedRfb) ?? 0) > 0 ? (fieldNumber(sweepSolderedRfb) ?? 0) : 0,
      });
    }
  }

  const summary: SweepSummary[] = sweep ? summarizeSweep(sweep.steps, sweep.rows, sweep.cols, sweep.calibration, sweep.fallbackRfbOhm || undefined) : [];
  const spread = rsSpreadFraction(summary);

  // The status cards: what the device is doing now.
  const measuredRfb = (rfbRows ? rfbRows.map((row) => row.rfb_ohm) : rfbTable).filter((value) => value > 0);
  const rfbRowCount = rfbRows ? rfbRows.length : rfbTable.length;
  const rfbMedian = measuredRfb.length ? [...measuredRfb].sort((a, b) => a - b)[Math.floor(measuredRfb.length / 2)] : null;
  const zone = vrefZone(currentMv, modeNow);
  // The slider runs from 100 mV to the ceiling; the bar under it marks where
  // a reset that skips the shutdown handler starts to risk the GPIO45 strap.
  const sliderMax = Math.max(SAFE_VREF_MV + 10, limitMv ?? DEFAULT_LIMIT_MV);
  const draftMv = fieldNumber(vrefDraft) ?? SAFE_VREF_MV;
  const span = sliderMax - MIN_VREF_MV;
  const share = (from: number, to: number) => Math.max(0, Math.min(to, sliderMax) - Math.max(from, MIN_VREF_MV)) / span;
  const modeHint = modeNow === "auto" ? t("rangeModeAutoHint") : modeNow === "virtual" ? t("rangeModeVirtualHint") : t("rangeModeRawHint");

  return (
    <>
      {error ? <p className="notice error">{error}</p> : null}

      <div className="metric-row vref-status">
        <div className={`metric vref-zone-${zone}`}>
          <div className="metric-label">{t("vrefMv")}</div>
          <div className="metric-value">{currentMv !== null ? `${currentMv} mV` : "-"}</div>
          <div className="field-hint">{t(`vrefZone_${zone}`)}</div>
        </div>
        <div className="metric">
          <div className="metric-label">{t("rfbValue")}</div>
          <div className="metric-value">{rfbMedian !== null ? kOhm(rfbMedian) : "-"}</div>
          <div className="field-hint">{rfbValid ? `${measuredRfb.length}/${rfbRowCount} ${t("rfbRowsMeasured")}` : t("rfbNotMeasured")}</div>
        </div>
        <div className="metric">
          <div className="metric-label">{t("rangeSaturatedShort")}</div>
          <div className="metric-value">{saturatedRows ?? "-"}</div>
          <div className="field-hint">{calibrationOn ? t("calSwitchStateOn") : t("calSwitchStateOff")}</div>
        </div>
      </div>

      <div className="settings-subsection">
        <h4>{t("rangeMode")}</h4>
        <div className="segmented-control" role="group" aria-label={t("rangeMode")}>
          {(["raw", "virtual", "auto"] as const).map((mode) => (
            <button
              key={mode}
              type="button"
              className={modeNow === mode ? "active" : ""}
              disabled={working || (mode !== "raw" && !rfbValid)}
              onClick={() => void applyMode(mode)}
            >
              {busy === "set_range" && modeDraft === mode ? t("running") : t(`rangeModeShort_${mode}`)}
            </button>
          ))}
        </div>
        <p className="field-hint">{modeHint}</p>
        {!rfbValid ? (
          <div className="notice vref-needs-rfb">
            <span>{t("rangeNeedsRfb")}</span>
            <button className="button" type="button" disabled={working} onClick={() => void measureRfb()}>{busy === "rfb_measure" ? t("running") : t("rfbMeasure")}</button>
          </div>
        ) : null}
        {modeNow !== "raw" ? (
          <div className="field-grid">
            <div className="field">
              <label>{t("rangeRefRfb")}</label>
              <input type="number" min="1000" max="1000000" step="1000" value={refRfbDraft} onChange={(event) => setRefRfbDraft(event.target.value)} />
            </div>
            <label className="switch-row">
              <input type="checkbox" checked={leakDraft} onChange={(event) => setLeakDraft(event.target.checked)} />
              <span>{t("rangeLeak")}</span>
            </label>
            <div className="field settings-field-action">
              <button className="button" type="button" disabled={working} onClick={() => void sendNumbers("set_range", t("rangeApply"), { ref_rfb_ohm: refRfbDraft }, { mode: modeNow, leak_comp: leakDraft })}>{t("rangeApply")}</button>
            </div>
          </div>
        ) : null}
      </div>

      <div className="settings-subsection">
        <h4>{t("vrefControlTitle")}</h4>
        {modeNow === "auto" ? <p className="field-hint">{t("vrefAutoControlled")}</p> : null}
        <div className="vref-slider">
          <input
            type="range"
            min={MIN_VREF_MV}
            max={sliderMax}
            step="10"
            value={Math.min(Math.max(draftMv, MIN_VREF_MV), sliderMax)}
            disabled={working || modeNow === "auto"}
            aria-label={t("vrefInputLabel")}
            onChange={(event) => setVrefDraft(event.target.value)}
          />
          <input type="number" min={MIN_VREF_MV} max={sliderMax} step="10" value={vrefDraft} disabled={modeNow === "auto"} aria-label={t("vrefInputLabel")} onChange={(event) => setVrefDraft(event.target.value)} />
          <span>mV</span>
        </div>
        <div className="vref-zone-bar" aria-hidden="true">
          <span className="safe" style={{ flexGrow: share(MIN_VREF_MV, STRAP_MARGIN_MV) }} />
          <span className="near" style={{ flexGrow: share(STRAP_MARGIN_MV, STRAP_RISK_MV) }} />
          <span className="risk" style={{ flexGrow: share(STRAP_RISK_MV, sliderMax) }} />
        </div>
        <p className="field-hint">{t("vrefZoneLegend")}</p>
        <div className="actions compact">
          <button className="button primary" type="button" disabled={working || modeNow === "auto"} onClick={() => void sendNumbers("set_vref", t("vrefApply"), { mv: vrefDraft })}>{busy === "set_vref" ? t("running") : t("vrefApply")}</button>
          <button className="button" type="button" disabled={working || currentMv === SAFE_VREF_MV} onClick={() => void send("set_vref", t("vrefReset"), { mv: SAFE_VREF_MV })}>{t("vrefReset")}</button>
        </div>
      </div>

      <details className="settings-more">
        <summary>{t("vrefToolsTitle")}</summary>
        <div className="settings-more-body">
          <div className="settings-subsection">
            <h4>{t("rfbTitle")}</h4>
            <p className="service-muted">{t("rfbCopy")}</p>
            <div className="field-grid">
              <div className="field">
                <label>{t("rfbMeasureVref")}</label>
                <input type="number" min="100" step="10" value={measureVref} placeholder={String(currentMv ?? SAFE_VREF_MV)} onChange={(event) => setMeasureVref(event.target.value)} />
              </div>
            </div>
            <div className="actions compact">
              <button className="button" type="button" disabled={working} onClick={() => void measureRfb()}>{busy === "rfb_measure" ? t("running") : t("rfbMeasure")}</button>
              <button className="button" type="button" disabled={working || !rfbValid} onClick={() => void clearRfb()}>{t("rfbClear")}</button>
            </div>
            {rfbValid || rfbRows ? (
              <table className="data-table">
                <thead><tr><th>{t("rfbRow")}</th><th>{t("rfbValue")}</th><th>{t("rfbOffset")}</th><th>{t("rfbStatus")}</th></tr></thead>
                <tbody>
                  {(rfbRows ?? rfbTable.map((value, row) => ({ row, off_mv: 0, on_mv: 0, rfb_ohm: value, offset_mv: rfbOffsets[row], status: value > 0 ? "ok" : "" }))).map((item) => (
                    <tr key={item.row}>
                      <td>{item.row}</td>
                      <td>{kOhm(item.rfb_ohm)}</td>
                      <td>{item.offset_mv !== undefined && item.rfb_ohm > 0 ? `${item.offset_mv > 0 ? "+" : ""}${item.offset_mv.toFixed(1)} mV` : "-"}</td>
                      <td>{item.status ? t(`rfbStatus_${item.status}`) : t("rfbNotMeasured")}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : null}
          </div>

          <div className="settings-subsection">
            <h4>{t("vrefCalibrationSwitch")}</h4>
            <div className="actions compact">
              <button className="button" type="button" disabled={working || vref.calibration_available === false} onClick={() => void send("calibration_switch", t("vrefCalibrationSwitch"), { on: !calibrationOn })}>
                {calibrationOn ? t("calSwitchTurnOff") : t("calSwitchTurnOn")}
              </button>
            </div>
          </div>

          <div className="settings-subsection">
            <h4>{t("vrefLimitMv")}</h4>
            <p className="service-muted">{t("vrefLimitWarn")}</p>
            <div className="field-grid">
              <div className="field">
                <label>{t("vrefLimitInputLabel")}</label>
                <input type="number" min={SAFE_VREF_MV} max="2000" step="10" value={limitDraft} onChange={(event) => setLimitDraft(event.target.value)} />
              </div>
              <div className="field settings-field-action">
                <button className="button" type="button" disabled={working} onClick={() => void sendNumbers("set_vref", t("vrefLimitApply"), { limit_mv: limitDraft })}>{t("vrefLimitApply")}</button>
              </div>
            </div>
            <p className="field-hint">{t("vrefEepromMv")}: {eepromMv !== null ? `${eepromMv} mV` : "-"}{vref.eeprom_ok === false ? " ⚠" : ""}</p>
          </div>

          <div className="settings-subsection">
            <h4>{t("sweepTitle")}</h4>
            <p className="service-muted">{t("sweepCopy")}</p>
            {!rfbValid ? <p className="notice">{t("sweepNeedsRfb")}</p> : null}
            <div className="field-grid">
              <div className="field"><label>{t("sweepStart")}</label><input type="number" min="100" step="10" value={sweepStart} onChange={(event) => setSweepStart(event.target.value)} /></div>
              <div className="field"><label>{t("sweepStop")}</label><input type="number" min="100" step="10" value={sweepStop} onChange={(event) => setSweepStop(event.target.value)} /></div>
              <div className="field"><label>{t("sweepStep")}</label><input type="number" min="10" step="10" value={sweepStep} onChange={(event) => setSweepStep(event.target.value)} /></div>
              <div className="field"><label>{t("sweepSettle")}</label><input type="number" min="20" max="1000" step="10" value={sweepSettle} onChange={(event) => setSweepSettle(event.target.value)} /></div>
              <div className="field"><label>{t("sweepSolderedRfb")}</label><input type="number" min="0" step="100" value={sweepSolderedRfb} onChange={(event) => setSweepSolderedRfb(event.target.value)} /></div>
            </div>
            <div className="actions compact">
              <button className="button" type="button" disabled={working} onClick={() => void runSweep()}>{busy === "vref_sweep" ? t("sweepRunning") : t("sweepRun")}</button>
              {sweep ? <button className="button" type="button" onClick={() => download(`vref-sweep-${Date.now()}.csv`, sweepCsv(sweep.steps, sweep.rows, sweep.cols, sweep.calibration))}>{t("sweepDownload")}</button> : null}
            </div>
            {sweep ? (
              <>
                <table className="data-table">
                  <thead><tr><th>Vref</th><th>{t("sweepRfbMean")}</th><th>{t("sweepRsMedian")}</th><th>{t("sweepUsedCells")}</th><th>{t("sweepSaturatedCells")}</th></tr></thead>
                  <tbody>
                    {summary.map((item) => (
                      <tr key={item.vrefMv}>
                        <td>{item.vrefMv} mV</td>
                        <td>{kOhm(item.rfbMeanOhm)}</td>
                        <td>{kOhm(item.rsMedianOhm)}</td>
                        <td>{item.usedCells}</td>
                        <td>{item.saturatedCells}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {spread !== null ? <p className="service-muted">{t("sweepSpread")}: {(spread * 100).toFixed(1)}%</p> : <p className="service-muted">{t("sweepNoRs")}</p>}
              </>
            ) : null}
          </div>
        </div>
      </details>
    </>
  );
}
