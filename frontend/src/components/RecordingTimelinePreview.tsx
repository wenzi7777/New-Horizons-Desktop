import { useState } from "react";
import { useI18n } from "../i18n";
import type { RecordingTimelineResponse } from "../lib/api";
import { envelopePolygons, formatDuration } from "../lib/recordingAnalysis";

const WIDTH = 320;
const HEIGHT = 90;

function compact(value: number) {
  if (!Number.isFinite(value)) return "—";
  if (Math.abs(value) >= 10000) return `${(value / 1000).toFixed(0)}k`;
  if (Math.abs(value) >= 1000) return `${(value / 1000).toFixed(1)}k`;
  return value.toFixed(value >= 100 ? 0 : 1);
}

// A recording at a glance for the CSV export preview: total pressure over
// the whole run as a min/max band, its length and rate, gaps, and where its
// app events fall. Drawn from a few kB the backend boils the file down to;
// the Data Analysis tool is the place for the rows themselves.
export function RecordingTimelinePreview({ timeline }: { timeline: RecordingTimelineResponse }) {
  const { t, locale } = useI18n();
  const [hover, setHover] = useState<number | null>(null);
  const count = timeline.buckets.length;
  const polygons = envelopePolygons(timeline.buckets, WIDTH, HEIGHT, timeline.max_value);
  const clean = timeline.lost_frames === 0 && timeline.gaps === 0 && timeline.restarts === 0;
  const hovered = hover !== null ? timeline.buckets[hover] : null;
  const duration = timeline.duration_ms;

  function handleMove(event: React.MouseEvent<SVGSVGElement>) {
    const rect = event.currentTarget.getBoundingClientRect();
    if (!count || rect.width <= 0) return;
    const index = Math.floor(((event.clientX - rect.left) / rect.width) * count);
    setHover(Math.max(0, Math.min(count - 1, index)));
  }

  return (
    <div className="timeline-preview">
      <div className="timeline-preview-head">
        <span>{t("filesTimelineSeries")}</span>
        <span className="timeline-preview-readout">
          {hover !== null
            ? `${formatDuration(hover * timeline.bucket_ms, false)} · ${hovered ? `${compact(hovered[0])}–${compact(hovered[1])}` : t("filesTimelineNoData")}`
            : `${t("filesTimelinePeak")} ${compact(timeline.max_value)}`}
        </span>
      </div>
      <svg
        className="timeline-preview-chart"
        viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
        preserveAspectRatio="none"
        role="img"
        aria-label={t("filesTimelineSeries")}
        onMouseMove={handleMove}
        onMouseLeave={() => setHover(null)}
      >
        <line x1="0" x2={WIDTH} y1={HEIGHT - 0.5} y2={HEIGHT - 0.5} className="timeline-preview-axis" />
        {polygons.map((points, index) => (
          <polygon key={index} points={points} className="timeline-preview-band" />
        ))}
        {duration > 0
          ? timeline.events.map((event, index) => {
            const x = (event.at_ms / duration) * WIDTH;
            return (
              <line key={index} x1={x} x2={x} y1={0} y2={HEIGHT} className="timeline-preview-event">
                <title>{`${formatDuration(event.at_ms)} · ${event.label}`}</title>
              </line>
            );
          })
          : null}
        {hover !== null ? (
          <line x1={((hover + 0.5) / count) * WIDTH} x2={((hover + 0.5) / count) * WIDTH} y1={0} y2={HEIGHT} className="timeline-preview-cursor" />
        ) : null}
      </svg>
      <div className="timeline-preview-axis-labels">
        <span>0:00</span>
        <span>{formatDuration(duration / 2, false)}</span>
        <span>{formatDuration(duration, false)}</span>
      </div>
      <dl className="timeline-preview-stats">
        <div>
          <dt>{t("analysisDuration")}</dt>
          <dd>{formatDuration(duration)}</dd>
        </div>
        <div>
          <dt>{t("analysisSamples")}</dt>
          <dd>{timeline.rows.toLocaleString(locale)}</dd>
        </div>
        <div>
          <dt>{t("analysisRate")}</dt>
          <dd>{timeline.rate_hz.toFixed(1)} Hz</dd>
        </div>
        <div className={clean ? "good" : "warn"}>
          <dt>{t("analysisContinuity")}</dt>
          <dd>
            {clean
              ? t("analysisContinuous")
              : [
                timeline.lost_frames ? t("analysisIssueLost").replace("{count}", String(timeline.lost_frames)) : "",
                timeline.gaps ? `${t("analysisGaps")} ${timeline.gaps}` : "",
                timeline.restarts ? `${t("analysisRestarts")} ${timeline.restarts}` : "",
              ].filter(Boolean).join(" · ")}
          </dd>
        </div>
        {timeline.events_total ? (
          <div>
            <dt>{t("analysisEvents")}</dt>
            <dd>{timeline.events_total}</dd>
          </div>
        ) : null}
      </dl>
    </div>
  );
}
