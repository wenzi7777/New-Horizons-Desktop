import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { Link, useParams } from "react-router-dom";
import { Download, FileText, Gauge, PanelRight, RefreshCw, ScrollText, Trash2, Upload, UserRound, type LucideIcon } from "lucide-react";

import { useI18n } from "../i18n";
import { type DeviceFileEntry } from "../lib/api";
import { normalizeDevice, useDevicesPolling } from "../lib/device";
import { useDeviceCommand } from "../lib/deviceCommand";
import {
  MAX_USER_PATH,
  READ_CHUNK_BYTES,
  bytesToHex,
  ensureReadAdvanced,
  ensureReadOk,
  ensureWriteOk,
  hexToBytes,
  readFailure,
  writeDeviceFile,
} from "../lib/deviceFileTransfer";
import { storageSnapshotFromResult } from "../lib/storageStatus";
import { ConfirmModal } from "../components/ConfirmModal";

const SCOPES = ["user", "logs", "calibration"] as const;
type FileScope = typeof SCOPES[number];

const SCOPE_ICONS: Record<FileScope, LucideIcon> = { user: UserRound, logs: ScrollText, calibration: Gauge };

// How much a preview reads: the end of a log, the start of anything else.
const LOG_PREVIEW_BYTES = 32768;

const fileKey = (file: DeviceFileEntry) => `${file.scope}:${file.path}`;

// Text as text; anything else (an app package, a calibration blob) as a hex
// dump of its first bytes, which says more than mojibake.
function previewTextOf(bytes: Uint8Array) {
  let control = 0;
  for (const byte of bytes) {
    if (byte < 9 || (byte > 13 && byte < 32)) control += 1;
  }
  if (bytes.length === 0 || control / bytes.length < 0.02) return new TextDecoder().decode(bytes);
  const lines: string[] = [];
  for (let offset = 0; offset < Math.min(bytes.length, 4096); offset += 16) {
    const row = Array.from(bytes.subarray(offset, offset + 16));
    const hex = row.map((byte) => byte.toString(16).padStart(2, "0")).join(" ").padEnd(47, " ");
    const ascii = row.map((byte) => (byte >= 32 && byte < 127 ? String.fromCharCode(byte) : ".")).join("");
    lines.push(`${offset.toString(16).padStart(8, "0")}  ${hex}  |${ascii}|`);
  }
  return lines.join("\n");
}

function chunkDataText(result: Record<string, unknown> | null | undefined) {
  const chunkResult = result ?? {};
  return typeof chunkResult.data === "string" ? chunkResult.data : "";
}

function normalizeItems(result: Record<string, unknown> | null | undefined, scope: FileScope): DeviceFileEntry[] {
  const rawItems = Array.isArray(result?.items) ? result.items
    : Array.isArray(result?.data) ? result.data
    : [];
  return rawItems
    .filter((item): item is Record<string, unknown> => Boolean(item && typeof item === "object"))
    .filter((item) => !item.is_dir)
    .map((item) => {
      const rawPath = String(item.path ?? "");
      const scopePrefix = `/${scope}/`;
      const relativePath = rawPath.startsWith(scopePrefix) ? rawPath.slice(scopePrefix.length) : rawPath;
      return {
        scope: String(item.scope ?? scope),
        path: relativePath,
        name: String(item.name ?? relativePath ?? ""),
        size: Number(item.size ?? 0),
        is_dir: Boolean(item.is_dir),
      };
    })
    .filter((item) => item.path);
}

function formatFileSize(bytes: number) {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${bytes} B`;
}

function formatSpeed(bytesPerSec: number): string {
  if (!Number.isFinite(bytesPerSec) || bytesPerSec <= 0) return "";
  if (bytesPerSec >= 1024 * 1024) return `${(bytesPerSec / 1024 / 1024).toFixed(1)} MB/s`;
  if (bytesPerSec >= 1024) return `${(bytesPerSec / 1024).toFixed(1)} KB/s`;
  return `${Math.round(bytesPerSec)} B/s`;
}

function formatEta(remainingBytes: number, bytesPerSec: number): string {
  if (!Number.isFinite(bytesPerSec) || bytesPerSec <= 0) return "";
  const secs = remainingBytes / bytesPerSec;
  if (secs >= 3600) return `~${Math.round(secs / 3600)}h`;
  if (secs >= 60) return `~${Math.round(secs / 60)}m`;
  return `~${Math.round(secs)}s`;
}

function percent(used: unknown, total: unknown) {
  const usedNumber = Number(used);
  const totalNumber = Number(total);
  if (!Number.isFinite(usedNumber) || !Number.isFinite(totalNumber) || totalNumber <= 0) return 0;
  return Math.max(0, Math.min(100, (usedNumber / totalNumber) * 100));
}

export function DeviceFilesPage() {
  const { t } = useI18n();
  const { deviceUid = "" } = useParams();
  const { devices } = useDevicesPolling();
  const { queue, running, errorMessage } = useDeviceCommand(deviceUid);
  const device = devices.find((item) => item.device_uid === deviceUid);
  const normalized = device ? normalizeDevice(device) : null;
  const maintenanceMode = normalized?.mode === "maintenance" || normalized?.mode === "safe_maintenance" || normalized?.mode === "SafeMaintenance";

  const [activeScope, setActiveScope] = useState<FileScope>("logs");
  const [itemsByScope, setItemsByScope] = useState<Record<FileScope, DeviceFileEntry[]>>({
    user: [],
    logs: [],
    calibration: [],
  });
  const [statusMessage, setStatusMessage] = useState("");
  const [uploadFile, setUploadFile] = useState<File | null>(null);
  const [uploadPath, setUploadPath] = useState("");
  const [selectedFile, setSelectedFile] = useState<DeviceFileEntry | null>(null);
  const [previewOpen, setPreviewOpen] = useState(true);
  // Previews read from the device, so they load only when asked for.
  const [previewFor, setPreviewFor] = useState<string | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewError, setPreviewError] = useState("");
  const [previewText, setPreviewText] = useState("");
  const [downloadProgress, setDownloadProgress] = useState<{ loaded: number; total: number; startTime: number } | null>(null);
  const [uploadProgress, setUploadProgress] = useState<{ loaded: number; total: number; startTime: number } | null>(null);
  const uploadAbortRef = useRef(false);
  const [storage, setStorage] = useState<Record<string, unknown>>({});
  const [confirmDelete, setConfirmDelete] = useState<DeviceFileEntry | null>(null);
  const uploadInputRef = useRef<HTMLInputElement | null>(null);
  const previewRef = useRef<HTMLPreElement | null>(null);

  const items = useMemo(() => itemsByScope[activeScope], [activeScope, itemsByScope]);
  const storageSnapshot = useMemo(() => storageSnapshotFromResult(storage), [storage]);
  const storageTotal = storageSnapshot.totalBytes;
  const storageUsed = storageSnapshot.usedBytes;
  const storageFree = storageSnapshot.freeBytes;
  const storageUsage = storageSnapshot.categories;
  const hasStoragePayload = storageSnapshot.hasPayload;
  const isUserScope = activeScope === "user";

  async function refreshStorage() {
    const response = await queue({ command: "storage_status" });
    setStorage(storageSnapshotFromResult(response.result).payload);
  }

  async function refreshScope(scope: FileScope = activeScope) {
    const response = await queue({ command: "file_list", scope });
    const nextItems = normalizeItems(response.result, scope);
    setItemsByScope((current) => ({ ...current, [scope]: nextItems }));
    setStatusMessage(`${t("fileListUpdated")}: ${scope}`);
  }

  useEffect(() => {
    if (!deviceUid) return;
    void refreshScope(activeScope);
    void refreshStorage();
  }, [activeScope, deviceUid]);

  useEffect(() => {
    setPreviewError("");
    // Logs open on the newest log; other scopes start with nothing selected.
    const kept = items.find((item) => item.path === (selectedFile?.path ?? "") && item.scope === activeScope) ?? null;
    const nextSelected = kept ?? (activeScope === "logs"
      ? items.find((item) => item.path === "device.log")
        ?? items.find((item) => item.path === "device.log.1")
        ?? items[0]
        ?? null
      : null);
    if (nextSelected?.path !== selectedFile?.path) {
      setSelectedFile(nextSelected);
    }
  }, [activeScope, items, selectedFile?.path]);

  // A new selection drops the previous preview.
  useEffect(() => {
    setPreviewFor(null);
    setPreviewText("");
    setPreviewError("");
  }, [selectedFile?.scope, selectedFile?.path]);

  useEffect(() => {
    if (!previewOpen || !selectedFile || previewFor !== fileKey(selectedFile)) return;
    let cancelled = false;
    const file = selectedFile;

    async function loadPreview() {
      setPreviewLoading(true);
      setPreviewError("");
      try {
        const begin = await queue({ command: "file_read_begin", scope: file.scope, path: file.path });
        ensureReadOk(begin.result);
        const size = Number(begin.result?.size ?? file.size ?? 0);
        // LOG_PREVIEW_BYTES (a log's newest, any other file's first), read
        // READ_CHUNK_BYTES at a time like a download rather than in one
        // request the device must buffer whole.
        const length = Math.min(size || LOG_PREVIEW_BYTES, LOG_PREVIEW_BYTES);
        let offset = file.scope === "logs" ? Math.max(size - length, 0) : 0;
        const parts: Uint8Array[] = [];
        let loaded = 0;
        while (!cancelled && loaded < length) {
          const chunk = await queue({
            command: "file_read_chunk",
            scope: file.scope,
            path: file.path,
            offset,
            length: READ_CHUNK_BYTES,
          });
          ensureReadOk(chunk.result);
          const data = chunkDataText(chunk.result);
          const bytes = /^[0-9a-fA-F]*$/.test(data) ? hexToBytes(data) : new TextEncoder().encode(data);
          parts.push(bytes);
          loaded += bytes.length;
          const chunkResult = chunk.result ?? {};
          const nextOffset = Number(chunkResult.next_offset ?? offset + bytes.length);
          const hasMore = Boolean(chunkResult.has_more ?? nextOffset < size);
          if (!bytes.length || !hasMore) break;
          ensureReadAdvanced(offset, nextOffset, hasMore);
          offset = nextOffset;
        }
        const merged = new Uint8Array(loaded);
        let cursor = 0;
        for (const part of parts) {
          merged.set(part, cursor);
          cursor += part.length;
        }
        if (!cancelled) {
          setPreviewText(previewTextOf(merged));
        }
      } catch (error) {
        if (!cancelled) {
          setPreviewText("");
          setPreviewError(error instanceof Error ? error.message : "request_failed");
        }
      } finally {
        if (!cancelled) {
          setPreviewLoading(false);
        }
      }
    }

    void loadPreview();
    return () => {
      cancelled = true;
    };
  // queue is stable (useCallback in useDeviceCommand) — intentionally omitted from deps
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeScope, previewOpen, previewFor, selectedFile]);

  async function downloadFileBytes(
    file: DeviceFileEntry,
    onProgress?: (loaded: number, total: number) => void,
  ) {
    const begin = await queue({ command: "file_read_begin", scope: file.scope, path: file.path });
    ensureReadOk(begin.result);
    const size = Number(begin.result?.size ?? file.size ?? 0);
    let offset = 0;
    let retried = false;
    const chunks: Uint8Array[] = [];
    onProgress?.(0, size);
    while (offset < size || chunks.length === 0) {
      const chunk = await queue({
        command: "file_read_chunk",
        scope: file.scope,
        path: file.path,
        offset,
        length: READ_CHUNK_BYTES,
      });
      const failure = readFailure(chunk.result);
      if (failure) {
        // One retry, after re-reading the size. A device that rebooted
        // mid-download (an OTA) may hold a different file now; splicing two
        // versions of it together would be worse than failing.
        if (retried) throw new Error(failure);
        retried = true;
        const again = await queue({ command: "file_read_begin", scope: file.scope, path: file.path });
        ensureReadOk(again.result);
        if (Number(again.result?.size ?? -1) !== size) throw new Error("file_changed");
        continue;
      }
      retried = false;
      const chunkResult = chunk.result ?? {};
      const data = typeof chunkResult.data === "string" ? chunkResult.data : "";
      const bytes = /^[0-9a-fA-F]*$/.test(data) ? hexToBytes(data) : new TextEncoder().encode(data);
      chunks.push(bytes);
      const nextOffset = Number(chunkResult.next_offset ?? offset + bytes.length);
      const hasMore = Boolean(chunkResult.has_more ?? nextOffset < size);
      ensureReadAdvanced(offset, nextOffset, hasMore);
      offset = nextOffset;
      onProgress?.(Math.min(offset, size), size);
      if (!hasMore) break;
    }
    const merged = new Uint8Array(chunks.reduce((total, chunk) => total + chunk.byteLength, 0));
    let writeOffset = 0;
    for (const chunk of chunks) {
      merged.set(chunk, writeOffset);
      writeOffset += chunk.byteLength;
    }
    return merged;
  }

  async function downloadFile(file: DeviceFileEntry) {
    const dlStartTime = Date.now();
    setDownloadProgress({ loaded: 0, total: Number(file.size ?? 0), startTime: dlStartTime });
    let bytes: Awaited<ReturnType<typeof downloadFileBytes>>;
    try {
      bytes = await downloadFileBytes(file, (loaded, total) => setDownloadProgress({ loaded, total, startTime: dlStartTime }));
    } catch (error) {
      // Said, not swallowed: the button's `void downloadFile()` would have
      // dropped the rejection and left the progress bar up forever.
      setDownloadProgress(null);
      setStatusMessage(`${t("downloadFailed")}: ${error instanceof Error ? error.message : String(error)}`);
      return;
    }
    const blob = new Blob([bytes]);
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = file.name || file.path.split("/").pop() || "download.bin";
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
    setDownloadProgress(null);
    setStatusMessage(`${t("download")}: ${file.path}`);
  }

  async function deleteFile(file: DeviceFileEntry) {
    await queue({ command: "file_delete", scope: file.scope, path: file.path });
    setStatusMessage(`${t("delete")}: ${file.path}`);
    await refreshScope(file.scope as FileScope);
    await refreshStorage();
  }

  async function uploadSelectedFile() {
    if (!uploadFile) return;
    const targetPath = uploadPath.trim() || uploadFile.name;
    if (targetPath.length > MAX_USER_PATH) {
      setStatusMessage(`${t("uploadFailed")}: path_too_long (${targetPath.length}/${MAX_USER_PATH})`);
      return;
    }
    const bytes = new Uint8Array(await uploadFile.arrayBuffer());
    uploadAbortRef.current = false;
    try {
      await writeDeviceFile(queue, {
        path: targetPath,
        bytes,
        scope: "user",
        onProgress: setUploadProgress,
        abortRef: uploadAbortRef,
      });
      setStatusMessage(`${t("uploadComplete")}: ${targetPath}`);
      setUploadFile(null);
      setUploadPath("");
      await refreshScope("user");
      await refreshStorage();
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      setStatusMessage(`${t("uploadFailed")}: ${reason}`);
    } finally {
      uploadAbortRef.current = false;
      setUploadProgress(null);
    }
  }

  async function toggleMaintenance(enable: boolean) {
    await queue(enable
      ? { command: "enter_maintenance", reason: "file_browser_upload" }
      : { command: "exit_maintenance" });
    await queue({ command: "status" });
    await refreshStorage();
    await refreshScope(activeScope);
  }

  // A log is read from its end; show the newest lines first.
  useEffect(() => {
    const element = previewRef.current;
    if (element) element.scrollTop = selectedFile?.scope === "logs" ? element.scrollHeight : 0;
  }, [previewText, selectedFile?.scope]);

  function onListKey(event: KeyboardEvent<HTMLDivElement>) {
    if (!items.length || (event.key !== "ArrowDown" && event.key !== "ArrowUp")) return;
    event.preventDefault();
    const index = items.findIndex((item) => item.path === selectedFile?.path);
    const next = event.key === "ArrowDown" ? Math.min(items.length - 1, index + 1) : Math.max(0, index - 1);
    setSelectedFile(items[next]);
  }

  const ScopeIcon = SCOPE_ICONS[activeScope];
  const selectedSize = formatFileSize(Number(selectedFile?.size ?? 0));
  const transfer = downloadProgress ?? uploadProgress;

  return (
    <>
      <section className="page-header">
        <div>
          <h2>{t("deviceFiles")}</h2>
          <p className="page-copy">{normalized?.displayName && normalized.displayName !== deviceUid ? `${normalized.displayName} · ${deviceUid}` : deviceUid}</p>
        </div>
        <Link className="button" to={`/device/${encodeURIComponent(deviceUid)}/settings`}>{t("settingsApp")}</Link>
      </section>
      {errorMessage ? <p className="notice error">{errorMessage}</p> : null}

      <section className="finder-window device-finder" aria-label={t("deviceFiles")}>
        <header className="finder-toolbar">
          <div className="finder-nav">
            <button
              type="button"
              className="finder-tool"
              title={t("refresh")}
              aria-label={t("refresh")}
              disabled={running || !deviceUid}
              onClick={() => { void refreshScope(); void refreshStorage(); }}
            >
              <RefreshCw size={15} strokeWidth={2} className={running ? "spinning" : undefined} />
            </button>
          </div>
          <h3 className="finder-title">{t(`fileScope_${activeScope}`)}</h3>
          <div className="finder-actions">
            {isUserScope ? (
              <button
                type="button"
                className="finder-tool"
                title={maintenanceMode ? t("upload") : t("fileWriteRequiresMaintenance")}
                aria-label={t("upload")}
                disabled={running || !deviceUid || !maintenanceMode}
                onClick={() => uploadInputRef.current?.click()}
              >
                <Upload size={16} strokeWidth={2} />
              </button>
            ) : null}
            <button
              type="button"
              className="finder-tool"
              title={t("download")}
              aria-label={t("download")}
              disabled={running || !selectedFile}
              onClick={() => selectedFile && void downloadFile(selectedFile)}
            >
              <Download size={16} strokeWidth={2} />
            </button>
            <button
              type="button"
              className="finder-tool danger"
              title={maintenanceMode ? t("delete") : t("fileWriteRequiresMaintenance")}
              aria-label={t("delete")}
              disabled={running || !selectedFile || !maintenanceMode}
              onClick={() => setConfirmDelete(selectedFile)}
            >
              <Trash2 size={16} strokeWidth={2} />
            </button>
            <button
              type="button"
              className={`finder-tool${previewOpen ? " active" : ""}`}
              title={previewOpen ? t("hidePreview") : t("preview")}
              aria-label={previewOpen ? t("hidePreview") : t("preview")}
              aria-pressed={previewOpen}
              onClick={() => (previewOpen ? setPreviewOpen(false) : setPreviewOpen(true))}
            >
              <PanelRight size={16} strokeWidth={2} />
            </button>
          </div>
          <input
            ref={uploadInputRef}
            type="file"
            hidden
            onChange={(event) => {
              setUploadFile(event.target.files?.[0] ?? null);
              event.target.value = "";
            }}
          />
        </header>

        <div className={`finder-body${previewOpen ? "" : " no-preview"}`}>
          <nav className="finder-sidebar" aria-label={t("fileScopes")}>
            <h4>{t("fileScopes")}</h4>
            {SCOPES.map((scope) => {
              const Icon = SCOPE_ICONS[scope];
              return (
                <button
                  key={scope}
                  type="button"
                  className={`finder-sidebar-item${activeScope === scope ? " selected" : ""}`}
                  onClick={() => setActiveScope(scope)}
                >
                  <Icon size={14} strokeWidth={2} aria-hidden="true" />
                  <span data-label={t(`fileScope_${scope}`)}>{t(`fileScope_${scope}`)}</span>
                  <small className="device-finder-count">{itemsByScope[scope].length}</small>
                </button>
              );
            })}
          </nav>

          <div className="finder-list-pane device-finder-list">
            {isUserScope ? (
              <div className={`device-finder-banner${maintenanceMode ? " on" : ""}`}>
                <span>
                  <strong>{t("maintenanceModeLabel")}</strong>
                  {" · "}
                  {maintenanceMode ? t("enabledState") : t("fileWriteRequiresMaintenance")}
                </span>
                <button className="button compact" type="button" disabled={running || !deviceUid} onClick={() => void toggleMaintenance(!maintenanceMode)}>
                  {maintenanceMode ? t("exitMaintenance") : t("enterMaintenance")}
                </button>
              </div>
            ) : null}
            {uploadFile ? (
              <div className="device-finder-upload">
                <Upload size={14} strokeWidth={2} aria-hidden="true" />
                <span className="device-finder-upload-name">{uploadFile.name}</span>
                <label>
                  {t("paramPath")}
                  <input value={uploadPath} onChange={(event) => setUploadPath(event.target.value)} placeholder={uploadFile.name} />
                </label>
                <button className="button compact primary" type="button" disabled={running || !maintenanceMode || Boolean(uploadProgress)} onClick={() => void uploadSelectedFile()}>
                  {t("upload")}
                </button>
                <button
                  className="button compact ghost"
                  type="button"
                  onClick={() => {
                    if (uploadProgress) uploadAbortRef.current = true;
                    else setUploadFile(null);
                  }}
                >
                  {t("cancel")}
                </button>
              </div>
            ) : null}
            <div className="finder-list-head" role="row">
              <span className="finder-col">{t("filesColName")}</span>
              <span className="finder-col finder-col-size">{t("filesColSize")}</span>
            </div>
            <div className="finder-list" role="listbox" aria-label={t(`fileScope_${activeScope}`)} tabIndex={0} onKeyDown={onListKey}>
              {items.length === 0 ? <p className="finder-empty">{running ? t("loading") : t("emptyFiles")}</p> : null}
              {items.map((file) => {
                const selected = selectedFile?.path === file.path;
                return (
                  <div
                    key={`${file.scope}:${file.path}`}
                    role="option"
                    aria-selected={selected}
                    className={`finder-row${selected ? " selected" : ""}`}
                    onClick={() => setSelectedFile(file)}
                    onDoubleClick={() => {
                      setSelectedFile(file);
                      setPreviewOpen(true);
                      setPreviewFor(fileKey(file));
                    }}
                  >
                    <span className="finder-cell finder-name">
                      <FileText size={16} strokeWidth={1.8} className="finder-icon" aria-hidden="true" />
                      <span>{file.name || file.path}</span>
                    </span>
                    <span className="finder-cell finder-muted finder-size">{formatFileSize(Number(file.size ?? 0))}</span>
                  </div>
                );
              })}
            </div>
          </div>

          {previewOpen ? (
            <aside className="finder-preview" aria-label={t("preview")}>
              {!selectedFile ? (
                <div className="finder-preview-hero">
                  <ScopeIcon size={40} strokeWidth={1.4} aria-hidden="true" />
                  <span>{items.length ? t("deviceFilesSelectHint") : t("emptyFiles")}</span>
                </div>
              ) : (
                <>
                  <div className="device-finder-preview-head">
                    <FileText size={30} strokeWidth={1.4} aria-hidden="true" />
                    <div>
                      <strong>{selectedFile.name || selectedFile.path}</strong>
                      <span>{t(`fileScope_${selectedFile.scope}`)} · {selectedSize}</span>
                    </div>
                  </div>
                  <div className="actions compact">
                    {previewFor === fileKey(selectedFile) ? (
                      <button className="button compact" type="button" onClick={() => setPreviewFor(null)}>
                        {t("hidePreview")}
                      </button>
                    ) : (
                      <button className="button compact primary" type="button" disabled={running} onClick={() => setPreviewFor(fileKey(selectedFile))}>
                        {t("preview")}
                      </button>
                    )}
                    <button className="button compact" type="button" disabled={running} onClick={() => void downloadFile(selectedFile)}>
                      <Download size={13} strokeWidth={2} aria-hidden="true" />
                      {t("download")}
                    </button>
                  </div>
                  {previewFor === fileKey(selectedFile) ? (
                    <>
                      <p className="device-finder-preview-note">
                        {selectedFile.scope === "logs" ? t("deviceFilesLogTail") : t("deviceFilesHead")}
                      </p>
                      {previewLoading ? <p className="finder-empty">{t("loadingPreview")}</p> : null}
                      {previewError ? <p className="notice error">{previewError}</p> : null}
                      {!previewLoading && !previewError ? <pre ref={previewRef} className="file-preview-content">{previewText}</pre> : null}
                    </>
                  ) : null}
                </>
              )}
            </aside>
          ) : null}
        </div>

        <footer className="finder-footer">
          <div className="device-finder-storage" title={storageUsage.map((item) => `${item.scope}: ${formatFileSize(item.bytes)}`).join(" · ")}>
            <span>{t("deviceStorage")}</span>
            <div className="storage-bar-track" aria-label={t("deviceStorage")}>
              {storageUsage.length > 0 ? storageUsage.map((item) => (
                <span key={item.scope} className={`storage-segment ${item.scope}`} style={{ width: `${percent(item.bytes, storageTotal)}%` }} />
              )) : storageTotal > 0 ? (
                <span className="storage-segment other" style={{ width: `${percent(storageUsed, storageTotal)}%` }} />
              ) : null}
            </div>
            <span>
              {hasStoragePayload
                ? t("deviceFilesStorageUsed").replace("{used}", formatFileSize(storageUsed)).replace("{total}", formatFileSize(storageTotal)).replace("{free}", formatFileSize(storageFree))
                : t("flashUnavailable")}
            </span>
            <button className="finder-tool" type="button" title={t("refreshFlashUsage")} aria-label={t("refreshFlashUsage")} disabled={running || !deviceUid} onClick={() => void refreshStorage()}>
              <RefreshCw size={12} strokeWidth={2} />
            </button>
          </div>
          <div className="finder-status">
            {transfer ? (
              <span className="device-finder-transfer">
                <span className="device-finder-transfer-bar">
                  <span style={{ width: `${transfer.total > 0 ? Math.round((transfer.loaded / transfer.total) * 100) : 0}%` }} />
                </span>
                {(() => {
                  const elapsed = (Date.now() - transfer.startTime) / 1000;
                  const speed = elapsed > 0.5 ? transfer.loaded / elapsed : 0;
                  const speedStr = formatSpeed(speed);
                  const eta = formatEta(transfer.total - transfer.loaded, speed);
                  return `${formatFileSize(transfer.loaded)} / ${formatFileSize(transfer.total)}${speedStr ? ` · ${speedStr}` : ""}${eta ? ` · ${eta}` : ""}`;
                })()}
              </span>
            ) : statusMessage}
          </div>
        </footer>
      </section>

      {confirmDelete ? (
        <ConfirmModal
          title={t("deviceFilesDeleteTitle").replace("{name}", confirmDelete.name || confirmDelete.path)}
          message={t("deviceFilesDeleteMessage")}
          confirmLabel={t("delete")}
          cancelLabel={t("cancel")}
          destructive
          onConfirm={() => {
            const file = confirmDelete;
            setConfirmDelete(null);
            void deleteFile(file).catch(() => undefined);
          }}
          onCancel={() => setConfirmDelete(null)}
        />
      ) : null}
    </>
  );
}
