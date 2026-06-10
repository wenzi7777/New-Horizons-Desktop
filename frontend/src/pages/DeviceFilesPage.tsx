import { useEffect, useMemo, useState } from "react";
import { Link, useParams } from "react-router-dom";

import { useI18n } from "../i18n";
import { type DeviceFileEntry } from "../lib/api";
import { normalizeDevice, useDevicesPolling } from "../lib/device";
import { useDeviceCommand } from "../lib/deviceCommand";

const SCOPES = ["user", "logs", "calibration"] as const;
type FileScope = typeof SCOPES[number];

function bytesToHex(bytes: Uint8Array) {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function hexToBytes(hex: string) {
  const cleaned = hex.trim();
  const bytes = new Uint8Array(Math.floor(cleaned.length / 2));
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(cleaned.slice(index * 2, index * 2 + 2), 16);
  }
  return bytes;
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
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewError, setPreviewError] = useState("");
  const [previewText, setPreviewText] = useState("");
  const [downloadProgress, setDownloadProgress] = useState<{ loaded: number; total: number } | null>(null);

  const items = useMemo(() => itemsByScope[activeScope], [activeScope, itemsByScope]);

  async function refreshScope(scope: FileScope = activeScope) {
    const response = await queue({ command: "file_list", scope });
    const nextItems = normalizeItems(response.result, scope);
    setItemsByScope((current) => ({ ...current, [scope]: nextItems }));
    setStatusMessage(`${t("fileListUpdated")}: ${scope}`);
  }

  useEffect(() => {
    if (!deviceUid) return;
    if (activeScope === "logs") {
      setPreviewOpen(true);
    }
    void refreshScope(activeScope);
  }, [activeScope, deviceUid]);

  useEffect(() => {
    if (activeScope !== "logs") {
      setSelectedFile(null);
      setPreviewError("");
      setPreviewText("");
      return;
    }
    const nextSelected = items.find((item) => item.path === (selectedFile?.path ?? ""))
      ?? items.find((item) => item.path === "device.log")
      ?? items.find((item) => item.path === "device.log.1")
      ?? items[0]
      ?? null;
    if (nextSelected?.path !== selectedFile?.path) {
      setSelectedFile(nextSelected);
    }
  }, [activeScope, items, selectedFile?.path]);

  useEffect(() => {
    if (activeScope !== "logs" || !previewOpen || !selectedFile) return;
    let cancelled = false;
    const file = selectedFile;

    async function loadPreview() {
      setPreviewLoading(true);
      setPreviewError("");
      try {
        const begin = await queue({ command: "file_read_begin", scope: file.scope, path: file.path });
        const size = Number(begin.result?.size ?? file.size ?? 0);
        const length = Math.min(size || 32768, 32768);
        const offset = Math.max(size - length, 0);
        const chunk = await queue({
          command: "file_read_chunk",
          scope: file.scope,
          path: file.path,
          offset,
          length,
        });
        const data = chunkDataText(chunk.result);
        const bytes = /^[0-9a-fA-F]*$/.test(data) ? hexToBytes(data) : new TextEncoder().encode(data);
        if (!cancelled) {
          setPreviewText(new TextDecoder().decode(bytes));
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
  }, [activeScope, previewOpen, selectedFile]);

  async function downloadFileBytes(
    file: DeviceFileEntry,
    onProgress?: (loaded: number, total: number) => void,
  ) {
    const begin = await queue({ command: "file_read_begin", scope: file.scope, path: file.path });
    const size = Number(begin.result?.size ?? file.size ?? 0);
    let offset = 0;
    const chunks: Uint8Array[] = [];
    onProgress?.(0, size);
    while (offset < size || chunks.length === 0) {
      const chunk = await queue({
        command: "file_read_chunk",
        scope: file.scope,
        path: file.path,
        offset,
        length: 4096,
      });
      const chunkResult = chunk.result ?? {};
      const data = typeof chunkResult.data === "string" ? chunkResult.data : "";
      const bytes = /^[0-9a-fA-F]*$/.test(data) ? hexToBytes(data) : new TextEncoder().encode(data);
      chunks.push(bytes);
      const nextOffset = Number(chunkResult.next_offset ?? offset + bytes.length);
      const hasMore = Boolean(chunkResult.has_more ?? nextOffset < size);
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
    setDownloadProgress({ loaded: 0, total: Number(file.size ?? 0) });
    const bytes = await downloadFileBytes(file, (loaded, total) => setDownloadProgress({ loaded, total }));
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
  }

  async function uploadSelectedFile() {
    if (!uploadFile) return;
    const targetPath = uploadPath.trim() || uploadFile.name;
    const bytes = new Uint8Array(await uploadFile.arrayBuffer());
    await queue({ command: "file_write_begin", scope: "user", path: targetPath, size: bytes.length });
    let offset = 0;
    const chunkSize = 768;
    while (offset < bytes.length) {
      const chunk = bytes.slice(offset, offset + chunkSize);
      await queue({
        command: "file_write_chunk",
        scope: "user",
        path: targetPath,
        offset,
        data: bytesToHex(chunk),
      });
      offset += chunk.length;
    }
    await queue({ command: "file_write_finish", scope: "user", path: targetPath });
    setStatusMessage(`${t("uploadComplete")}: ${targetPath}`);
    setUploadFile(null);
    setUploadPath("");
    await refreshScope("user");
  }

  return (
    <>
      <section className="page-header">
        <div>
          <h2>{t("deviceFiles")}</h2>
          <p className="page-copy">{deviceUid}</p>
        </div>
        <Link className="button" to="/">{t("home")}</Link>
      </section>
      {errorMessage ? <p className="notice error">{errorMessage}</p> : null}
      {!maintenanceMode ? <p className="notice">Upload and delete are enabled in maintenance mode.</p> : null}
      <section className="panel-grid">
        <aside className="panel span-4 file-scope-panel">
          <h3>{t("fileScopes")}</h3>
          {SCOPES.map((scope) => (
            <button key={scope} type="button" className={activeScope === scope ? "active" : ""} onClick={() => setActiveScope(scope)}>
              <span>{t(`fileScope_${scope}`)}</span>
              <strong>{itemsByScope[scope].length}</strong>
            </button>
          ))}
          <button className="button primary" type="button" disabled={running || !deviceUid} onClick={() => void refreshScope()}>
            {t("refresh")}
          </button>
        </aside>
        <article className={`panel ${activeScope === "logs" && previewOpen ? "span-4" : "span-8"}`}>
          {activeScope === "user" ? (
            <div className="upload-panel">
              <div className="field-grid">
                <div className="field">
                  <label>{t("upload")}</label>
                  <input type="file" onChange={(event) => setUploadFile(event.target.files?.[0] ?? null)} />
                </div>
                <div className="field">
                  <label>{t("paramPath")}</label>
                  <input value={uploadPath} onChange={(event) => setUploadPath(event.target.value)} placeholder={uploadFile?.name ?? "configs/profile.json"} />
                </div>
              </div>
              <button className="button primary" type="button" disabled={running || !uploadFile || !maintenanceMode} onClick={() => void uploadSelectedFile()}>
                {t("upload")}
              </button>
            </div>
          ) : null}
          <div className="list">
            {items.length === 0 ? <div className="empty">{t("emptyFiles")}</div> : null}
            {items.map((file) => (
              <div key={`${file.scope}:${file.path}`} className={`list-item${selectedFile?.path === file.path ? " selected" : ""}`}>
                <div className="list-item-copy">
                  <strong>{file.name || file.path}</strong>
                  <span>{file.scope} / {file.path} / {formatFileSize(Number(file.size ?? 0))}</span>
                </div>
                <div className="actions compact">
                  {file.scope === "logs" ? (
                    <button className="button" disabled={running} type="button" onClick={() => { setSelectedFile(file); setPreviewOpen(true); }}>
                      {t("preview")}
                    </button>
                  ) : null}
                  <button className="button primary" disabled={running} type="button" onClick={() => void downloadFile(file)}>
                    {t("download")}
                  </button>
                  <button className="button danger" disabled={running || !maintenanceMode} type="button" onClick={() => void deleteFile(file)}>
                    {t("delete")}
                  </button>
                </div>
              </div>
            ))}
          </div>
          {downloadProgress ? (
            <div className="download-progress">
              <div className="download-progress-bar" style={{ width: `${downloadProgress.total > 0 ? Math.round((downloadProgress.loaded / downloadProgress.total) * 100) : 0}%` }} />
              <span>{formatFileSize(downloadProgress.loaded)} / {formatFileSize(downloadProgress.total)}</span>
            </div>
          ) : null}
          {statusMessage ? <p className="notice success">{statusMessage}</p> : null}
        </article>
        {activeScope === "logs" && previewOpen && selectedFile ? (
          <article className="panel span-4 file-preview-panel">
            <div className="file-preview-header">
              <div>
                <h3>{t("preview")}</h3>
                <p>{selectedFile.path}</p>
              </div>
              <button className="button" type="button" onClick={() => setPreviewOpen(false)}>
                {t("hidePreview")}
              </button>
            </div>
            <div className="csv-preview-summary">
              <div>
                <span>{t("logCurrentBytes")}</span>
                <strong>{formatFileSize(Number(selectedFile?.size ?? 0))}</strong>
              </div>
            </div>
            {previewLoading ? <p className="notice">{t("loadingPreview")}</p> : null}
            {previewError ? <p className="notice error">{previewError}</p> : null}
            {!previewLoading && !previewError ? <pre className="file-preview-content">{previewText}</pre> : null}
          </article>
        ) : null}
      </section>
    </>
  );
}
