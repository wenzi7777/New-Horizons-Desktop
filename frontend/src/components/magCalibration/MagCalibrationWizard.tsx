import { useEffect, useMemo, useRef, useState } from "react";
import { Compass, X } from "lucide-react";
import { boardArtFor } from "../../lib/boardArt";
import {
  addVisualizationListener,
  isVisualizationSubscribed,
  subscribeVisualization,
  unsubscribeVisualization,
} from "../../lib/wsClient";
import {
  calibrationDue,
  calibrationFromStatus,
  MAG_CAL_FULL_MIN_COVERAGE,
  MAG_CAL_FULL_MIN_POINTS,
  MAG_REFERENCE_FIELD_UT,
  MagCalibrationSession,
  magCalibrationPayload,
  type MagCalibrationResult,
  type MagCalibrationStatus,
} from "../../lib/magCalibration";
import { BoardTurnAnimation } from "./BoardTurnAnimation";
import { CoverageSphere } from "./CoverageSphere";
import { CalibrationResultPlot } from "./CalibrationResultPlot";

// The magnetometer calibration wizard: (use existing?) -> prepare -> turn the
// board while the live stream fills a coverage sphere -> result (before /
// after, field, residual) -> apply. The fitting is lib/magCalibration's
// MagCalibrationSession (the same as NH Studio / Pocket); this only draws it.
//
// The samples it fits are the stream's -- already calibrated with whatever
// the device holds -- so the new fit is composed onto that one and a cancel
// leaves the old calibration untouched.

export type MagRun = (
  label: string,
  payload: Record<string, unknown>,
  timeoutMs?: number,
  options?: { waitForLock?: boolean; background?: boolean },
) => Promise<{ result: Record<string, unknown> | null }>;

type Phase = "choose" | "prepare" | "collect" | "result";

const NO_SAMPLE_WARN_MS = 3000;

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

export function magModeLabel(t: (key: string) => string, mode: unknown): string {
  return mode === "full" ? t("magCalModeFull") : mode === "hard_iron" ? t("magCalModeHardIron") : t("magCalModeNone");
}

export function MagCalibrationWizard({
  t,
  deviceUid,
  hardwareModel,
  magnetometer,
  fromEnable,
  run,
  onClose,
}: {
  t: (key: string) => string;
  deviceUid: string;
  hardwareModel: string | null | undefined;
  magnetometer: Record<string, unknown>;
  /** Opened by switching the magnetometer on: cancelling switches it off again (the caller does). */
  fromEnable: boolean;
  run: MagRun;
  onClose: (applied: boolean) => void;
}) {
  const calStatus = record(magnetometer.calibration) as MagCalibrationStatus & Record<string, unknown>;
  const existing = useMemo(() => calibrationFromStatus(calStatus), [calStatus.mode, calStatus.calibrated_at_ms]); // eslint-disable-line react-hooks/exhaustive-deps
  const existingDue = calibrationDue(calStatus, Date.now());
  const offerExisting = fromEnable && existing !== null && (existingDue.state === "ok" || existingDue.state === "soon");

  const sessionRef = useRef<MagCalibrationSession | null>(null);
  if (!sessionRef.current) sessionRef.current = new MagCalibrationSession(existing);
  const session = sessionRef.current;

  const [phase, setPhase] = useState<Phase>(offerExisting ? "choose" : "prepare");
  const [, setTick] = useState(0);
  const [result, setResult] = useState<MagCalibrationResult | null>(null);
  const [applying, setApplying] = useState(false);
  const [error, setError] = useState("");
  const lastSampleAtRef = useRef(0);
  const [collectStartedAt, setCollectStartedAt] = useState(0);
  const art = useMemo(() => boardArtFor(hardwareModel), [hardwareModel]);

  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape" && !applying) onClose(false);
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [applying, onClose]);

  // Live samples while collecting. Leave the stream subscription as found.
  useEffect(() => {
    if (phase !== "collect" || !deviceUid) return;
    const hadSubscription = isVisualizationSubscribed(deviceUid);
    if (!hadSubscription) subscribeVisualization(deviceUid);
    const stop = addVisualizationListener((item) => {
      if (item.dn !== deviceUid) return;
      const sample = item.mag ?? item.imu?.mag ?? null;
      if (!sample || sample.length < 3) return;
      lastSampleAtRef.current = Date.now();
      session.add(sample);
    });
    // Redraw a few times a second, not per sample.
    const timer = window.setInterval(() => setTick((n) => n + 1), 200);
    return () => {
      stop();
      window.clearInterval(timer);
      if (!hadSubscription) unsubscribeVisualization(deviceUid);
    };
  }, [deviceUid, phase, session]);

  function startCollecting() {
    session.start();
    lastSampleAtRef.current = 0;
    setCollectStartedAt(Date.now());
    setResult(null);
    setError("");
    setPhase("collect");
  }

  function compute() {
    const next = session.compute();
    if (!next) return;
    setResult(next);
    setPhase("result");
  }

  async function apply() {
    if (!result || result.problem) return;
    setApplying(true);
    setError("");
    try {
      const response = await run(t("magCalApply"), magCalibrationPayload(result.calibration, Date.now()), 20000, { waitForLock: true });
      const reply = response.result;
      const ok = reply !== null && reply.status !== "error" && reply.ok !== false;
      if (!ok) {
        setError(String(reply?.message ?? reply?.error ?? t("magCalApplyFailed")));
        return;
      }
      onClose(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setApplying(false);
    }
  }

  const coverage = session.coverage();
  const pointCount = session.points.length;
  const progress = Math.min(1, Math.min(pointCount / MAG_CAL_FULL_MIN_POINTS, coverage.fraction / MAG_CAL_FULL_MIN_COVERAGE));
  const ready = session.ready();
  const canCompute = session.canCompute();
  const now = Date.now();
  const noSamples = phase === "collect" && now - Math.max(lastSampleAtRef.current, collectStartedAt) > NO_SAMPLE_WARN_MS;
  const magState = String(magnetometer.state ?? "");

  const ringRadius = 26;
  const ringLength = 2 * Math.PI * ringRadius;

  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true" aria-labelledby="mag-cal-title" onClick={() => !applying && onClose(false)}>
      <div className="modal-panel mag-cal-panel" onClick={(event) => event.stopPropagation()}>
        <header className="mag-cal-header">
          <div className="mag-cal-title">
            <Compass size={20} strokeWidth={1.75} aria-hidden="true" />
            <h3 id="mag-cal-title">{t("magCalTitle")}</h3>
          </div>
          <ol className="mag-cal-steps" aria-label={t("magCalTitle")}>
            {(["prepare", "collect", "result"] as const).map((step, index) => (
              <li key={step} className={phase === step ? "active" : (["prepare", "collect", "result"].indexOf(phase) > index ? "done" : "")}>
                {t(`magCalStep_${step}`)}
              </li>
            ))}
          </ol>
          <button className="icon-button" type="button" aria-label={t("cancel")} disabled={applying} onClick={() => onClose(false)}>
            <X size={18} />
          </button>
        </header>

        {phase === "choose" && existing ? (
          <div className="mag-cal-body">
            <p>{t("magCalChooseCopy")}</p>
            <div className="notice">
              {magModeLabel(t, existing.mode)}
              {Number(calStatus.calibrated_at_ms) > 0 ? ` · ${new Date(Number(calStatus.calibrated_at_ms)).toLocaleString()}` : ""}
              {` · ${t("magCalResidual")} ${existing.residualPct.toFixed(1)}%`}
              {existingDue.daysLeft !== null ? ` · ${t("magCalDaysLeft").replace("{n}", String(existingDue.daysLeft))}` : ""}
            </div>
            <div className="actions">
              <button className="button" type="button" onClick={() => setPhase("prepare")}>{t("magCalRecalibrate")}</button>
              <button className="button primary" type="button" onClick={() => onClose(true)}>{t("magCalUseExisting")}</button>
            </div>
          </div>
        ) : null}

        {phase === "prepare" ? (
          <div className="mag-cal-body mag-cal-split">
            <BoardTurnAnimation art={art} caption={t("magCalTurnCaption")} />
            <div className="mag-cal-copy">
              <h4>{t("magCalPrepareTitle")}</h4>
              <ul className="mag-cal-checklist">
                <li>{t("magCalPrepare1")}</li>
                <li>{t("magCalPrepare2")}</li>
                <li>{t("magCalPrepare3")}</li>
              </ul>
              {magState && magState !== "ready" ? (
                <p className="notice warning">{magState === "blocked" ? t("magBlockedByImu") : t("magCalNotReady")}</p>
              ) : null}
              <div className="actions">
                <button className="button" type="button" onClick={() => onClose(false)}>{t("cancel")}</button>
                <button className="button primary" type="button" onClick={startCollecting}>{t("magCalStart")}</button>
              </div>
            </div>
          </div>
        ) : null}

        {phase === "collect" ? (
          <div className="mag-cal-body mag-cal-split">
            <BoardTurnAnimation art={art} caption={t("magCalTurnCaption")} />
            <div className="mag-cal-copy">
              <CoverageSphere coverage={coverage} points={session.points} label={t("magCalSphereLabel")} />
              <div className="mag-cal-progress">
                <svg viewBox="0 0 64 64" className={`mag-cal-ring${ready ? " ready" : ""}`} aria-hidden="true">
                  <circle cx={32} cy={32} r={ringRadius} className="track" />
                  <circle
                    cx={32}
                    cy={32}
                    r={ringRadius}
                    className="value"
                    strokeDasharray={ringLength}
                    strokeDashoffset={ringLength * (1 - progress)}
                    transform="rotate(-90 32 32)"
                  />
                  <text x={32} y={36} textAnchor="middle">{Math.round(progress * 100)}%</text>
                </svg>
                <div>
                  <strong>{ready ? t("magCalReady") : t("magCalCollectCopy")}</strong>
                  <p className="service-muted">
                    {t("magCalCoverage").replace("{pct}", String(Math.round(coverage.fraction * 100)))}
                    {" · "}
                    {t("magCalPoints").replace("{n}", String(pointCount))}
                  </p>
                  {!ready && coverage.nextFace ? <p className="service-muted">{t("magCalNextHint")}</p> : null}
                </div>
              </div>
              {noSamples ? <p className="notice warning">{t("magCalNoSamples")}</p> : null}
              <div className="actions">
                <button className="button" type="button" onClick={() => onClose(false)}>{t("cancel")}</button>
                <button className={ready ? "button primary" : "button"} type="button" disabled={!canCompute} onClick={compute}>
                  {ready || !canCompute ? t("magCalCompute") : t("magCalComputeHardIron")}
                </button>
              </div>
            </div>
          </div>
        ) : null}

        {phase === "result" && result ? (
          <div className="mag-cal-body">
            <CalibrationResultPlot
              before={result.before}
              after={result.after}
              fieldUt={result.fit.fieldUt}
              beforeLabel={t("magCalBefore")}
              afterLabel={t("magCalAfter")}
            />
            <dl className="mag-cal-facts">
              <div><dt>{t("magCalMode")}</dt><dd>{magModeLabel(t, result.calibration.mode)}</dd></div>
              <div>
                <dt>{t("magCalField")}</dt>
                <dd>
                  {result.calibration.fieldUt.toFixed(1)} µT
                  <small>{t("magCalFieldReference").replace("{ref}", String(MAG_REFERENCE_FIELD_UT))}</small>
                </dd>
              </div>
              <div><dt>{t("magCalResidual")}</dt><dd>{result.fit.residualPct.toFixed(2)}%</dd></div>
              <div><dt>{t("magCalPointsLabel")}</dt><dd>{result.before.length}</dd></div>
            </dl>
            {result.fallbackReason ? <p className="notice">{t(`magCalFallback_${result.fallbackReason}`)}</p> : null}
            {result.residualWarn ? <p className="notice warning">{t("magCalResidualWarn")}</p> : null}
            {result.problem ? <p className="notice error">{t("magCalProblem")} ({result.problem})</p> : null}
            <details className="mag-cal-numbers">
              <summary>{t("magCalNumbers")}</summary>
              <p>{t("magCalOffset")}: [{result.calibration.offset.map((v) => v.toFixed(2)).join(", ")}] µT</p>
              <p>{t("magCalMatrix")}:</p>
              <pre>
                {[0, 1, 2].map((row) => result.calibration.matrix.slice(row * 3, row * 3 + 3).map((v) => v.toFixed(4).padStart(8)).join(" ")).join("\n")}
              </pre>
            </details>
            {error ? <p className="notice error">{error}</p> : null}
            <div className="actions">
              <button className="button" type="button" disabled={applying} onClick={() => onClose(false)}>{t("cancel")}</button>
              <button className="button" type="button" disabled={applying} onClick={startCollecting}>{t("magCalRedo")}</button>
              <button className="button primary" type="button" disabled={applying || result.problem !== null} onClick={() => void apply()}>
                {applying ? t("running") : t("magCalApply")}
              </button>
            </div>
          </div>
        ) : null}

        {fromEnable && phase !== "choose" ? <p className="service-muted mag-cal-footnote">{t("magCalCancelDisables")}</p> : null}
      </div>
    </div>
  );
}
