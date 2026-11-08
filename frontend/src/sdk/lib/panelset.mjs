// @ts-check
/**
 * What a panel package may declare.
 *
 * A panel is a readout that can also ACT: a table row can carry a "..." menu,
 * a page can have tabs, and a Run box can start something that is stopped.
 * Every readout is a valid panel with no actions; `kind: "readout"` packages
 * keep working unchanged.
 *
 * The safety rule is the readout's, extended rather than relaxed:
 *
 * - It stays DECLARATIVE. A panel names commands, argument templates and
 *   widgets; it carries no code, and an argument is a constant, a field of the
 *   row it was invoked on, or a value the operator typed -- never an
 *   expression. Values are data and never become code.
 * - What it may SEND is fixed by the permissions its manifest declares. Each
 *   permission maps to a short, fixed list of commands below. A panel cannot
 *   name a command outside the permissions it declared, and some commands are
 *   off limits whatever it declares.
 * - What it may POLL is exactly what a readout may poll.
 *
 * This table is the one definition; the firmware does not read panels, but
 * the Desktop's renderer and backend gate mirror it and are tested against it.
 */

import { ALLOWED_SOURCES as READOUT_SOURCES } from "./readoutset.mjs";

/**
 * Permission -> the commands it unlocks. All of them act on this boot only:
 * nothing a panel can send is persisted, so a reboot undoes it.
 */
export const PERMISSIONS = Object.freeze({
  task_control: Object.freeze(["task_stop", "task_start", "task_set_period"]),
  service_control: Object.freeze(["service_stop", "service_start", "service_restart"]),
  app_control: Object.freeze(["app_stop", "app_start", "app_revive"]),
});

/** Every command any permission unlocks. */
export const ACTION_COMMANDS = Object.freeze(new Set(Object.values(PERMISSIONS).flat()));

/**
 * Commands a panel may never send, whatever it declares: anything that writes
 * configuration or files, reboots, or changes what is installed. The list in
 * PERMISSIONS already excludes them; this is the second lock, so that widening
 * a permission by mistake still cannot let one through.
 */
export const FORBIDDEN_COMMAND_PREFIXES = Object.freeze(["set_", "file_write", "file_delete", "reboot"]);
export const FORBIDDEN_COMMANDS = Object.freeze(new Set([
  "app_install",
  "app_uninstall",
  "app_activate",
  "app_enable",
  "app_disable",
  "config_set",
  "enter_maintenance",
  "exit_maintenance",
  "factory_reset",
  "ota_update",
]));

/** @param {string} command */
export function isForbiddenCommand(command) {
  return FORBIDDEN_COMMANDS.has(command) || FORBIDDEN_COMMAND_PREFIXES.some((prefix) => command.startsWith(prefix));
}

/** Read-only commands a panel may poll: the same list a readout has. */
export const ALLOWED_SOURCES = READOUT_SOURCES;

/** A readout's widgets, plus tabs (pages of sections) and run (the Run box). */
export const SECTION_KINDS = Object.freeze(new Set(["stats", "table", "chart", "tabs", "run"]));

/** Section kinds a tab may hold: no tabs inside tabs. */
export const TAB_SECTION_KINDS = Object.freeze(new Set(["stats", "table", "chart", "run"]));

/** What the operator is asked for when an action takes input. */
export const INPUT_KINDS = Object.freeze(new Set(["number", "text"]));

/**
 * An argument value is a constant (string, number, boolean) or exactly one of
 * these templates. Nothing is computed: `$row.period_us` is the value of that
 * field, `$input.period_us` is what the operator typed.
 */
export const TEMPLATE_RE = /^\$(row|input)\.([a-z_][a-z0-9_]*)$/;

/**
 * A field a panel reads. Panels may reach into nested results with a dotted
 * path (`cpu.cores`, `cores.0.busy_permille`): each step is an object key or
 * an array index, nothing more.
 */
export const FIELD_PATH_RE = /^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z0-9_]+)*$/;

/** The first firmware that stores a `kind: "panel"` package (older ones refuse it as unsupported_kind). */
export const PANEL_MIN_OS = "v1.19.0";

export const MAX_ACTIONS = 16;
export const MAX_TABS = 8;
export const MAX_ROW_ACTIONS = 8;
export const MAX_RUN_CANDIDATES = 8;
export const MAX_ARGS = 8;
export const MAX_CONDITIONS = 4;
export const MAX_ARG_TEXT = 64;
export const MAX_LABEL = 48;
export const MAX_CONFIRM_TEXT = 200;
export const MAX_INPUT_TEXT = 64;
