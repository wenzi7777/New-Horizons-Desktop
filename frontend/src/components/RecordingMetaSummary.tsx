import { useI18n } from "../i18n";
import { formatInstant, recordingEnd, type RecordingMeta } from "../lib/recordingAnalysis";

const OUTPUT_MODE_KEYS: Record<string, string> = {
  raw: "metaOutputRaw",
  tared: "metaOutputTared",
  calibrated: "metaOutputCalibrated",
};

const RELAY_KEYS: Record<string, string> = {
  gateway: "metaRelayGateway",
  hub: "metaRelayHub",
  direct: "metaRelayDirect",
};

// What a recording's .meta.json says about it, as label/value rows: the CSV
// export preview and the Data Analysis overview show the same thing.
export function RecordingMetaSummary({ meta, className }: { meta: RecordingMeta; className?: string }) {
  const { t, locale } = useI18n();
  const unknown = "—";
  const { device, sensors, calibration, stream, transport, recording } = meta;
  const end = recordingEnd(meta);
  const shape = sensors.rows && sensors.cols ? `${sensors.rows} × ${sensors.cols}` : null;
  const relay = transport.relay ? t(RELAY_KEYS[transport.relay] ?? transport.relay) : null;
  const stopText = (() => {
    if (end === "live") return t("metaEndLive");
    if (end === "cut_off") return t("metaEndCutOff");
    const reason = recording.stopReason ?? "";
    const label = reason === "user" ? t("metaEndUser") : reason.startsWith("write_error") ? `${t("metaEndWriteError")} ${reason.slice("write_error:".length).trim()}` : reason;
    return recording.stoppedAt ? `${label} · ${formatInstant(Date.parse(recording.stoppedAt), locale)}` : label;
  })();

  return (
    <>
      <dl className={className}>
        <dt>{t("metaModel")}</dt>
        <dd>{device.hardwareModel ?? unknown}</dd>
        <dt>{t("metaFirmware")}</dt>
        <dd>{device.firmwareVersion ? `${device.firmwareVersion}${device.firmwarePrerelease ? " (beta)" : ""}` : unknown}</dd>
        <dt>{t("metaSensors")}</dt>
        <dd>{sensors.count ?? unknown}{shape ? ` · ${shape}` : ""}</dd>
        <dt>{t("metaCalibration")}</dt>
        <dd>{calibration.outputMode ? t(OUTPUT_MODE_KEYS[calibration.outputMode] ?? calibration.outputMode) : unknown}</dd>
        <dt>{t("metaTargetFps")}</dt>
        <dd>{stream.targetFps ? `${stream.targetFps} Hz` : unknown}</dd>
        <dt>{t("metaTransport")}</dt>
        <dd>{[transport.path, relay, transport.relayId].filter(Boolean).join(" · ") || unknown}</dd>
        <dt>{t("metaStarted")}</dt>
        <dd>{recording.startedAt ? formatInstant(Date.parse(recording.startedAt), locale) : unknown}</dd>
        <dt>{t("metaEnded")}</dt>
        <dd className={end === "cut_off" ? "meta-warn" : undefined}>{stopText}</dd>
        {meta.changes.length ? (
          <>
            <dt>{t("metaChanges")}</dt>
            <dd>{meta.changes.length}</dd>
          </>
        ) : null}
      </dl>
      {!meta.statusReceivedAt ? <p className="meta-note">{t("metaNoStatus")}</p> : null}
    </>
  );
}
