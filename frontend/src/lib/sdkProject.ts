// The SDK page's projects: what an author is editing, where it came from, and
// how it leaves the page.
//
// Drafts live in this browser's localStorage. That is a convenience, not a
// store: it can be empty (private window, cleared site data) or refuse writes,
// so every access is guarded and the page works without it. What an author
// means to keep leaves through export -- a source file and a package, the same
// files the App Library takes in a pull request.

import { MAX_SLOTS, appShareUs, type Analysis } from "../sdk/lib/index.mjs";

export type SdkKind = "flow" | "readout";

export type SdkProject = {
  id: string;
  kind: SdkKind;
  source: string;
  /** Set when the project was opened from the App Library. */
  origin?: { appId: string; version: string; packageSha256?: string };
  updatedAt: number;
};

/**
 * A board an app can run on, as the firmware builds it: BoardConfig.h is the
 * source of these numbers -- keep the two in step when a board is added.
 * rows x cols is the largest matrix the board scans; a device may be set to
 * scan fewer (set_matrix_layout).
 */
export type BoardSpec = {
  id: string;
  hardwareModel: string;
  name: string;
  rows: number;
  cols: number;
  oled: boolean;
  button: boolean;
  /** External LEDs on the board's header; 0 where there are none. */
  externalLeds: number;
};

/** Largest first: the first is what a new virtual device starts as. */
export const BOARDS: BoardSpec[] = [
  { id: "v23d", hardwareModel: "VD-CTL/R v2.3.D GCU LTS", name: "v2.3.D GCU LTS", rows: 15, cols: 15, oled: false, button: false, externalLeds: 0 },
  { id: "v10f", hardwareModel: "VD-CTL/R v1.0.F 2026.4", name: "v1.0.F", rows: 10, cols: 21, oled: true, button: true, externalLeds: 3 },
  { id: "v15f", hardwareModel: "VD-CTL/R v1.5.F 2026.7", name: "v1.5.F", rows: 14, cols: 14, oled: true, button: true, externalLeds: 9 },
  { id: "v22c", hardwareModel: "VD-CTL/R v2.2.C GCU LTS", name: "v2.2.C GCU LTS", rows: 11, cols: 13, oled: false, button: false, externalLeds: 0 },
  { id: "v21", hardwareModel: "VD-CTL/R v2.1 GCU LTS", name: "v2.1 GCU LTS", rows: 10, cols: 12, oled: false, button: false, externalLeds: 0 },
];

export function boardById(id: string | undefined): BoardSpec {
  return BOARDS.find((board) => board.id === id) ?? BOARDS[0];
}

export function boardForHardwareModel(hardwareModel: string | undefined): BoardSpec | undefined {
  return BOARDS.find((board) => board.hardwareModel === hardwareModel);
}

export type MatrixTarget = {
  rows: number;
  cols: number;
  /** "device:<uid>", or VIRTUAL_TARGET_KEY. */
  key: string;
  label: string;
  /** The device's firmware, when the target is a device. */
  firmware?: string;
  /** The board, when it is known: always for the virtual device. */
  board?: BoardSpec;
};

export const VIRTUAL_TARGET_KEY = "virtual";

/** Where a virtual device's frames come from. */
export type VirtualSource = "generated" | "recording";

export const SYNTH_PATTERNS = ["none", "tap", "hold", "swipe", "ramp"] as const;
export type SynthPattern = (typeof SYNTH_PATTERNS)[number];

/** The board a Studio author runs an app on when no real device is at hand. */
export type VirtualDevice = {
  boardId: string;
  rows: number;
  cols: number;
  source: VirtualSource;
  pattern: SynthPattern;
  /** Background noise, 0..1 of the noise ceiling. */
  noise: number;
};

export function defaultVirtualDevice(): VirtualDevice {
  const board = BOARDS[0];
  return { boardId: board.id, rows: board.rows, cols: board.cols, source: "generated", pattern: "tap", noise: 0.1 };
}

/** Shapes a virtual device may take: at least one cell, at most the board. */
export function clampShape(board: BoardSpec, rows: number, cols: number): { rows: number; cols: number } {
  const clamp = (value: number, max: number) => Math.min(max, Math.max(1, Math.trunc(Number(value) || 1)));
  return { rows: clamp(rows, board.rows), cols: clamp(cols, board.cols) };
}

export function virtualTarget(device: VirtualDevice, label: string): MatrixTarget {
  const board = boardById(device.boardId);
  return { key: VIRTUAL_TARGET_KEY, rows: device.rows, cols: device.cols, label: `${label} · ${board.name} · ${device.rows} × ${device.cols}`, board };
}

const VIRTUAL_KEY = "nhos.sdk.virtual.v1";
const TARGET_KEY = "nhos.sdk.target.v1";

export function loadVirtualDevice(): VirtualDevice {
  const fallback = defaultVirtualDevice();
  try {
    const raw = JSON.parse(window.localStorage.getItem(VIRTUAL_KEY) ?? "null");
    if (!raw || typeof raw !== "object") return fallback;
    const board = boardById(raw.boardId);
    // Rows and columns are not clamped: a recording may have set them past
    // the board's own matrix, and that is what the author last ran.
    const rows = Number.isInteger(raw.rows) && raw.rows > 0 ? raw.rows : board.rows;
    const cols = Number.isInteger(raw.cols) && raw.cols > 0 ? raw.cols : board.cols;
    return {
      boardId: board.id,
      rows,
      cols,
      source: raw.source === "recording" ? "recording" : "generated",
      pattern: SYNTH_PATTERNS.includes(raw.pattern) ? raw.pattern : fallback.pattern,
      noise: Number.isFinite(raw.noise) ? Math.min(1, Math.max(0, raw.noise)) : fallback.noise,
    };
  } catch {
    return fallback;
  }
}

export function saveVirtualDevice(device: VirtualDevice): void {
  try {
    window.localStorage.setItem(VIRTUAL_KEY, JSON.stringify(device));
  } catch {
    // Remembering is a convenience; the page works without it.
  }
}

export function loadTargetKey(): string {
  try {
    return window.localStorage.getItem(TARGET_KEY) ?? "";
  } catch {
    return "";
  }
}

export function saveTargetKey(key: string): void {
  try {
    window.localStorage.setItem(TARGET_KEY, key);
  } catch {
    // As above.
  }
}

/** "VD-CTL/R v1.5.F 2026.7" -> "v1.5.F", for a board this list does not know. */
function shortBoardName(hardwareModel: string | undefined): string | undefined {
  if (!hardwareModel || hardwareModel === "unknown") return undefined;
  const name = hardwareModel.replace(/^VD-CTL\/R\s+/, "").replace(/\s+\d{4}\.\d{1,2}$/, "").trim();
  return name || undefined;
}

const STORAGE_KEY = "nhos.sdk.projects.v1";
const ACTIVE_KEY = "nhos.sdk.active.v1";

export function flowTemplate(appId: string, author: string): string {
  return `# A flow app: a small graph the device runs on every scanned frame.
# Everything after '#' is a comment. The Reference tab lists every function.
app ${appId} {
  name    "${titleCase(appId)}"
  version 0.1.0
  author  ${safeWord(author)}
  summary "What this app does, in one line."
}

# A rectangle of cells. Rows and columns count from 0.
region front = rows 0..6, cols 0..14

signal load = sum(front)

# 'pressed' rises when load reaches 40, falls once it drops to 34 or below
# (hyst 6), and ignores changes that last less than 30 ms.
event pressed when load > 40 hyst 6 for 30ms

led green when pressed
`;
}

export function readoutTemplate(appId: string, author: string): string {
  const doc = {
    nhapp: 1,
    kind: "readout",
    manifest: {
      id: appId,
      name: titleCase(appId),
      version: "0.1.0",
      author: safeWord(author),
      summary: "What this readout shows, in one line.",
      category: "diagnostics",
      min_os: "v1.2.0",
    },
    readout: {
      refresh_ms: 1000,
      sources: [{ id: "scan", command: "scan_health" }],
      sections: [
        {
          kind: "stats",
          title: "Scanning",
          items: [
            { label: "Scan rate", source: "scan", field: "actual_scan_fps", format: "int" },
            { label: "Missed deadlines", source: "scan", field: "overrun_frames", format: "int" },
          ],
        },
      ],
    },
  };
  return `${JSON.stringify(doc, null, 2)}\n`;
}

/** @returns a name the .nhs lexer reads as one word. */
function safeWord(value: string): string {
  const word = value.trim().replace(/[^A-Za-z0-9_.-]/g, "_").replace(/^[^A-Za-z_]+/, "");
  return word || "author";
}

function titleCase(appId: string): string {
  return appId.split("_").filter(Boolean).map((part) => part[0].toUpperCase() + part.slice(1)).join(" ") || appId;
}

/** A fresh app id that no existing project uses: my_app, my_app2, ... */
export function freshAppId(projects: SdkProject[], base = "my_app"): string {
  const taken = new Set(projects.map((project) => appIdOf(project)));
  if (!taken.has(base)) return base;
  for (let n = 2; ; n += 1) {
    const candidate = `${base}${n}`.slice(0, 15);
    if (!taken.has(candidate)) return candidate;
  }
}

/** The app id a project declares, read without compiling it. */
export function appIdOf(project: Pick<SdkProject, "kind" | "source">): string {
  if (project.kind === "flow") {
    return /(?:^|\n)\s*app\s+([A-Za-z_][A-Za-z0-9_.-]*)/.exec(project.source)?.[1] ?? "";
  }
  try {
    const id = JSON.parse(project.source)?.manifest?.id;
    return typeof id === "string" ? id : "";
  } catch {
    return /"id"\s*:\s*"([^"]*)"/.exec(project.source)?.[1] ?? "";
  }
}

export function newProject(kind: SdkKind, source: string, origin?: SdkProject["origin"]): SdkProject {
  return {
    id: `p${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`,
    kind,
    source,
    origin,
    updatedAt: Date.now(),
  };
}

function isProject(value: unknown): value is SdkProject {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return typeof record.id === "string"
    && (record.kind === "flow" || record.kind === "readout")
    && typeof record.source === "string";
}

export function loadProjects(): SdkProject[] {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed.filter(isProject) : [];
  } catch {
    return [];
  }
}

/** @returns false when the browser refused the write (quota, private mode). */
export function saveProjects(projects: SdkProject[]): boolean {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(projects));
    return true;
  } catch {
    return false;
  }
}

export function loadActiveProjectId(): string | null {
  try {
    return window.localStorage.getItem(ACTIVE_KEY);
  } catch {
    return null;
  }
}

export function saveActiveProjectId(id: string): void {
  try {
    window.localStorage.setItem(ACTIVE_KEY, id);
  } catch {
    // A remembered selection is a convenience; losing it costs one click.
  }
}

/** Kind of a file an author opens, from its name and content. */
export function kindOfFile(name: string, text: string): SdkKind | null {
  if (name.endsWith(".nhs")) return "flow";
  if (name.endsWith(".json")) {
    try {
      return JSON.parse(text)?.kind === "readout" ? "readout" : null;
    } catch {
      return null;
    }
  }
  return null;
}

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  // Copied so the view is over a plain ArrayBuffer, which is what digest() takes.
  const digest = await crypto.subtle.digest("SHA-256", new Uint8Array(bytes));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export type ExportFile = { filename: string; mime: string; content: string | Uint8Array };

/**
 * The files an app needs in the App Library: apps/<id>/{app.nhs|readout.json,
 * app.nha, meta.json, README.md}. The package bytes are the canonical ones
 * the library's own build would produce.
 */
export function exportFiles(project: SdkProject, analysis: Analysis): ExportFile[] {
  if (!analysis.ok || !analysis.bytes || !analysis.package) return [];
  const manifest = analysis.package.manifest as Record<string, string>;
  const files: ExportFile[] = [
    project.kind === "flow"
      ? { filename: "app.nhs", mime: "text/plain", content: project.source }
      : { filename: "readout.json", mime: "application/json", content: project.source },
    { filename: "app.nha", mime: "application/json", content: analysis.bytes },
  ];
  const meta = {
    name: { en: manifest.name, ja: manifest.name, "zh-CN": manifest.name },
    summary: { en: manifest.summary, ja: manifest.summary, "zh-CN": manifest.summary },
    license: "MPL-2.0",
  };
  files.push({ filename: "meta.json", mime: "application/json", content: `${JSON.stringify(meta, null, 2)}\n` });
  files.push({ filename: "README.md", mime: "text/markdown", content: readmeFor(manifest, analysis) });
  return files;
}

function readmeFor(manifest: Record<string, string>, analysis: Analysis): string {
  const lines = [`# ${manifest.name}`, "", manifest.summary, ""];
  if (analysis.kind === "flow" && analysis.package) {
    const events = (analysis.package.nodes as { op: string; event?: string }[])
      .filter((node) => node.op === "emit" || node.op === "emit_value")
      .map((node) => node.event);
    if (events.length) {
      lines.push("## Events", "", ...events.map((event) => `- \`${event}\``), "");
    }
    lines.push(
      "## Cost",
      "",
      `${analysis.validation?.nodes} nodes, about ${analysis.validation?.estimatedUs} us per frame on a ${analysis.validation?.cellCount}-cell board; needs ${analysis.validation?.minOs}.`,
      "",
    );
  }
  return `${lines.join("\n")}`;
}

export function downloadFile(file: ExportFile): void {
  const blob = new Blob([typeof file.content === "string" ? file.content : new Uint8Array(file.content)], { type: file.mime });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = file.filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** Per-app run-time share the Build tab shows, for one to four running apps. */
export function runtimeShares(fps: number): { apps: number; us: number }[] {
  return Array.from({ length: MAX_SLOTS }, (_, index) => ({ apps: index + 1, us: appShareUs(fps, index + 1) }));
}

/**
 * Matrix shapes of the devices the backend knows, so an app is judged against
 * the board it will run on rather than the largest one.
 */
export function deviceTargets(devices: { uid: string; displayName: string; firmwareVersion?: string; hardwareModel?: string; raw: Record<string, any> }[]): MatrixTarget[] {
  const targets: MatrixTarget[] = [];
  for (const device of devices) {
    const raw = device.raw;
    const shape = raw.matrix_shape ?? raw.last_status?.matrix_shape ?? raw.system_summary?.matrix_shape;
    const rows = Number(shape?.rows);
    const cols = Number(shape?.cols);
    if (Number.isInteger(rows) && Number.isInteger(cols) && rows > 0 && cols > 0) {
      const firmware = device.firmwareVersion && device.firmwareVersion !== "unknown" ? device.firmwareVersion : undefined;
      const board = boardForHardwareModel(device.hardwareModel);
      const label = [device.displayName, board?.name ?? shortBoardName(device.hardwareModel), `${rows} × ${cols}`].filter(Boolean).join(" · ");
      targets.push({ key: `device:${device.uid}`, rows, cols, label, firmware, board });
    }
  }
  return targets;
}
