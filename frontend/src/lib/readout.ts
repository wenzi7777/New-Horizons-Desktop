/**
 * Interpreting a readout package.
 *
 * A readout names device commands to poll and widgets to draw. It carries no
 * code, so rendering one cannot execute anything -- which is the whole reason
 * the format is declarative. Anything here that a package could influence is
 * treated as data: field names index into a result, they never become code.
 */

export type ReadoutFormat =
  | "raw" | "int" | "permille" | "micros" | "bytes" | "percent" | "bool" | "text";

export type ReadoutSource = {
  id: string;
  command: string;
  /** Field inside the result's data to take, for list sources. */
  path?: string;
};

export type ReadoutStat = {
  label: string;
  source: string;
  field: string;
  format?: ReadoutFormat;
  hint?: string;
};

export type ReadoutColumn = {
  label: string;
  field: string;
  format?: ReadoutFormat;
  bar?: boolean;
  bar_max?: number;
};

export type ReadoutSeries = {
  label?: string;
  field: string;
};

export type ReadoutSection = {
  kind: "stats" | "table" | "chart";
  title: string;
  source?: string;
  sort?: { field: string; desc?: boolean };
  items?: ReadoutStat[];
  columns?: ReadoutColumn[];
  /** chart: numeric fields of `source`, plotted over the last `points` polls */
  series?: ReadoutSeries[];
  points?: number;
  min?: number;
  max?: number;
};

export type ReadoutSpec = {
  refresh_ms?: number;
  sources: ReadoutSource[];
  sections: ReadoutSection[];
};

export type ReadoutPackage = {
  nhapp: number;
  kind: "readout";
  manifest: Record<string, unknown>;
  readout: ReadoutSpec;
};

/**
 * Commands a readout is permitted to poll. Enforced again here, not only in
 * the library's CI: a package can arrive from a hand-edited catalog, and
 * nothing that renders in an operator's browser should be able to write to a
 * device.
 */
export const READOUT_ALLOWED_SOURCES = new Set([
  "task_list", "service_list", "app_list", "app_list_packages", "app_events",
  "memory_status", "scan_health", "storage_status", "status", "capabilities",
  // Firmware v1.6.0: the latest IMU, magnetometer and fuel-gauge readings.
  "sensor_sample",
]);

export const MIN_REFRESH_MS = 500;
export const MAX_REFRESH_MS = 60000;
export const MAX_CHART_SERIES = 4;
export const DEFAULT_CHART_POINTS = 60;
export const MIN_CHART_POINTS = 10;
export const MAX_CHART_POINTS = 600;

export function isReadoutPackage(doc: unknown): doc is ReadoutPackage {
  const record = doc as Record<string, unknown> | null;
  return Boolean(record && record.kind === "readout" && record.readout);
}

/** Returns the reason a readout is unsafe to render, or null when it is fine. */
export function readoutRejectionReason(doc: unknown): string | null {
  if (!isReadoutPackage(doc)) return "not_a_readout";
  const spec = doc.readout;
  if (!Array.isArray(spec.sources) || !spec.sources.length) return "missing_sources";
  if (!Array.isArray(spec.sections) || !spec.sections.length) return "missing_sections";
  for (const source of spec.sources) {
    if (!READOUT_ALLOWED_SOURCES.has(source.command)) {
      return `readout_source_not_allowed:${source.command}`;
    }
  }
  return null;
}

export function refreshInterval(spec: ReadoutSpec): number {
  const raw = Number(spec.refresh_ms ?? 1000);
  if (!Number.isFinite(raw)) return 1000;
  return Math.min(Math.max(raw, MIN_REFRESH_MS), MAX_REFRESH_MS);
}

function toNumber(value: unknown): number | null {
  const parsed = typeof value === "number" ? value : Number.parseFloat(String(value ?? ""));
  return Number.isFinite(parsed) ? parsed : null;
}

/** Render one value. Never computes a figure the device did not report. */
export function formatValue(value: unknown, format: ReadoutFormat = "raw"): string {
  if (value === undefined || value === null) return "—";
  switch (format) {
    case "bool":
      return value === true || value === "true" ? "✓" : "—";
    case "text":
      return String(value);
    case "permille": {
      const n = toNumber(value);
      return n === null ? String(value) : `${(n / 10).toFixed(1)}%`;
    }
    case "percent": {
      const n = toNumber(value);
      return n === null ? String(value) : `${Math.round(n * 100)}%`;
    }
    case "micros": {
      const n = toNumber(value);
      if (n === null) return String(value);
      if (n >= 1000) return `${(n / 1000).toFixed(2)} ms`;
      return `${Math.round(n)} µs`;
    }
    case "bytes": {
      const n = toNumber(value);
      if (n === null) return String(value);
      if (n >= 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
      if (n >= 1024) return `${(n / 1024).toFixed(1)} KB`;
      return `${n} B`;
    }
    case "int": {
      const n = toNumber(value);
      return n === null ? String(value) : Math.round(n).toLocaleString();
    }
    case "raw":
    default:
      return String(value);
  }
}

/** Numeric value behind a cell, for sorting and bar widths. */
export function numericValue(value: unknown): number | null {
  return toNumber(value);
}

type Row = Record<string, unknown>;

/** Pull a source's payload out of a command result. */
export function extractSource(
  result: Record<string, unknown> | null,
  source: ReadoutSource,
): Row | Row[] {
  const data = (result?.data ?? result ?? {}) as Record<string, unknown>;
  if (!source.path) return data;
  const picked = data[source.path];
  if (Array.isArray(picked)) return picked as Row[];
  // An object under the path is one row -- sensor_sample's imu/mag/battery.
  if (picked && typeof picked === "object") return picked as Row;
  return [];
}

/** How many polls a chart keeps, clamped to what the format allows. */
export function chartPoints(section: ReadoutSection): number {
  const raw = Number(section.points ?? DEFAULT_CHART_POINTS);
  if (!Number.isFinite(raw)) return DEFAULT_CHART_POINTS;
  return Math.min(Math.max(Math.round(raw), MIN_CHART_POINTS), MAX_CHART_POINTS);
}

/**
 * One poll's values for a chart's series: a number per series, or null where
 * the field is missing or not a number, so a gap is drawn as a gap rather
 * than as a zero the device never reported.
 */
export function chartSample(section: ReadoutSection, source: Row | Row[] | undefined): (number | null)[] {
  const row = Array.isArray(source) ? source[0] : source;
  return (section.series ?? []).slice(0, MAX_CHART_SERIES).map((line) => numericValue(row?.[line.field]));
}

/** Append a poll and keep only the last `points`. */
export function pushChartHistory(history: (number | null)[][], sample: (number | null)[], points: number) {
  const next = [...history, sample];
  return next.length > points ? next.slice(next.length - points) : next;
}

/** The y range to draw: the section's fixed bounds, or the data's (never zero-height). */
export function chartRange(section: ReadoutSection, history: (number | null)[][]): { min: number; max: number } {
  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;
  for (const sample of history) {
    for (const value of sample) {
      if (value === null) continue;
      if (value < min) min = value;
      if (value > max) max = value;
    }
  }
  if (typeof section.min === "number") min = section.min;
  if (typeof section.max === "number") max = section.max;
  if (!Number.isFinite(min) || !Number.isFinite(max)) return { min: 0, max: 1 };
  if (max - min < 1e-9) return { min: min - 1, max: max + 1 };
  return { min, max };
}

export function sortRows(rows: Row[], sort?: ReadoutSection["sort"]): Row[] {
  if (!sort?.field) return rows;
  const copy = [...rows];
  copy.sort((a, b) => {
    const left = numericValue(a[sort.field]);
    const right = numericValue(b[sort.field]);
    if (left !== null && right !== null) return sort.desc ? right - left : left - right;
    const ls = String(a[sort.field] ?? "");
    const rs = String(b[sort.field] ?? "");
    return sort.desc ? rs.localeCompare(ls) : ls.localeCompare(rs);
  });
  return copy;
}
