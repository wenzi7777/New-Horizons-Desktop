import { useEffect, useMemo, useRef, useState, type ClipboardEvent } from "react";
import { useParams } from "react-router-dom";

import { api, type DeviceEntry, type TerminalHelpEntry } from "../lib/api";
import { DEFAULT_BOARD_PROFILE, boardProfileForHardwareModel, displayHardwareModel, type BoardPinSlot, type BoardProfile } from "../lib/boardProfile";
import { commandDescriptionKey, useI18n } from "../i18n";
import { copyText } from "../lib/clipboard";
import {
  COMMAND_BLOCKS,
  COMMAND_GROUP_ORDER,
  LOCAL_ONLY_COMMANDS,
  buildCommandLine,
  findCommandBlock,
  missingRequiredParams,
  parsePastedCommand,
  type PasteErrorCode,
  type PasteWarning,
} from "../lib/terminalCommands";
import { valueToCsv } from "../lib/valueFormat";

type UpdateState = {
  phase?: string;
  operation?: string;
  version?: string;
  manifest_url?: string;
  changelog_url?: string;
  total_files?: number;
  applied_files?: number;
  skipped_files?: number;
  downloaded_files?: number;
  deleted_files?: number;
  current_file?: string;
  last_error?: string;
  last_result?: string;
  reboot_required?: boolean;
};

type TerminalLogEntry =
  | { type: "line"; text: string }
  | { type: "result"; result: Record<string, unknown> };

const LOCAL_HELP: TerminalHelpEntry = {
  command: "io-config",
  description: "Open the board pin layout helper.",
  example: "io-config",
};

function updateStateOf(device: DeviceEntry | undefined): UpdateState {
  const value = device?.update_state ?? device?.last_status?.update_state;
  return value && typeof value === "object" ? (value as UpdateState) : {};
}

function appliedFileCount(state: UpdateState): number {
  return Number(state.applied_files ?? Number(state.downloaded_files ?? 0) + Number(state.skipped_files ?? 0));
}

function isAppliedComplete(state: UpdateState): boolean {
  const operation = String(state.operation ?? "");
  const total = Number(state.total_files ?? 0);
  return operation === "apply_update" && total > 0 && appliedFileCount(state) >= total;
}

function progressOf(state: UpdateState): number {
  if (isAppliedComplete(state)) return 100;
  if (state.phase === "done") return 100;
  if (state.phase === "ready") return 12;
  if (state.phase === "downloading") {
    const total = Number(state.total_files ?? 0);
    const done = appliedFileCount(state);
    return total > 0 ? Math.min(96, Math.max(12, Math.round((done / total) * 100))) : 12;
  }
  if (state.phase === "error") return 100;
  return state.operation ? 8 : 0;
}

function stateToken(state: UpdateState) {
  return [
    state.phase ?? "",
    state.operation ?? "",
    state.total_files ?? 0,
    appliedFileCount(state),
    state.current_file ?? "",
    state.last_error ?? "",
  ].join("|");
}

function statusToken(status: Record<string, unknown> | null | undefined) {
  if (!status) return "";
  return String(status.received_at ?? status.last_seen_at ?? valueToCsv(status));
}

function deviceStatusToken(device: DeviceEntry | undefined) {
  return `${device?.last_seen_at ?? ""}|${statusToken(device?.last_status)}`;
}

function formatTerminalResult(result: Record<string, unknown>) {
  return { type: "result", result } satisfies TerminalLogEntry;
}

function formatJsonValue(value: unknown): string {
  if (value === null || value === undefined || value === "") return "-";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (Array.isArray(value)) return value.join(", ");
  if (typeof value === "object") return valueToCsv(value).split("\n").slice(1).join(" / ");
  return String(value);
}

function resultSummaryRows(result: Record<string, unknown>) {
  const state = result.update_state && typeof result.update_state === "object"
    ? (result.update_state as Record<string, unknown>)
    : {};
  const system = result.system && typeof result.system === "object"
    ? (result.system as Record<string, unknown>)
    : {};
  const command = String(result.command ?? "");
  const isReleaseCheck = command === "check_update";
  const isWriteCommand = command === "apply_update";
  const statePhase = String(state.phase ?? "");
  const showUpdateState = isReleaseCheck || isWriteCommand || statePhase === "downloading" || statePhase === "done" || statePhase === "error";
  const rows: [string, unknown][] = [
    ["command", result.command],
    ["status", result.status],
    ["message", result.message],
    ["mode", result.mode ?? system.mode],
    ["system", system.name],
    ["firmware_version", result.firmware_version ?? system.firmware_version],
    ["protocol", result.protocol],
    ["latest_release", isReleaseCheck ? result.latest_version ?? state.version : ""],
    ["applied_release", isWriteCommand ? result.version ?? state.version : ""],
    ["phase", showUpdateState ? state.phase : ""],
    ["operation", showUpdateState ? state.operation : ""],
    ["progress", showUpdateState && state.total_files ? `${state.applied_files ?? state.downloaded_files ?? 0}/${state.total_files}` : ""],
    ["current_file", showUpdateState ? state.current_file : ""],
    ["request_id", result.request_id],
  ];
  return rows.filter(([, value]) => value !== undefined && value !== null && value !== "");
}

export function CommandResultCard({ result }: { result: Record<string, unknown> }) {
  const { t } = useI18n();
  return (
    <div className="terminal-result-card">
      <div className="terminal-result-header">
        <span>{String(result.command ?? "result")}</span>
        {result.status ? <strong>{String(result.status)}</strong> : null}
        {result.message ? <em>{String(result.message)}</em> : null}
      </div>
      <div className="terminal-result-grid">
        {resultSummaryRows(result).map(([label, value]) => (
          <div key={label}>
            <span>{label}</span>
            <strong>{formatJsonValue(value)}</strong>
          </div>
        ))}
      </div>
      <details className="terminal-json-details">
        <summary>{t("decodedCsv")}</summary>
        <pre>{valueToCsv(result)}</pre>
      </details>
      <details className="terminal-json-details">
        <summary>{t("rawJson")}</summary>
        <pre>{JSON.stringify(result, null, 2)}</pre>
      </details>
    </div>
  );
}

function lineCardKind(text: string) {
  if (text.startsWith("$ ")) return "command";
  if (text.startsWith("> queued")) return "queued";
  if (text.startsWith("> ")) return "topic";
  if (text.startsWith("# ")) return "progress";
  if (text.startsWith("!") || text.startsWith("ERROR:")) return "error";
  if (text.startsWith("< ")) return "success";
  return "event";
}

function lineCardTitle(text: string, t: (key: string) => string) {
  const kind = lineCardKind(text);
  if (kind === "command") return t("command");
  if (kind === "queued") return t("queued");
  if (kind === "topic") return t("transportTarget");
  if (kind === "progress") return t("progress");
  if (kind === "error") return t("error");
  if (kind === "success") return t("event");
  return t("event");
}

function lineCardText(text: string) {
  return text.replace(/^\$ /, "").replace(/^> /, "").replace(/^# /, "").replace(/^< /, "");
}

function formatProgressLine(state: UpdateState) {
  const total = Number(state.total_files ?? 0);
  const applied = appliedFileCount(state);
  const progress = progressOf(state);
  const filled = Math.max(0, Math.min(20, Math.round(progress / 5)));
  const bar = `${"#".repeat(filled)}${"-".repeat(20 - filled)}`;
  const file = state.current_file ? ` ${state.current_file}` : "";
  const count = total > 0 ? ` ${applied}/${total}` : "";
  return `# ${state.operation ?? "update"} [${bar}] ${progress}%${count}${file}`;
}

function resultFromState(command: string, requestId: string, state: UpdateState): Record<string, unknown> | null {
  if (command === "check_update" && state.operation === command && state.phase === "ready") {
    return {
      status: "ok",
      message: "update_checked",
      command,
      request_id: requestId,
      latest_version: state.version ?? "",
      manifest_url: state.manifest_url ?? "",
      changelog_url: state.changelog_url ?? "",
      update_state: state,
      reboot_required: false,
    };
  }
  if (command === "apply_update" && state.operation === command && (state.phase === "done" || isAppliedComplete(state))) {
    const resultState = isAppliedComplete(state)
      ? { ...state, phase: "done", current_file: "", last_result: "applied", reboot_required: true }
      : state;
    return {
      status: "ok",
      message: "update_applied",
      command,
      request_id: requestId,
      version: resultState.version ?? "",
      downloaded_files: Number(resultState.downloaded_files ?? 0),
      skipped_files: Number(resultState.skipped_files ?? 0),
      deleted_files: Number(resultState.deleted_files ?? 0),
      update_state: resultState,
      reboot_required: Boolean(resultState.reboot_required ?? true),
    };
  }
  return null;
}

function statusSnapshotResult(command: string, requestId: string, device: DeviceEntry | undefined): Record<string, unknown> | null {
  if (!["status", "query", "memory_status", "scan_health", "storage_status"].includes(command)) {
    return null;
  }
  const status = device?.last_status;
  if (!status) return null;
  return {
    ...(status as Record<string, unknown>),
    command,
    request_id: requestId,
  };
}

function streamBufferResult(requestId: string, device: DeviceEntry | undefined): Record<string, unknown> | null {
  const status = device?.last_status;
  const runtime = status?.runtime && typeof status.runtime === "object" ? (status.runtime as Record<string, unknown>) : {};
  const streamBufferSource = status?.stream_buffer ?? runtime.stream_buffer;
  const streamBuffer = streamBufferSource && typeof streamBufferSource === "object"
    ? (streamBufferSource as Record<string, unknown>)
    : {};
  if (Object.keys(streamBuffer).length === 0) return null;
  const scanHealthSource = status?.scan_health;
  const scanHealth = scanHealthSource && typeof scanHealthSource === "object"
    ? (scanHealthSource as Record<string, unknown>)
    : {};
  const result: Record<string, unknown> = {
    status: "ok",
    message: "stream_buffer_updated",
    command: "set_stream_buffer",
    request_id: requestId,
    stream_buffer: streamBuffer,
  };
  if (Object.keys(scanHealth).length > 0) {
    result.scan_health = scanHealth;
  }
  return result;
}

function resultFromDeviceState(command: string, requestId: string, device: DeviceEntry | undefined): Record<string, unknown> | null {
  const stateResult = resultFromState(command, requestId, updateStateOf(device));
  if (stateResult) return stateResult;
  const snapshotResult = statusSnapshotResult(command, requestId, device);
  if (snapshotResult) return snapshotResult;
  if (command === "set_stream_buffer") {
    return streamBufferResult(requestId, device);
  }
  return null;
}

function togglePin(values: number[], value: number) {
  if (values.includes(value)) {
    return values.filter((item) => item !== value);
  }
  return [...values, value];
}

function pinCommand(analogPins: number[], selectPins: number[]) {
  return `set-matrix-layout --analog-pins ${analogPins.join(",")} --select-pins ${selectPins.join(",")}`;
}

function commandBlock(command: string) {
  return findCommandBlock(command) ?? COMMAND_BLOCKS[0];
}

function commandParamDefaultValue(command: string, key: string, profile = DEFAULT_BOARD_PROFILE) {
  if (command === "set-matrix-layout" && key === "analog-pins") {
    return profile.defaultAnalogPins.join(",");
  }
  if (command === "set-matrix-layout" && key === "select-pins") {
    return profile.defaultSelectPins.join(",");
  }
  if ((command === "check-update" || command === "apply-update") && key === "manifest-url") {
    return profile.defaultManifestUrl;
  }
  return "";
}

function commandParamDefaults(command: string, profile = DEFAULT_BOARD_PROFILE) {
  const block = commandBlock(command);
  return block.params.reduce<Record<string, string>>((values, param) => {
    values[param.key] = param.defaultValue ?? commandParamDefaultValue(command, param.key, profile);
    return values;
  }, {});
}

type PasteResult =
  | { ok: true; command: string; warnings: PasteWarning[] }
  | { ok: false; error: PasteErrorCode; detail?: string };

// The paste box is one line: fold shell line continuations and newlines (a
// pasted multi-line JSON payload) into spaces so the text stays readable.
function singleLine(text: string) {
  return text.replace(/\\\r?\n/g, " ").replace(/\r?\n/g, " ");
}

function pasteErrorMessage(result: { error: PasteErrorCode; detail?: string }, t: (key: string) => string) {
  return t(`terminalPasteError_${result.error}`).replace("{command}", result.detail ?? "");
}

function pasteWarningMessage(warning: PasteWarning, t: (key: string) => string) {
  return t(`terminalPasteWarn_${warning.code}`).replace("{key}", warning.key).replace("{value}", warning.value ?? "");
}

function commandUnavailableReason(command: string, profile: BoardProfile, t: (key: string) => string) {
  if (command === "set-indicators" && (!profile.supportsExternalLed || !profile.supportsOled)) {
    return t("terminalCommandUnavailableIndicators");
  }
  return "";
}

function boardAwareCommandDescription(command: string, profile: BoardProfile, t: (key: string) => string) {
  if (command === "set-indicators" && (!profile.supportsExternalLed || !profile.supportsOled)) {
    return t("terminalHelpSetIndicatorsUnsupported");
  }
  if (command === "power-set-state" && profile.powerUx === "remote_only") {
    return t("terminalHelpPowerSetStateRemoteOnly");
  }
  if (command === "io-config" && profile.supportsIoVisualizerArtwork) {
    return t("terminalHelpIoConfigBoardAware");
  }
  return t(commandDescriptionKey(command));
}

type BoardIoModalProps = {
  onClose: () => void;
  initialAnalogPins?: number[];
  initialSelectPins?: number[];
  defaultAnalogPins?: number[];
  defaultSelectPins?: number[];
  boardName?: string;
  supportsPinVisualizer?: boolean;
  overviewAsset?: string | null;
  analogPinOrder?: string[];
  digitalPinOrder?: string[];
  analogPinSlots?: BoardPinSlot[];
  digitalPinSlots?: BoardPinSlot[];
  analogHeading?: string;
  digitalHeading?: string;
  onApply?: (analogPins: number[], selectPins: number[]) => void | Promise<void>;
  applyDisabled?: boolean;
};

export function BoardIoModal({
  onClose,
  initialAnalogPins = [],
  initialSelectPins = [],
  defaultAnalogPins = DEFAULT_BOARD_PROFILE.defaultAnalogPins,
  defaultSelectPins = DEFAULT_BOARD_PROFILE.defaultSelectPins,
  boardName = DEFAULT_BOARD_PROFILE.hardwareModel,
  supportsPinVisualizer = true,
  overviewAsset = DEFAULT_BOARD_PROFILE.overviewAsset,
  analogPinOrder = DEFAULT_BOARD_PROFILE.analogPinOrder,
  digitalPinOrder = DEFAULT_BOARD_PROFILE.digitalPinOrder,
  analogPinSlots = DEFAULT_BOARD_PROFILE.analogPinSlots,
  digitalPinSlots = DEFAULT_BOARD_PROFILE.digitalPinSlots,
  analogHeading = DEFAULT_BOARD_PROFILE.analogPinHeading,
  digitalHeading = DEFAULT_BOARD_PROFILE.digitalPinHeading,
  onApply,
  applyDisabled = false,
}: BoardIoModalProps) {
  const { t } = useI18n();
  const [selectedAnalogPins, setSelectedAnalogPins] = useState<number[]>(() => initialAnalogPins.length ? initialAnalogPins : defaultAnalogPins);
  const [selectedSelectPins, setSelectedSelectPins] = useState<number[]>(() => initialSelectPins.length ? initialSelectPins : defaultSelectPins);
  const [copyStatus, setCopyStatus] = useState("");
  const [applyStatus, setApplyStatus] = useState("");
  const command = pinCommand(selectedAnalogPins, selectedSelectPins);
  const boardLabel = displayHardwareModel(boardName);
  const orientationCopy = boardName === DEFAULT_BOARD_PROFILE.hardwareModel ? t("ioOrientation") : boardLabel;

  function isSelected(pin: BoardPinSlot) {
    if (pin.role === "analog" && pin.gpio !== undefined) return selectedAnalogPins.includes(pin.gpio);
    if (pin.role === "select" && pin.gpio !== undefined) return selectedSelectPins.includes(pin.gpio);
    return false;
  }

  function handleToggle(pin: BoardPinSlot) {
    if (!pin.role || pin.gpio === undefined) return;
    setCopyStatus("");
    setApplyStatus("");
    if (pin.role === "analog") {
      setSelectedAnalogPins((current) => togglePin(current, Number(pin.gpio)));
    } else {
      setSelectedSelectPins((current) => togglePin(current, Number(pin.gpio)));
    }
  }

  async function handleCopy() {
    try {
      await copyText(command);
      setCopyStatus(t("copied"));
    } catch {
      setCopyStatus(t("copyFailed"));
    }
  }

  async function handleApply() {
    if (!onApply) return;
    try {
      await onApply(selectedAnalogPins, selectedSelectPins);
      setApplyStatus(t("pinLayoutApplied"));
    } catch (error) {
      setApplyStatus(error instanceof Error ? error.message : t("commandFailed"));
    }
  }

  function resetPins() {
    setSelectedAnalogPins(defaultAnalogPins);
    setSelectedSelectPins(defaultSelectPins);
    setCopyStatus("");
    setApplyStatus("");
  }

  function clearPins() {
    setSelectedAnalogPins([]);
    setSelectedSelectPins([]);
    setCopyStatus("");
    setApplyStatus("");
  }

  function renderPinList(pins: BoardPinSlot[], keyPrefix: string, selectedPins: number[]) {
    return (
      <ol>
        {pins.map((pin, index) => {
          const selectable = pin.role && pin.gpio !== undefined;
          const selected = isSelected(pin);
          const selectionOrder = selected && pin.gpio !== undefined ? selectedPins.indexOf(pin.gpio) + 1 : null;
          return (
            <li key={`${keyPrefix}-${index}`} className={selected ? "selected" : ""}>
              <button
                type="button"
                className="pin-button"
                disabled={!selectable}
                onClick={() => handleToggle(pin)}
                aria-pressed={selectable ? selected : undefined}
              >
                <span className={selectionOrder !== null ? "pin-order" : undefined}>
                  {selectionOrder !== null ? selectionOrder : index + 1}
                </span>
                <strong>{pin.label}</strong>
                <em>{pin.gpio !== undefined ? `GPIO ${pin.gpio}` : "-"}</em>
              </button>
            </li>
          );
        })}
      </ol>
    );
  }

  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true" aria-labelledby="io-config-title">
      <div className="modal-panel io-modal">
        <div className="modal-header">
          <div>
            <h3 id="io-config-title">{t("ioConfigTitle")}</h3>
            <p>{supportsPinVisualizer ? orientationCopy : boardLabel}</p>
          </div>
          <button className="button" type="button" onClick={onClose}>
            {t("ioConfigClose")}
          </button>
        </div>
        <div className="board-diagram">
          <div className="board-outline board-image-outline">
            {supportsPinVisualizer && overviewAsset ? (
              <img className="board-overview-image" src={overviewAsset} alt={`${boardLabel} overview`} />
            ) : (
              <div className="board-overview-image" aria-label={boardLabel}>
                <strong>{boardLabel}</strong>
              </div>
            )}
          </div>
          <div className="io-config-panel">
            <div className="command-copy">
              <label>{t("copyCommand")}</label>
              <code>{command}</code>
              <div className="actions compact">
                {onApply ? (
                  <button
                    className="button primary"
                    type="button"
                    onClick={() => void handleApply()}
                    disabled={applyDisabled || !selectedAnalogPins.length || !selectedSelectPins.length}
                  >
                    {t("applyPinLayout")}
                  </button>
                ) : null}
                <button className="button primary" type="button" onClick={() => void handleCopy()} disabled={!selectedAnalogPins.length || !selectedSelectPins.length}>
                  {t("copyCommand")}
                </button>
                <button className="button" type="button" onClick={resetPins}>
                  {t("selectDefaultPins")}
                </button>
                <button className="button" type="button" onClick={clearPins}>
                  {t("clearSelection")}
                </button>
              </div>
              {copyStatus ? <p className="notice success">{copyStatus}</p> : null}
              {applyStatus ? <p className="notice success">{applyStatus}</p> : null}
            </div>
            <div className="selected-pin-summary">
              <div>
                <span>{t("analogPins")}</span>
                <strong>{selectedAnalogPins.join(",") || "-"}</strong>
              </div>
              <div>
                <span>{t("selectPins")}</span>
                <strong>{selectedSelectPins.join(",") || "-"}</strong>
              </div>
            </div>
            {supportsPinVisualizer ? (
              <div className="pin-table">
                <div>
                  <h4 title={analogPinOrder.join(", ")}>{analogHeading}</h4>
                  {renderPinList(analogPinSlots, "ana", selectedAnalogPins)}
                </div>
                <div>
                  <h4 title={digitalPinOrder.join(", ")}>{digitalHeading}</h4>
                  {renderPinList(digitalPinSlots, "dig", selectedSelectPins)}
                </div>
              </div>
            ) : null}
          </div>
        </div>
      </div>
    </div>
  );
}

export function TerminalPage() {
  const { t } = useI18n();
  const { deviceUid: routeDeviceUid } = useParams();
  const [devices, setDevices] = useState<DeviceEntry[]>([]);
  const [helpItems, setHelpItems] = useState<TerminalHelpEntry[]>([]);
  const [selectedDevice, setSelectedDevice] = useState("");
  const [selectedCommand, setSelectedCommand] = useState("status");
  const [paramValues, setParamValues] = useState<Record<string, string>>(() => commandParamDefaults("status", DEFAULT_BOARD_PROFILE));
  const [logs, setLogs] = useState<TerminalLogEntry[]>([{ type: "line", text: t("terminalReady") }]);
  const [errorMessage, setErrorMessage] = useState("");
  const [running, setRunning] = useState(false);
  const [showIoModal, setShowIoModal] = useState(false);
  const [pasteText, setPasteText] = useState("");
  const [pasteResult, setPasteResult] = useState<PasteResult | null>(null);
  const logRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    void Promise.all([api.devices(), api.terminalHelp()])
      .then(([deviceResponse, helpResponse]) => {
        setDevices(deviceResponse.items);
        setSelectedDevice(routeDeviceUid ?? deviceResponse.items[0]?.device_uid ?? "");
        const hasLocalHelp = helpResponse.items.some((item) => item.command === LOCAL_HELP.command);
        setHelpItems(hasLocalHelp ? helpResponse.items : [...helpResponse.items, LOCAL_HELP]);
      })
      .catch((error: Error) => setErrorMessage(error.message));
  }, [routeDeviceUid]);

  useEffect(() => {
    setLogs((current) => (current.length === 1 ? [{ type: "line", text: t("terminalReady") }] : current));
  }, [t]);

  useEffect(() => {
    if (logRef.current) {
      logRef.current.scrollTop = logRef.current.scrollHeight;
    }
  }, [logs]);

  const helpByCommand = useMemo(
    () =>
      new Map(
        helpItems.map((item) => [item.command, item]),
      ),
    [helpItems],
  );

  const selectedBlock = commandBlock(selectedCommand);
  const generatedCommand = useMemo(
    () => buildCommandLine(selectedBlock, paramValues),
    [paramValues, selectedBlock],
  );
  const missingParams = useMemo(
    () => missingRequiredParams(selectedBlock, paramValues),
    [paramValues, selectedBlock],
  );
  const groupedCommandBlocks = useMemo(
    () =>
      COMMAND_GROUP_ORDER.map((groupKey) => ({
        groupKey,
        items: COMMAND_BLOCKS.filter((block) => block.groupKey === groupKey),
      })).filter((group) => group.items.length > 0),
    [],
  );
  const selectedDeviceProfile = useMemo(
    () => boardProfileForHardwareModel(selectedDeviceEntry()?.hardware_model),
    [devices, selectedDevice],
  );
  const selectedDeviceOverviewAsset = selectedDeviceProfile.overviewAsset;
  const selectedDeviceAnalogPinOrder = selectedDeviceProfile.analogPinOrder;
  const selectedDeviceDigitalPinOrder = selectedDeviceProfile.digitalPinOrder;
  const boardProfile = selectedDeviceProfile;
  const selectedCommandUnavailableReason = useMemo(
    () => commandUnavailableReason(selectedCommand, selectedDeviceProfile, t),
    [selectedCommand, selectedDeviceProfile, t],
  );

  // Board-aware defaults (pins, manifest URL) follow the selected device's
  // board. Picking a command sets its defaults in selectCommand rather than in
  // an effect on selectedCommand, which would also wipe a pasted command's values.
  const selectedCommandRef = useRef(selectedCommand);
  selectedCommandRef.current = selectedCommand;
  useEffect(() => {
    setParamValues(commandParamDefaults(selectedCommandRef.current, selectedDeviceProfile));
  }, [selectedDeviceProfile]);

  function selectCommand(command: string) {
    setSelectedCommand(command);
    setParamValues(commandParamDefaults(command, selectedDeviceProfile));
    setErrorMessage("");
  }

  function applyPastedCommand(text: string) {
    const parsed = parsePastedCommand(text);
    if (!parsed.ok) {
      setPasteResult({ ok: false, error: parsed.error, detail: parsed.detail });
      return;
    }
    // Only what was pasted is filled -- no builder defaults -- so Run sends
    // exactly the pasted command; missing required params still gate Run.
    setSelectedCommand(parsed.command);
    setParamValues(parsed.values);
    setErrorMessage("");
    setPasteResult({ ok: true, command: parsed.command, warnings: parsed.warnings });
  }

  function handlePaste(event: ClipboardEvent<HTMLInputElement>) {
    const pasted = event.clipboardData.getData("text");
    if (!pasted) return;
    event.preventDefault();
    const input = event.currentTarget;
    const start = input.selectionStart ?? input.value.length;
    const end = input.selectionEnd ?? input.value.length;
    const next = singleLine(`${input.value.slice(0, start)}${pasted}${input.value.slice(end)}`);
    setPasteText(next);
    applyPastedCommand(next);
  }

  function updateParam(key: string, value: string) {
    setParamValues((current) => ({ ...current, [key]: value }));
  }

  function appendLog(lines: string[]) {
    setLogs((current) => [...current, ...lines.map((text) => ({ type: "line", text }) satisfies TerminalLogEntry)]);
  }

  function appendResult(result: Record<string, unknown>) {
    setLogs((current) => [...current, formatTerminalResult(result)]);
  }

  function selectedDeviceEntry(items = devices) {
    return items.find((device) => device.device_uid === selectedDevice);
  }

  async function waitForResult(
    requestId: string,
    command: string,
    previousStatusToken: string,
  ) {
    const deadline = Date.now() + (command === "apply_update" ? 90000 : 16000);
    let lastProgressToken = "";
    while (Date.now() < deadline) {
      await new Promise((resolve) => window.setTimeout(resolve, 500));
      const response = await api.devices();
      setDevices(response.items);
      const device = selectedDeviceEntry(response.items);
      const result = device?.last_result;
      if (result && String(result.request_id ?? "") === requestId) {
        return result;
      }

      const state = updateStateOf(device);
      const stateResult = resultFromDeviceState(command, requestId, device);
      if (command === "apply_update" && state.operation === command) {
        const token = stateToken(state);
        if (token !== lastProgressToken) {
          lastProgressToken = token;
          appendLog([formatProgressLine(state)]);
        }
      }
      if (stateResult) {
        return stateResult;
      }
    }
    return null;
  }

  async function runCommand(commandLine: string) {
    const command = commandLine.trim();
    if (!command || running) {
      return;
    }
    const unavailableReason = commandUnavailableReason(selectedBlock.command, selectedDeviceProfile, t);
    if (unavailableReason) {
      setErrorMessage(unavailableReason);
      appendLog([`ERROR: ${unavailableReason}`]);
      return;
    }
    setErrorMessage("");
    appendLog([`$ ${command}`]);
    if (LOCAL_ONLY_COMMANDS.includes(command)) {
      setShowIoModal(true);
      appendLog([`< ${t("ioConfigOpen")}`]);
      return;
    }
    if (!selectedDevice) {
      setErrorMessage("device_uid_required");
      appendLog(["ERROR: device_uid_required"]);
      return;
    }
    setRunning(true);
    const selected = selectedDeviceEntry();
    const previousStatusToken = deviceStatusToken(selected);
    try {
      const result = await api.executeTerminal(selectedDevice, command);
      const transportTarget = [
        result.transport.transport ?? "udp",
        result.transport.peer ? `peer=${result.transport.peer}` : "",
      ].filter(Boolean).join(" ");
      appendLog([
        `> queued ${result.compiled.command} request_id=${result.request_id}`,
        `> ${transportTarget}`,
      ]);
      const deviceResult = await waitForResult(result.request_id, result.compiled.command, previousStatusToken);
      if (deviceResult) {
        appendResult(deviceResult);
      } else {
        appendLog([`! ${t("terminalNoResponse")} request_id=${result.request_id}`]);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "terminal_execute_failed";
      setErrorMessage(message);
      appendLog([`ERROR: ${message}`]);
    } finally {
      setRunning(false);
    }
  }

  async function handleRun() {
    if (missingParams.length > 0) {
      setErrorMessage(`${t("missingRequiredParams")}: ${missingParams.map((param) => t(param.labelKey)).join(", ")}`);
      return;
    }
    await runCommand(generatedCommand);
  }

  return (
    <>
      <section className="page-header">
        <div>
          <h2>{t("terminalTitle")}</h2>
        </div>
      </section>
      <section className="panel-grid terminal-layout">
        <article className="panel span-7 terminal-main-panel">
          <div className="field-grid">
            <div className="field">
              <label>{t("deviceUid")}</label>
              <select value={selectedDevice} onChange={(event) => setSelectedDevice(event.target.value)}>
                <option value="">{t("selectDevice")}</option>
                {devices.map((device) => (
                  <option key={device.device_uid} value={device.device_uid}>
                    {device.device_uid}
                  </option>
                ))}
              </select>
            </div>
          </div>
          <div className="field terminal-paste">
            <div className="terminal-input-row">
              <input
                type="text"
                value={pasteText}
                placeholder={t("terminalPlaceholder")}
                aria-label={t("terminalPlaceholder")}
                spellCheck={false}
                autoComplete="off"
                onPaste={handlePaste}
                onChange={(event) => {
                  setPasteText(event.target.value);
                  setPasteResult(null);
                }}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    event.preventDefault();
                    applyPastedCommand(pasteText);
                  }
                }}
              />
              <button className="button" type="button" onClick={() => applyPastedCommand(pasteText)} disabled={!pasteText.trim()}>
                {t("terminalPasteFill")}
              </button>
            </div>
            <span className="field-hint">{t("terminalHints")}</span>
            {pasteResult ? (
              <div aria-live="polite">
                {pasteResult.ok ? (
                  <p className="notice success">{t("terminalPasteFilled").replace("{command}", pasteResult.command)}</p>
                ) : (
                  <p className="notice error">{pasteErrorMessage(pasteResult, t)}</p>
                )}
                {pasteResult.ok && pasteResult.warnings.length ? (
                  <div className="notice warning">
                    {pasteResult.warnings.map((warning, index) => (
                      <div key={`${warning.code}-${warning.key}-${index}`}>{pasteWarningMessage(warning, t)}</div>
                    ))}
                  </div>
                ) : null}
              </div>
            ) : null}
          </div>
          <div className="command-card-shell">
            <div className="command-builder">
              <div className="command-builder-header">
                <div>
                  <span>{t("commandBuilder")}</span>
                  <h3>{selectedBlock.command}</h3>
                </div>
                <button className="button primary" onClick={() => void handleRun()} disabled={!generatedCommand || missingParams.length > 0 || running || Boolean(selectedCommandUnavailableReason)}>
                  {running ? t("running") : t("run")}
                </button>
              </div>
              <div className="command-flow" aria-label={t("commandFlow")}>
                <div className="command-root-card">
                  <span>{t("selectedCommand")}</span>
                  <strong>{selectedBlock.command}</strong>
                  <p>{boardAwareCommandDescription(selectedBlock.command, selectedDeviceProfile, t)}</p>
                </div>
                {selectedCommandUnavailableReason ? <p className="notice">{selectedCommandUnavailableReason}</p> : null}
                {selectedBlock.params.length ? (
                  <div className="command-param-chain">
                    {selectedBlock.params.map((param, index) => (
                      <div className="command-param-node" key={param.key}>
                        {index > 0 ? <div className="command-link-line" aria-hidden="true" /> : null}
                        <div className="command-param-card">
                          <div className="command-param-card-header">
                            <span>{t(param.labelKey)}</span>
                            <em>{param.required ? t("required") : t("optional")}</em>
                          </div>
                          {param.type === "select" ? (
                            <select
                              value={paramValues[param.key] ?? ""}
                              onChange={(event) => updateParam(param.key, event.target.value)}
                            >
                              <option value="">{t("skipParam")}</option>
                              {(param.options ?? []).map((option) => (
                                <option key={option.value} value={option.value}>
                                  {t(option.labelKey)}
                                </option>
                              ))}
                            </select>
                          ) : (
                            <input
                              type={param.type === "number" ? "number" : "text"}
                              value={paramValues[param.key] ?? ""}
                              placeholder={param.placeholder}
                              onChange={(event) => updateParam(param.key, event.target.value)}
                              onKeyDown={(event) => {
                                if (event.key === "Enter") {
                                  event.preventDefault();
                                  void handleRun();
                                }
                              }}
                            />
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                ) : (
                  <div className="command-empty-params">{t("noParameters")}</div>
                )}
              </div>
              <div className="generated-command">
                <span>{t("generatedCommand")}</span>
                <code>{generatedCommand}</code>
              </div>
            </div>
            <div className="terminal-log" ref={logRef}>
              {logs.map((entry, index) =>
                entry.type === "line" ? (
                  <div key={`${entry.text}-${index}`} className={`terminal-event-card ${lineCardKind(entry.text)}`}>
                    <div className="terminal-event-title">{lineCardTitle(entry.text, t)}</div>
                    <div className="terminal-event-body">{lineCardText(entry.text)}</div>
                  </div>
                ) : (
                  <CommandResultCard key={`result-${index}`} result={entry.result} />
                ),
              )}
            </div>
          </div>
          {errorMessage ? <p className="notice error">{errorMessage}</p> : null}
        </article>
        <aside className="panel span-5 terminal-help-panel">
          <h3>{t("commandBlocks")}</h3>
          <div className="terminal-suggestions command-block-list">
            {groupedCommandBlocks.map((group) => (
              <div
                className={`command-block-group${group.groupKey === "commandGroupDanger" ? " danger-zone" : ""}`}
                key={group.groupKey}
              >
                <h4>{t(group.groupKey)}</h4>
                <div className="command-block-grid">
                  {group.items.map((block) => {
                    const help = helpByCommand.get(block.command);
                    const unavailableReason = commandUnavailableReason(block.command, selectedDeviceProfile, t);
                    return (
                      <button
                        key={block.command}
                        className={`command-block-option${selectedCommand === block.command ? " active" : ""}`}
                        onClick={() => selectCommand(block.command)}
                        type="button"
                        disabled={Boolean(unavailableReason)}
                        title={unavailableReason || undefined}
                      >
                        <span>{block.command}</span>
                        <small>{boardAwareCommandDescription(block.command, selectedDeviceProfile, t)}</small>
                        <code>{help?.example ?? block.command}</code>
                      </button>
                    );
                  })}
                </div>
              </div>
            ))}
          </div>
        </aside>
      </section>
      {showIoModal ? (
        <BoardIoModal
          onClose={() => setShowIoModal(false)}
          defaultAnalogPins={boardProfile.defaultAnalogPins}
          defaultSelectPins={boardProfile.defaultSelectPins}
          boardName={boardProfile.hardwareModel}
          supportsPinVisualizer={boardProfile.supportsIoVisualizer}
          overviewAsset={boardProfile.overviewAsset}
          analogPinOrder={boardProfile.analogPinOrder}
          digitalPinOrder={boardProfile.digitalPinOrder}
          analogPinSlots={boardProfile.analogPinSlots}
          digitalPinSlots={boardProfile.digitalPinSlots}
          analogHeading={boardProfile.analogPinHeading}
          digitalHeading={boardProfile.digitalPinHeading}
        />
      ) : null}
    </>
  );
}
