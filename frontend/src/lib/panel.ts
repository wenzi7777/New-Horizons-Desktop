/**
 * Interpreting a panel package -- a readout that may also act.
 *
 * A panel is a readout plus `actions`: buttons, row menus and a Run box that
 * send device commands. It still carries no code. What it may send is fixed by
 * the `permissions` its manifest declares, each of which names a fixed list of
 * commands (PANEL_PERMISSIONS, the same table as the App Library's
 * panelset.mjs and the backend's app_library.py). An action's arguments are
 * constants or a field of the row / the operator's input, copied verbatim --
 * never evaluated -- so a package can choose *which* stopped task to start,
 * not *what* gets sent.
 *
 * This is the third gate (after the library's CI and the backend's
 * validate_package); the device enforces its own protections on top, which is
 * the real security boundary. A readout package is a panel without actions,
 * and is rendered by the same view.
 */

import {
  READOUT_ALLOWED_SOURCES,
  type ReadoutSection,
  type ReadoutSource,
  type ReadoutSpec,
  extractSource,
  fieldValue,
  formatValue,
  refreshInterval,
  sortRows,
} from "./readout";

export { extractSource, fieldValue, formatValue, refreshInterval, sortRows };

type Row = Record<string, unknown>;

/** Permission -> the only commands it allows. Keep in step with panelset.mjs and app_library.py. */
export const PANEL_PERMISSIONS: Readonly<Record<string, readonly string[]>> = {
  task_control: ["task_stop", "task_start", "task_set_period"],
  service_control: ["service_stop", "service_start", "service_restart"],
  app_control: ["app_stop", "app_start", "app_revive"],
};

/**
 * Never sendable from a panel, whatever it declares: persistent settings,
 * file writes, reboots and package management. The permission table already
 * excludes them; this is the belt to its braces, so a future permission that
 * listed one by mistake still could not send it.
 */
export const PANEL_FORBIDDEN_PREFIXES = ["set_", "file_write", "file_delete", "reboot", "calibration_"] as const;
export const PANEL_FORBIDDEN_COMMANDS = new Set([
  "file_delete", "app_install", "app_uninstall", "app_activate", "app_deactivate",
  "app_enable", "app_disable", "app_load_flow", "app_unload_flow", "app_reindex",
  "enter_maintenance", "exit_maintenance", "apply_update", "check_update",
  "config_set", "power_set_state", "resync_battery_gauge", "factory_reset", "ota_update",
]);

export const MAX_PANEL_ACTIONS = 16;
export const MAX_PANEL_TABS = 8;
export const PANEL_SECTION_KINDS = new Set(["stats", "table", "chart", "tabs", "run"]);

/** `$row.<field>` or `$input.<field>`: the only non-constant argument there is. */
const TEMPLATE_RE = /^\$(row|input)\.([A-Za-z_][A-Za-z0-9_]*)$/;
const ROW_TEMPLATE_RE = /^\$row\.[A-Za-z_][A-Za-z0-9_]*$/;

export type PanelCondition = {
  field: string;
  eq?: unknown;
  ne?: unknown;
};

export type PanelInput = {
  field: string;
  kind?: "number" | "text";
  label?: string;
  min?: number;
  max?: number;
  /** A constant or `$row.<field>`. */
  default?: unknown;
  unit?: string;
};

export type PanelConfirm = {
  title?: string;
  /** `{field}` is replaced with that row field's text; nothing else is interpreted. */
  message?: string;
  destructive?: boolean;
};

/** One condition, or a list: `when` needs all of them, `hidden_when` any. */
export type PanelConditions = PanelCondition | PanelCondition[];

export type PanelAction = {
  id: string;
  label: string;
  command: string;
  args?: Record<string, unknown>;
  when?: PanelConditions;
  hidden_when?: PanelConditions;
  confirm?: PanelConfirm;
  input?: PanelInput;
};

export type PanelRunCandidate = {
  source: string;
  field: string;
  action: string;
};

export type PanelTab = {
  title: string;
  sections: PanelSection[];
};

export type PanelSection = Omit<ReadoutSection, "kind"> & {
  kind: ReadoutSection["kind"] | "tabs" | "run";
  row_actions?: string[];
  tabs?: PanelTab[];
  candidates?: PanelRunCandidate[];
  placeholder?: string;
};

export type PanelSpec = Omit<ReadoutSpec, "sections"> & {
  sources: ReadoutSource[];
  actions?: PanelAction[];
  sections: PanelSection[];
};

export type PanelPackage = {
  nhapp: number;
  kind: "panel";
  manifest: Record<string, unknown> & { permissions?: string[] };
  panel: PanelSpec;
};

/** What the view draws: a panel, or a readout seen as a panel with no actions. */
export type PanelModel = {
  kind: "panel" | "readout";
  spec: PanelSpec;
  permissions: string[];
};

export function isPanelPackage(doc: unknown): doc is PanelPackage {
  const record = doc as Record<string, unknown> | null;
  return Boolean(record && record.kind === "panel" && record.panel);
}

/** A package the panel view can draw: a panel, or a readout. */
export function isViewablePackage(doc: unknown): boolean {
  const record = doc as Record<string, unknown> | null;
  return Boolean(record && ((record.kind === "panel" && record.panel) || (record.kind === "readout" && record.readout)));
}

export function panelModel(doc: unknown): PanelModel | null {
  const record = doc as Record<string, unknown> | null;
  if (!record) return null;
  if (record.kind === "panel" && record.panel && typeof record.panel === "object") {
    const manifest = (record.manifest ?? {}) as Record<string, unknown>;
    const permissions = Array.isArray(manifest.permissions) ? manifest.permissions.map(String) : [];
    return { kind: "panel", spec: record.panel as PanelSpec, permissions };
  }
  if (record.kind === "readout" && record.readout && typeof record.readout === "object") {
    return { kind: "readout", spec: record.readout as PanelSpec, permissions: [] };
  }
  return null;
}

export function isForbiddenCommand(command: string): boolean {
  return PANEL_FORBIDDEN_COMMANDS.has(command) || PANEL_FORBIDDEN_PREFIXES.some((prefix) => command.startsWith(prefix));
}

/** Every command the declared permissions allow. Unknown permissions allow nothing. */
export function permittedCommands(permissions: readonly string[]): Set<string> {
  const allowed = new Set<string>();
  for (const permission of permissions) {
    for (const command of PANEL_PERMISSIONS[permission] ?? []) {
      if (!isForbiddenCommand(command)) allowed.add(command);
    }
  }
  return allowed;
}

function isConstant(value: unknown): boolean {
  if (value === null || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  // A string that looks like a template must BE one; "$" never means anything else.
  if (typeof value === "string") return !value.startsWith("$");
  return false;
}

/** The reason an argument template is refused, or null when it is a constant, `$row.x` or `$input.x`. */
export function templateRejection(value: unknown, input?: PanelInput): string | null {
  if (typeof value === "string" && value.startsWith("$")) {
    const match = TEMPLATE_RE.exec(value);
    if (!match) return "invalid_arg_template";
    if (match[1] === "input" && (!input || input.field !== match[2])) return "input_not_declared";
    return null;
  }
  return isConstant(value) ? null : "invalid_arg_template";
}

function sectionsOf(sections: PanelSection[], depth = 0): { section: PanelSection; depth: number }[] {
  const all: { section: PanelSection; depth: number }[] = [];
  for (const section of sections) {
    all.push({ section, depth });
    if (section.kind === "tabs") {
      for (const tab of section.tabs ?? []) all.push(...sectionsOf(tab.sections ?? [], depth + 1));
    }
  }
  return all;
}

/** Returns the reason a panel (or readout) is unsafe to render, or null when it is fine. */
const MAX_CONDITIONS = 4;

/** One condition or a list of up to 4; each exactly `{field, eq}` or `{field, ne}` against a constant. */
function validConditions(value: unknown): boolean {
  const list = Array.isArray(value) ? value : [value];
  if (!list.length || list.length > MAX_CONDITIONS) return false;
  return list.every((condition) => {
    if (!condition || typeof condition !== "object" || Array.isArray(condition)) return false;
    const record = condition as Record<string, unknown>;
    if (typeof record.field !== "string" || !record.field) return false;
    const ops = ["eq", "ne"].filter((op) => op in record);
    return ops.length === 1 && isConstant(record[ops[0]]) && Object.keys(record).length === 2;
  });
}

export function panelRejectionReason(doc: unknown): string | null {
  const model = panelModel(doc);
  if (!model) return "not_a_panel";
  const { spec, permissions } = model;
  if (!Array.isArray(spec.sources) || !spec.sources.length) return "missing_sources";
  if (!Array.isArray(spec.sections) || !spec.sections.length) return "missing_sections";
  const sourceIds = new Set<string>();
  for (const source of spec.sources) {
    if (!READOUT_ALLOWED_SOURCES.has(source.command)) return `readout_source_not_allowed:${source.command}`;
    sourceIds.add(source.id);
  }

  for (const permission of permissions) {
    if (!(permission in PANEL_PERMISSIONS)) return `unknown_permission:${permission}`;
  }
  const actions = spec.actions ?? [];
  if (!Array.isArray(actions)) return "invalid_actions";
  if (model.kind === "readout" && actions.length) return "readout_must_not_declare_actions";
  if (actions.length > MAX_PANEL_ACTIONS) return "too_many_actions";
  const allowed = permittedCommands(permissions);
  const actionIds = new Set<string>();
  for (const action of actions) {
    if (!action || typeof action.id !== "string" || !action.id) return "invalid_action";
    if (actionIds.has(action.id)) return `duplicate_action:${action.id}`;
    actionIds.add(action.id);
    if (isForbiddenCommand(action.command) || !allowed.has(action.command)) {
      return `panel_action_not_permitted:${action.command}`;
    }
    const args = action.args ?? {};
    if (typeof args !== "object" || Array.isArray(args)) return `invalid_arg_template:${action.id}`;
    for (const [key, value] of Object.entries(args)) {
      // "command" is the action's own; an argument may not smuggle in another.
      if (key === "command" || key === "request_id") return `invalid_arg_name:${key}`;
      const rejection = templateRejection(value, action.input);
      if (rejection) return `${rejection}:${action.id}.${key}`;
    }
    for (const key of ["when", "hidden_when"] as const) {
      const conditions = action[key];
      if (conditions === undefined) continue;
      if (!validConditions(conditions)) return `invalid_${key}:${action.id}`;
    }
    if (action.input) {
      if (typeof action.input.field !== "string" || !action.input.field) return `invalid_input:${action.id}`;
      const def = action.input.default;
      if (def !== undefined && !isConstant(def) && !(typeof def === "string" && ROW_TEMPLATE_RE.test(def))) {
        return `invalid_arg_template:${action.id}.input`;
      }
    }
  }

  const tabSections = spec.sections.filter((section) => section.kind === "tabs");
  for (const { section, depth } of sectionsOf(spec.sections)) {
    if (!PANEL_SECTION_KINDS.has(section.kind)) return `unknown_section_kind:${section.kind}`;
    if (model.kind === "readout" && !["stats", "table", "chart"].includes(section.kind)) {
      return `unknown_section_kind:${section.kind}`;
    }
    if (section.kind === "tabs") {
      if (depth > 0) return "nested_tabs";
      if (!Array.isArray(section.tabs) || !section.tabs.length) return "missing_tabs";
      if (section.tabs.length > MAX_PANEL_TABS) return "too_many_tabs";
    }
    for (const id of section.row_actions ?? []) {
      if (!actionIds.has(id)) return `unknown_action:${id}`;
    }
    if (section.kind === "run") {
      if (!Array.isArray(section.candidates) || !section.candidates.length) return "missing_candidates";
      for (const candidate of section.candidates) {
        if (!actionIds.has(candidate.action)) return `unknown_action:${candidate.action}`;
        if (!sourceIds.has(candidate.source)) return `unknown_source:${candidate.source}`;
      }
    }
  }
  if (tabSections.length > 1) return "too_many_tab_sets";
  return null;
}

/**
 * Whether a row satisfies a condition -- the SDK's rule (panelset.conditionHolds,
 * tested against its CONDITION_CASES): exactly `eq` or `ne` against a constant,
 * compared as text; a missing or null field satisfies nothing, `ne` included.
 */
export function conditionMatches(condition: PanelCondition | undefined, row: Row | undefined): boolean {
  if (!condition || typeof condition !== "object" || typeof condition.field !== "string") return false;
  const value = fieldValue(row, condition.field);
  if (value === undefined || value === null) return false;
  if ("eq" in condition) return String(value) === String(condition.eq);
  if ("ne" in condition) return String(value) !== String(condition.ne);
  return false;
}

/** Enabled for this row: every `when` condition holds. (Hidden is separate: see actionHidden.) */
export function actionEnabled(when: PanelConditions | undefined, row: Row | undefined): boolean {
  if (when === undefined || when === null) return true;
  const list = Array.isArray(when) ? when : [when];
  return list.every((condition) => conditionMatches(condition, row));
}

/** Not offered for this row at all -- a protected task, say: any `hidden_when` condition holds. */
export function actionHidden(action: PanelAction, row: Row | undefined): boolean {
  if (action.hidden_when === undefined || action.hidden_when === null) return false;
  const list = Array.isArray(action.hidden_when) ? action.hidden_when : [action.hidden_when];
  return list.some((condition) => conditionMatches(condition, row));
}

/**
 * The arguments to send: constants verbatim, `$row.x` / `$input.x` looked up.
 * Returns null when a referenced value is missing -- an action is never sent
 * with a hole in it. Never evaluates anything.
 */
export function resolveArgs(
  template: Record<string, unknown> | undefined,
  row: Row | undefined,
  input: Row | undefined,
): Record<string, unknown> | null {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(template ?? {})) {
    if (key === "command" || key === "request_id") return null;
    if (typeof value === "string" && value.startsWith("$")) {
      const match = TEMPLATE_RE.exec(value);
      if (!match) return null;
      const scope = match[1] === "row" ? row : input;
      // Own fields only: "$row.constructor" is not a field of the row.
      const picked = fieldValue(scope, match[2]);
      if (picked === undefined || picked === null || typeof picked === "object") return null;
      out[key] = picked;
    } else if (isConstant(value)) {
      out[key] = value;
    } else {
      return null;
    }
  }
  return out;
}

/** The input's starting value: a constant, or a field of the row. */
export function inputDefault(input: PanelInput, row: Row | undefined): string {
  const def = input.default;
  if (typeof def === "string" && ROW_TEMPLATE_RE.test(def)) {
    const value = fieldValue(row, def.slice(5));
    return value === undefined || value === null ? "" : String(value);
  }
  return def === undefined || def === null ? "" : String(def);
}

/** Parse and range-check the operator's input. Returns the value, or an error key. */
export function parseInput(input: PanelInput, raw: string): { value: unknown } | { error: string } {
  const text = raw.trim();
  if (input.kind === "text") {
    if (!text) return { error: "panelInputRequired" };
    return { value: text };
  }
  if (!text) return { error: "panelInputRequired" };
  const value = Number(text);
  if (!Number.isFinite(value)) return { error: "panelInputNotNumber" };
  if (typeof input.min === "number" && value < input.min) return { error: "panelInputOutOfRange" };
  if (typeof input.max === "number" && value > input.max) return { error: "panelInputOutOfRange" };
  return { value: Math.round(value) };
}

/** `{field}` -> the row's value as text. Only substitution; braces around anything else stay as typed. */
export function fillMessage(text: string | undefined, row: Row | undefined): string {
  if (!text) return "";
  return text.replace(/\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (whole, field: string) => {
    const value = fieldValue(row, field);
    return value === undefined || value === null || typeof value === "object" ? whole : String(value);
  });
}

export type RunEntry = {
  label: string;
  action: PanelAction;
  row: Row;
  source: string;
};

/**
 * What the Run box can start right now: for each candidate, the rows of its
 * source for which its action is enabled and not hidden -- with a start
 * action whose `when` is "state == stopped", the stopped tasks, services and
 * apps. Only declared actions; the Run box is not a command line.
 */
export function runEntries(
  section: PanelSection,
  actions: Map<string, PanelAction>,
  data: Record<string, Row | Row[]>,
): RunEntry[] {
  const entries: RunEntry[] = [];
  const seen = new Set<string>();
  for (const candidate of section.candidates ?? []) {
    const action = actions.get(candidate.action);
    const source = data[candidate.source];
    if (!action || !Array.isArray(source)) continue;
    for (const row of source) {
      const label = fieldValue(row, candidate.field);
      if (label === undefined || label === null || typeof label === "object") continue;
      if (!actionEnabled(action.when, row) || actionHidden(action, row)) continue;
      const key = `${action.id}:${String(label)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      entries.push({ label: String(label), action, row, source: candidate.source });
    }
  }
  return entries;
}

/** Rank Run entries for what has been typed: prefix matches first, then substring. */
export function filterRunEntries(entries: RunEntry[], typed: string): RunEntry[] {
  const query = typed.trim().toLowerCase();
  if (!query) return entries;
  const prefix = entries.filter((entry) => entry.label.toLowerCase().startsWith(query));
  const inner = entries.filter((entry) => !entry.label.toLowerCase().startsWith(query) && entry.label.toLowerCase().includes(query));
  return [...prefix, ...inner];
}

/**
 * Hide actions whose command the device does not list in its `commands`
 * catalog (older firmware). Without a catalog nothing is hidden: the device
 * answers unknown_command itself, which is shown as such.
 */
export function supportedActions(actions: PanelAction[], catalog: ReadonlySet<string> | null): PanelAction[] {
  if (!catalog) return actions;
  return actions.filter((action) => catalog.has(action.command));
}

/** Device error code -> i18n key, for the codes the panel commands answer with. */
export const PANEL_ERROR_CODES = [
  "task_protected", "service_protected", "unknown_task", "unknown_service", "unknown_app",
  "period_out_of_range", "already_stopped", "already_running", "unknown_command",
  "maintenance_required", "command_delivery_timeout",
  // Firmware v1.19.0's other answers to the same commands.
  "period_fixed", "app_not_running", "app_not_stopped", "service_start_failed", "app_start_failed",
  "period_required", "service_not_restartable",
] as const;

export function panelErrorKey(raw: string): string | null {
  const code = raw.trim();
  return (PANEL_ERROR_CODES as readonly string[]).includes(code) ? `panelError_${code}` : null;
}

/**
 * A one-at-a-time lock for everything a panel sends. A Hub relays one command
 * per device at a time, so polls and actions must never overlap: a poll pass
 * is skipped while anything holds the lock, and an action waits for the poll
 * in flight to finish rather than being dropped.
 */
export function createCommandLock() {
  let current: Promise<unknown> | null = null;
  return {
    get busy() {
      return current !== null;
    },
    /** Run now, or return null without running if the lock is held. */
    async tryRun<T>(task: () => Promise<T>): Promise<T | null> {
      if (current) return null;
      return this.run(task);
    },
    /** Wait for the lock, then run. */
    async run<T>(task: () => Promise<T>): Promise<T> {
      while (current) await current.catch(() => undefined);
      const pending = task();
      current = pending;
      try {
        return await pending;
      } finally {
        if (current === pending) current = null;
      }
    },
  };
}

export type CommandLock = ReturnType<typeof createCommandLock>;
