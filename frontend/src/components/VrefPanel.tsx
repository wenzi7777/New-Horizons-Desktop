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
  URL.revokeObjectURL(url);
}

export function VrefPanel({ disabled, vref, range, run }: Props) {
  const { t } = useI18n();
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
  const [limitDraft, setLimitDraft] = useState("800");
  const [measureVref, setMeasureVref] = useState("");
  const [rfbRows, setRfbRows] = useState<RfbRow[] | null>(null);
  const [modeDraft, setModeDraft] = useState(modeNow);
  const [refRfbDraft, setRefRfbDraft] = useState(String(refRfbNow));
  const [leakDraft, setLeakDraft] = useState(leakNow);
  const [sweepStart, setSweepStart] = useState("100");
  const [sweepStop, setSweepStop] = useState("800");
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
      return result;
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      return null;
    } finally {
      setBusy(null);
    }
  }

  const working = disabled || busy !== null;
  const rfbValid = knownRows > 0;

  async function measureRfb() {
    const mv = Number(measureVref);
    const result = await send("rfb_measure", t("rfbMeasure"), measureVref.trim() && Number.isFinite(mv) ? { vref_mv: mv } : {}, 30000);
    if (result && Array.isArray(result.rows)) setRfbRows(result.rows as RfbRow[]);
  }

  async function runSweep() {
    const result = await send("vref_sweep", t("sweepTitle"), {
      start_mv: Number(sweepStart),
      stop_mv: Number(sweepStop),
      step_mv: Number(sweepStep),
      settle_ms: Number(sweepSettle),
    }, 90000);
    if (result && Array.isArray(result.steps)) {
      setSweep({
        rows: num(result.rows) ?? 0,
        cols: num(result.cols) ?? 0,
        steps: result.steps as SweepStep[],
        calibration: {
          rfb_ohm: Array.isArray(result.rfb_ohm) ? (result.rfb_ohm as unknown[]).map((v) => num(v) ?? 0) : undefined,
          offset_mv: Array.isArray(result.offset_mv) ? (result.offset_mv as unknown[]).map((v) => num(v) ?? 0) : undefined,
        },
        fallbackRfbOhm: Number(sweepSolderedRfb) > 0 ? Number(sweepSolderedRfb) : 0,
      });
    }
  }

  const summary: SweepSummary[] = sweep ? summarizeSweep(sweep.steps, sweep.rows, sweep.cols, sweep.calibration, sweep.fallbackRfbOhm || undefined) : [];
  const spread = rsSpreadFraction(summary);

  return (
    <>
      {error ? <p className="notice error">{error}</p> : null}

      <div className="settings-subsection">
        <h4>{t("vrefControlTitle")}</h4>
        <p className="service-muted">{t("vrefLimitWarn")}</p>
        <div className="field-grid">
          <div className="field">
            <label>{t("vrefInputLabel")}</label>
            <input type="number" min="100" step="10" value={vrefDraft} onChange={(event) => setVrefDraft(event.target.value)} />
          </div>
          <div className="field">
            <label>{t("vrefLimitInputLabel")}</label>
            <input type="number" min={SAFE_VREF_MV} max="2000" step="10" value={limitDraft} onChange={(event) => setLimitDraft(event.target.value)} />
          </div>
        </div>
        <div className="actions compact">
          <button className="button primary" type="button" disabled={working} onClick={() => void send("set_vref", t("vrefApply"), { mv: Number(vrefDraft) })}>{busy === "set_vref" ? t("running") : t("vrefApply")}</button>
          <button className="button" type="button" disabled={working} onClick={() => void send("set_vref", t("vrefReset"), { mv: SAFE_VREF_MV })}>{t("vrefReset")}</button>
          <button className="button" type="button" disabled={working} onClick={() => void send("set_vref", t("vrefLimitApply"), { limit_mv: Number(limitDraft) })}>{t("vrefLimitApply")}</button>
          <button className="button" type="button" disabled={working || vref.calibration_available === false} onClick={() => void send("calibration_switch", t("vrefCalibrationSwitch"), { on: !calibrationOn })}>
            {calibrationOn ? t("calSwitchTurnOff") : t("calSwitchTurnOn")}
          </button>
        </div>
      </div>

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
          <button className="button primary" type="button" disabled={working} onClick={() => void measureRfb()}>{busy === "rfb_measure" ? t("running") : t("rfbMeasure")}</button>
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
        ) : <p className="service-muted">{t("rfbNotMeasured")}</p>}
      </div>

      <div className="settings-subsection">
        <h4>{t("rangeTitle")}</h4>
        <p className="service-muted">{t("rangeCopy")}</p>
        {!rfbValid ? <p className="notice">{t("rangeNeedsRfb")}</p> : null}
        <div className="field-grid">
          <div className="field">
            <label>{t("rangeMode")}</label>
            <Select value={modeDraft} onChange={(event) => setModeDraft(event.target.value)}>
              <option value="raw">{t("rangeModeRaw")}</option>
              <option value="virtual" disabled={!rfbValid}>{t("rangeModeVirtual")}</option>
              <option value="auto" disabled={!rfbValid}>{t("rangeModeAuto")}</option>
            </Select>
          </div>
          <div className="field">
            <label>{t("rangeRefRfb")}</label>
            <input type="number" min="1000" max="1000000" step="1000" value={refRfbDraft} onChange={(event) => setRefRfbDraft(event.target.value)} />
          </div>
          <div className="field">
            <label><input type="checkbox" checked={leakDraft} onChange={(event) => setLeakDraft(event.target.checked)} /> {t("rangeLeak")}</label>
          </div>
        </div>
        <p className="service-muted">{t("rangeSaturated")}: {num(range.saturated_rows) ?? "-"}</p>
        <div className="actions compact">
          <button className="button primary" type="button" disabled={working} onClick={() => void send("set_range", t("rangeApply"), { mode: modeDraft, ref_rfb_ohm: Number(refRfbDraft), leak_comp: leakDraft })}>{busy === "set_range" ? t("running") : t("rangeApply")}</button>
          <button className="button" type="button" disabled={working || !rfbValid} onClick={() => void send("set_range", t("rfbClear"), { clear_rfb: true })}>{t("rfbClear")}</button>
        </div>
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
          <button className="button primary" type="button" disabled={working} onClick={() => void runSweep()}>{busy === "vref_sweep" ? t("sweepRunning") : t("sweepRun")}</button>
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
    </>
  );
}
