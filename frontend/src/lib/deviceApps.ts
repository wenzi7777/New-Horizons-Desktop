/**
 * Reading the device's app state.
 *
 * Shapes follow AppManager::statusJson() and AppRegistry::statusJson(); the
 * parsers are tolerant because the same UI has to cope with a v1.0.0 device
 * (which has neither a registry nor slots) and a mock.
 */

export type AppStateToken = "running" | "installed" | "killed" | "suspended" | "faulted" | "unknown";

export type InstalledApp = {
  name: string;
  version: string;
  state: AppStateToken;
  capabilities: number;
  budgetUs: number;
  lastUs: number;
  maxUs: number;
  overruns: number;
  events: number;
  /** Package bound to this slot, if any. */
  packageId: string;
  graph: string;
  nodes: number;
  estimatedUs: number;
  degraded: boolean;
};

export type AppPackageEntry = {
  id: string;
  /** "flow" runs on the device; "readout" is a view the Desktop renders. */
  kind: "flow" | "readout" | string;
  name: string;
  version: string;
  author: string;
  summary: string;
  category: string;
  minOs: string;
  sha256: string;
  size: number;
  estimatedUs: number;
  slot: number;
  state: "active" | "installed" | "load_failed" | string;
};

export type AppEventEntry = {
  seq: number;
  ms: number;
  frameSeq: number;
  app: string;
  event: string;
  detail: string;
  value?: number;
};

export type AppEventPage = {
  seq: number;
  /** Events overwritten before anyone read them. Shown, never hidden. */
  dropped: number;
  events: AppEventEntry[];
};

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function num(value: unknown, fallback = 0): number {
  const parsed = typeof value === "number" ? value : Number.parseFloat(String(value ?? ""));
  return Number.isFinite(parsed) ? parsed : fallback;
}

function str(value: unknown, fallback = ""): string {
  return value === undefined || value === null ? fallback : String(value);
}

const KNOWN_STATES: readonly string[] = [
  "running", "installed", "killed", "suspended", "faulted",
];

export function appStateToken(raw: unknown): AppStateToken {
  const token = str(raw).toLowerCase();
  return KNOWN_STATES.includes(token) ? (token as AppStateToken) : "unknown";
}

/** A killed app needs an operator; a suspended one comes back by itself. */
export function needsRevive(app: InstalledApp): boolean {
  return app.state === "killed";
}

export function parseAppList(result: Record<string, unknown> | null): InstalledApp[] {
  const data = asRecord(asRecord(result).data);
  const raw = data.apps ?? asRecord(result).apps;
  if (!Array.isArray(raw)) return [];
  return raw.map((item) => {
    const entry = asRecord(item);
    const detail = asRecord(entry.state_detail);
    return {
      name: str(entry.name),
      version: str(entry.version, "0.0.0"),
      state: appStateToken(entry.state),
      capabilities: num(entry.capabilities),
      budgetUs: num(entry.budget_us),
      lastUs: num(entry.last_us),
      maxUs: num(entry.max_us),
      overruns: num(entry.overruns),
      events: num(entry.events),
      packageId: str(detail.package),
      graph: str(detail.graph),
      nodes: num(detail.nodes),
      estimatedUs: num(detail.estimated_us),
      degraded: detail.degraded === true,
    };
  });
}

export function parsePackageList(result: Record<string, unknown> | null): AppPackageEntry[] {
  const data = asRecord(asRecord(result).data);
  const raw = data.packages ?? asRecord(asRecord(data).registry).packages;
  if (!Array.isArray(raw)) return [];
  return raw.map((item) => {
    const entry = asRecord(item);
    return {
      id: str(entry.id),
      kind: str(entry.kind, "flow"),
      name: str(entry.name, str(entry.id)),
      version: str(entry.version, "0.0.0"),
      author: str(entry.author),
      summary: str(entry.summary),
      category: str(entry.category, "other"),
      minOs: str(entry.min_os, "v1.0.0"),
      sha256: str(entry.sha256),
      size: num(entry.size),
      estimatedUs: num(entry.estimated_us),
      slot: num(entry.slot, -1),
      state: str(entry.state, "installed"),
    };
  });
}

export function parseAppEvents(result: Record<string, unknown> | null): AppEventPage {
  const data = asRecord(asRecord(result).data);
  const raw = Array.isArray(data.events) ? data.events : [];
  return {
    seq: num(data.seq),
    dropped: num(data.dropped),
    events: raw.map((item) => {
      const entry = asRecord(item);
      const page: AppEventEntry = {
        seq: num(entry.seq),
        ms: num(entry.ms),
        frameSeq: num(entry.frame_seq),
        app: str(entry.app),
        event: str(entry.event),
        detail: str(entry.detail),
      };
      if (entry.value !== undefined) page.value = num(entry.value);
      return page;
    }),
  };
}

/** Percentage of its current allocation an app used on its last call. */
export function budgetPercent(app: InstalledApp): number {
  if (!app.budgetUs) return 0;
  return Math.round((app.lastUs / app.budgetUs) * 100);
}

/** Free slots, given the slot hosts and what is bound to them. */
export function freeSlots(apps: InstalledApp[], packages: AppPackageEntry[]): number[] {
  const taken = new Set(packages.filter((p) => p.slot >= 0).map((p) => p.slot));
  return apps.map((_, index) => index).filter((index) => !taken.has(index));
}

/**
 * Device error strings this UI can explain. Anything else is shown verbatim
 * rather than swallowed -- an unrecognised code is still information.
 */
export const APP_ERROR_KEYS: Record<string, string> = {
  no_free_slot: "appError_no_free_slot",
  slot_occupied: "appError_slot_occupied",
  already_installed: "appError_already_installed",
  already_active: "appError_already_active",
  registry_full: "appError_registry_full",
  unknown_package: "appError_unknown_package",
  package_not_found: "appError_package_not_found",
  package_too_large: "appError_package_too_large",
  checksum_mismatch: "appError_checksum_mismatch",
  file_checksum_mismatch: "appError_checksum_mismatch",
  os_too_old: "appError_os_too_old",
  id_path_mismatch: "appError_id_path_mismatch",
  maintenance_required: "appError_maintenance_required",
  app_state_change_rejected: "appError_state_change_rejected",
  index_write_failed: "appError_index_write_failed",
  graph_invalid: "appError_graph_invalid",
  path_too_long: "appError_path_too_long",
};

/** Device errors are `code` or `code:detail`; match on the code alone. */
export function appErrorKey(raw: string): string | null {
  const code = String(raw || "").split(":")[0];
  return APP_ERROR_KEYS[code] ?? null;
}
