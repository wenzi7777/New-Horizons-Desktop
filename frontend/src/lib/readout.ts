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

export type ReadoutSection = {
  kind: "stats" | "table";
  title: string;
  source?: string;
  sort?: { field: string; desc?: boolean };
  items?: ReadoutStat[];
  columns?: ReadoutColumn[];
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
]);

export const MIN_REFRESH_MS = 500;
export const MAX_REFRESH_MS = 60000;

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
  return Array.isArray(picked) ? (picked as Row[]) : [];
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
