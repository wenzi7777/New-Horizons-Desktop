import { useEffect, useMemo, useState } from "react";

import { api, type CsvDirectoryResponse, type CsvExplorerEntry, type CsvPreviewResponse, type DeviceEntry } from "../lib/api";
import { useI18n } from "../i18n";

function formatFileSize(bytes: number) {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  let value = bytes;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  return `${value >= 10 || unitIndex === 0 ? value.toFixed(0) : value.toFixed(1)} ${units[unitIndex]}`;
}

function relativeEntryPath(directoryPath: string, entry: CsvExplorerEntry) {
  const normalized = `${entry.path}`.replace(/^\/+/, "");
  const prefix = directoryPath ? `${directoryPath.replace(/^\/+|\/+$/g, "")}/` : "";
  if (prefix && normalized.startsWith(prefix)) return normalized.slice(prefix.length);
  const parts = normalized.split("/");
  return parts.length > 1 ? parts.slice(1).join("/") : normalized;
}

function fileKindLabel(entry: CsvExplorerEntry, t: (key: string) => string) {
  return entry.is_dir ? t("folder") : "CSV";
}

export function FilesPage() {
  const { t } = useI18n();
  const [devices, setDevices] = useState<DeviceEntry[]>([]);
  const [selectedDevice, setSelectedDevice] = useState("");
  const [directory, setDirectory] = useState<CsvDirectoryResponse | null>(null);
  const [selectedEntryPath, setSelectedEntryPath] = useState("");
  const [preview, setPreview] = useState<CsvPreviewResponse | null>(null);
  const [loadingDevices, setLoadingDevices] = useState(true);
  const [loadingFiles, setLoadingFiles] = useState(false);
  const [loadingPreview, setLoadingPreview] = useState(false);
  const [errorMessage, setErrorMessage] = useState("");
  const [previewError, setPreviewError] = useState("");

  useEffect(() => {
    setLoadingDevices(true);
    void api.devices()
      .then((response) => {
        setDevices(response.items);
        const first = response.items[0]?.device_uid ?? "";
        setSelectedDevice((current) => current || first);
      })
      .catch((error: Error) => setErrorMessage(error.message))
      .finally(() => setLoadingDevices(false));
  }, []);

  async function loadDirectory(deviceUid: string, path = "", preserveSelection = false) {
    if (!deviceUid) {
      setDirectory(null);
      setSelectedEntryPath("");
      setPreview(null);
      return;
    }
    setLoadingFiles(true);
    setErrorMessage("");
    try {
      const response = await api.csvDirectory(deviceUid, path);
      setDirectory(response);
      setSelectedEntryPath((current) => {
        if (preserveSelection && response.items.some((item) => item.path === current)) {
          return current;
        }
        return "";
      });
      if (!preserveSelection || !response.items.some((item) => item.path === selectedEntryPath)) {
        setPreview(null);
        setPreviewError("");
      }
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "request_failed");
      setDirectory(null);
      setSelectedEntryPath("");
      setPreview(null);
    } finally {
      setLoadingFiles(false);
    }
  }

  useEffect(() => {
    void loadDirectory(selectedDevice, "");
  }, [selectedDevice]);

  const items = directory?.items ?? [];
  const selectedEntry = useMemo(
    () => items.find((item) => item.path === selectedEntryPath) ?? null,
    [items, selectedEntryPath],
  );
  const summary = useMemo(() => {
    const files = items.filter((item) => !item.is_dir);
    const folders = items.filter((item) => item.is_dir);
    return {
      fileCount: files.length,
      folderCount: folders.length,
      totalBytes: files.reduce((sum, item) => sum + Number(item.size || 0), 0),
    };
  }, [items]);
  const breadcrumbParts = useMemo(() => (directory?.path ? directory.path.split("/").filter(Boolean) : []), [directory?.path]);

  async function handleOpenEntry(entry: CsvExplorerEntry) {
    setSelectedEntryPath(entry.path);
    setPreviewError("");
    if (entry.is_dir) {
      setPreview(null);
      await loadDirectory(selectedDevice, relativeEntryPath(directory?.path ?? "", entry));
      return;
    }
    setLoadingPreview(true);
    try {
      const response = await api.previewCsv(selectedDevice, relativeEntryPath(directory?.path ?? "", entry));
      setPreview(response);
    } catch (error) {
      setPreview(null);
      setPreviewError(error instanceof Error ? error.message : "request_failed");
    } finally {
      setLoadingPreview(false);
    }
  }

  async function handlePreview() {
    if (!selectedEntry || selectedEntry.is_dir) return;
    await handleOpenEntry(selectedEntry);
  }

  async function handleDelete() {
    if (!selectedEntry) return;
    const confirmMessage = selectedEntry.is_dir ? t("deleteFolderConfirm") : t("deleteFileConfirm");
    if (!window.confirm(confirmMessage)) return;
    try {
      setErrorMessage("");
      await api.deleteCsvEntry(selectedDevice, relativeEntryPath(directory?.path ?? "", selectedEntry));
      setPreview(null);
      setPreviewError("");
      setSelectedEntryPath("");
      await loadDirectory(selectedDevice, directory?.path ?? "");
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "request_failed");
    }
  }

  function navigateToParent() {
    if (!directory || !selectedDevice) return;
    void loadDirectory(selectedDevice, directory.parent_path || "");
  }

  function navigateBreadcrumb(index: number) {
    if (!selectedDevice) return;
    const path = index < 0 ? "" : breadcrumbParts.slice(0, index + 1).join("/");
    void loadDirectory(selectedDevice, path);
  }

  return (
    <>
      <section className="page-header">
        <div>
          <h2>{t("csvExport")}</h2>
          <p className="page-copy">{t("csvExportCopy")}</p>
        </div>
      </section>

      <section className="csv-workspace">
        <article className="panel csv-toolbar">
          <div className="field">
            <label>{t("deviceUid")}</label>
            <select value={selectedDevice} onChange={(event) => setSelectedDevice(event.target.value)} disabled={loadingDevices}>
              <option value="">{t("selectDevice")}</option>
              {devices.map((device) => (
                <option key={device.device_uid} value={device.device_uid}>
                  {device.display_name || device.device_name || device.device_uid}
                </option>
              ))}
            </select>
          </div>
          <div className="csv-breadcrumb-row">
            <div className="csv-breadcrumb-copy">
              <span>{t("currentPath")}</span>
              <div className="csv-breadcrumb">
                <button type="button" className="button small" onClick={() => navigateBreadcrumb(-1)} disabled={!selectedDevice}>
                  {t("deviceUid")}
                </button>
                {breadcrumbParts.map((part, index) => (
                  <button key={`${part}-${index}`} type="button" className="button small" onClick={() => navigateBreadcrumb(index)}>
                    {part}
                  </button>
                ))}
              </div>
            </div>
            <button className="button" type="button" onClick={navigateToParent} disabled={!directory?.path}>
              {t("parentFolder")}
            </button>
          </div>
          <div className="csv-summary-grid">
            <div className="csv-summary-card">
              <span>{t("csvFileCount")}</span>
              <strong>{summary.fileCount}</strong>
            </div>
            <div className="csv-summary-card">
              <span>{t("folder")}</span>
              <strong>{summary.folderCount}</strong>
            </div>
            <div className="csv-summary-card">
              <span>{t("total")}</span>
              <strong>{formatFileSize(summary.totalBytes)}</strong>
            </div>
          </div>
        </article>

        <section className="csv-explorer-layout">
          <article className="panel csv-explorer-panel">
            <div className="csv-list-header">
              <div>
                <h3>{t("fileExplorer")}</h3>
                <p>{selectedDevice || t("selectDevice")}</p>
              </div>
              {loadingFiles ? <span className="status-pill waiting">{t("loading")}</span> : null}
            </div>
            {errorMessage ? <p className="notice error">{errorMessage}</p> : null}
            <div className="csv-file-list">
              {loadingFiles ? <div className="empty">{t("loading")}</div> : null}
              {!loadingFiles && items.length === 0 ? <div className="empty">{t("emptyFolder")}</div> : null}
              {items.map((entry) => {
                const isSelected = selectedEntryPath === entry.path;
                return (
                  <button
                    key={entry.path}
                    type="button"
                    className={`csv-entry-row${isSelected ? " selected" : ""}`}
                    onClick={() => setSelectedEntryPath(entry.path)}
                    onDoubleClick={() => void handleOpenEntry(entry)}
                  >
                    <div className="csv-entry-main">
                      <span className="csv-entry-icon" aria-hidden="true">{entry.is_dir ? "DIR" : "CSV"}</span>
                      <div className="csv-entry-copy">
                        <strong>{entry.name}</strong>
                        <small>{fileKindLabel(entry, t)}</small>
                      </div>
                    </div>
                    <div className="csv-entry-meta">
                      <small>{entry.is_dir ? "—" : formatFileSize(entry.size)}</small>
                    </div>
                  </button>
                );
              })}
            </div>
          </article>

          <article className="panel csv-preview-panel">
            <div className="csv-list-header">
              <div>
                <h3>{t("preview")}</h3>
                <p>{selectedEntry?.name || t("noPreviewSelected")}</p>
              </div>
              <div className="actions compact-actions">
                <button className="button" type="button" onClick={() => void handlePreview()} disabled={!selectedEntry || selectedEntry.is_dir}>
                  {t("preview")}
                </button>
                <a
                  className={`button primary${!selectedEntry || selectedEntry.is_dir ? " disabled-link" : ""}`}
                  href={selectedEntry && !selectedEntry.is_dir ? api.downloadCsvUrl(selectedEntry.path) : undefined}
                  onClick={(event) => {
                    if (!selectedEntry || selectedEntry.is_dir) event.preventDefault();
                  }}
                >
                  {t("download")}
                </a>
                <button className="button danger" type="button" onClick={() => void handleDelete()} disabled={!selectedEntry}>
                  {t("delete")}
                </button>
              </div>
            </div>

            {previewError ? <p className="notice error">{previewError}</p> : null}
            {!selectedEntry ? <div className="empty">{t("noPreviewSelected")}</div> : null}
            {selectedEntry?.is_dir ? (
              <div className="csv-preview-summary">
                <div>
                  <span>{t("folder")}</span>
                  <strong>{selectedEntry.name}</strong>
                </div>
                <div>
                  <span>{t("currentPath")}</span>
                  <strong>{selectedEntry.path}</strong>
                </div>
              </div>
            ) : null}
            {loadingPreview ? <div className="empty">{t("loadingPreview")}</div> : null}
            {!loadingPreview && preview ? (
              <div className="csv-preview-content">
                <div className="csv-preview-summary">
                  <div>
                    <span>{t("deviceName")}</span>
                    <strong>{preview.name}</strong>
                  </div>
                  <div>
                    <span>{t("currentPath")}</span>
                    <strong>{preview.path}</strong>
                  </div>
                  <div>
                    <span>{t("total")}</span>
                    <strong>{formatFileSize(preview.size)}</strong>
                  </div>
                  <div>
                    <span>{t("csvColumns")}</span>
                    <strong>{preview.columns}</strong>
                  </div>
                  <div>
                    <span>{t("previewRows")}</span>
                    <strong>{preview.row_count_previewed}</strong>
                  </div>
                  <div>
                    <span>{t("headerDetected")}</span>
                    <strong>{preview.has_header ? t("yes") : t("no")}</strong>
                  </div>
                </div>
                <div className="csv-preview-table-wrap">
                  <table className="csv-preview-table">
                    {preview.header.length > 0 ? (
                      <thead>
                        <tr>
                          {preview.header.map((cell, index) => (
                            <th key={`${cell}-${index}`}>{cell}</th>
                          ))}
                        </tr>
                      </thead>
                    ) : null}
                    <tbody>
                      {preview.rows.map((row, rowIndex) => (
                        <tr key={`row-${rowIndex}`}>
                          {row.map((cell, cellIndex) => (
                            <td key={`cell-${rowIndex}-${cellIndex}`}>{cell}</td>
                          ))}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            ) : null}
            {!loadingPreview && selectedEntry && !selectedEntry.is_dir && !preview && !previewError ? (
              <div className="empty">{t("previewUnavailable")}</div>
            ) : null}
          </article>
        </section>
      </section>
    </>
  );
}
