import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent, type MouseEvent } from "react";
import {
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  Cpu,
  Download,
  FileSpreadsheet,
  Folder,
  Search,
  Trash2,
} from "lucide-react";

import { ConfirmModal } from "../components/ConfirmModal";
import { api, type CsvDirectoryResponse, type CsvExplorerEntry, type CsvPreviewResponse, type DeviceEntry } from "../lib/api";
import { useI18n } from "../i18n";

// The server's CSV recordings as a Finder window: devices in the sidebar, a
// sortable list view, a preview pane, a path bar and a status bar. Single
// click selects (⌘ toggles, Shift extends), double click opens a folder or
// downloads a file, and the keyboard does the rest (arrows, ⌘↑, ⌘[ ⌘],
// ⌘A, ⌘⌫).

type SortKey = "name" | "modified" | "size" | "kind";
type Sort = { key: SortKey; ascending: boolean };

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

// "Today at 14:03" / "Yesterday at 09:12" / a short date, as Finder shows it.
function formatModified(ms: number | undefined, locale: string, t: (key: string) => string) {
  if (!ms) return "—";
  const date = new Date(ms);
  const time = new Intl.DateTimeFormat(locale, { hour: "2-digit", minute: "2-digit" }).format(date);
  const startOfToday = new Date();
  startOfToday.setHours(0, 0, 0, 0);
  const dayMs = 24 * 60 * 60 * 1000;
  if (ms >= startOfToday.getTime()) return t("filesTodayAt").replace("{time}", time);
  if (ms >= startOfToday.getTime() - dayMs) return t("filesYesterdayAt").replace("{time}", time);
  return new Intl.DateTimeFormat(locale, { year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }).format(date);
}

function compareEntries(a: CsvExplorerEntry, b: CsvExplorerEntry, sort: Sort) {
  // Folders stay on top whatever the column, as Finder's default does.
  if (a.is_dir !== b.is_dir) return a.is_dir ? -1 : 1;
  let order = 0;
  if (sort.key === "modified") order = (a.modified_ms ?? 0) - (b.modified_ms ?? 0);
  else if (sort.key === "size") order = (a.size ?? 0) - (b.size ?? 0);
  else if (sort.key === "kind") order = String(a.kind).localeCompare(String(b.kind));
  if (order === 0) order = a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" });
  return sort.ascending ? order : -order;
}

function deviceLabel(device: DeviceEntry) {
  return device.display_name || device.device_name || device.device_uid;
}

export function FilesPage() {
  const { t, locale } = useI18n();
  const [devices, setDevices] = useState<DeviceEntry[]>([]);
  const [selectedDevice, setSelectedDevice] = useState("");
  const [directory, setDirectory] = useState<CsvDirectoryResponse | null>(null);
  const [backStack, setBackStack] = useState<string[]>([]);
  const [forwardStack, setForwardStack] = useState<string[]>([]);
  const [selection, setSelection] = useState<Set<string>>(new Set());
  const [anchorPath, setAnchorPath] = useState("");
  const [sort, setSort] = useState<Sort>({ key: "name", ascending: true });
  const [query, setQuery] = useState("");
  const [preview, setPreview] = useState<CsvPreviewResponse | null>(null);
  const [loadingDevices, setLoadingDevices] = useState(true);
  const [loadingFiles, setLoadingFiles] = useState(false);
  const [loadingPreview, setLoadingPreview] = useState(false);
  const [errorMessage, setErrorMessage] = useState("");
  const [previewError, setPreviewError] = useState("");
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const listRef = useRef<HTMLDivElement | null>(null);
  const previewRequest = useRef(0);

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

  const loadDirectory = useCallback(async (deviceUid: string, path = "") => {
    setSelection(new Set());
    setAnchorPath("");
    setQuery("");
    if (!deviceUid) {
      setDirectory(null);
      return;
    }
    setLoadingFiles(true);
    setErrorMessage("");
    try {
      setDirectory(await api.csvDirectory(deviceUid, path));
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "request_failed");
      setDirectory(null);
    } finally {
      setLoadingFiles(false);
    }
  }, []);

  useEffect(() => {
    setBackStack([]);
    setForwardStack([]);
    void loadDirectory(selectedDevice, "");
  }, [selectedDevice, loadDirectory]);

  const currentPath = directory?.path ?? "";
  const items = useMemo(() => directory?.items ?? [], [directory]);
  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return items.filter((item) => !needle || item.name.toLowerCase().includes(needle)).sort((a, b) => compareEntries(a, b, sort));
  }, [items, query, sort]);
  const selectedEntries = useMemo(() => visible.filter((item) => selection.has(item.path)), [visible, selection]);
  const singleFile = selectedEntries.length === 1 && !selectedEntries[0].is_dir ? selectedEntries[0] : null;
  const selectedFiles = selectedEntries.filter((item) => !item.is_dir);
  const totalBytes = useMemo(() => items.reduce((sum, item) => sum + (item.is_dir ? 0 : Number(item.size || 0)), 0), [items]);
  const pathParts = useMemo(() => (currentPath ? currentPath.split("/").filter(Boolean) : []), [currentPath]);
  const device = devices.find((item) => item.device_uid === selectedDevice);

  // The preview pane follows the selection: one file selected, its preview.
  useEffect(() => {
    setPreviewError("");
    if (!singleFile || !selectedDevice) {
      setPreview(null);
      setLoadingPreview(false);
      return;
    }
    const request = ++previewRequest.current;
    setLoadingPreview(true);
    api.previewCsv(selectedDevice, relativeEntryPath(currentPath, singleFile))
      .then((response) => {
        if (request === previewRequest.current) setPreview(response);
      })
      .catch((error: Error) => {
        if (request !== previewRequest.current) return;
        setPreview(null);
        setPreviewError(error.message);
      })
      .finally(() => {
        if (request === previewRequest.current) setLoadingPreview(false);
      });
  }, [singleFile, selectedDevice, currentPath]);

  function navigateTo(path: string) {
    if (!selectedDevice || path === currentPath) return;
    setBackStack((stack) => [...stack, currentPath]);
    setForwardStack([]);
    void loadDirectory(selectedDevice, path);
  }

  function goBack() {
    const previous = backStack[backStack.length - 1];
    if (previous === undefined) return;
    setBackStack((stack) => stack.slice(0, -1));
    setForwardStack((stack) => [currentPath, ...stack]);
    void loadDirectory(selectedDevice, previous);
  }

  function goForward() {
    const next = forwardStack[0];
    if (next === undefined) return;
    setForwardStack((stack) => stack.slice(1));
    setBackStack((stack) => [...stack, currentPath]);
    void loadDirectory(selectedDevice, next);
  }

  function goUp() {
    if (!directory?.path) return;
    navigateTo(directory.parent_path || "");
  }

  function downloadEntries(entries: CsvExplorerEntry[]) {
    for (const entry of entries) {
      if (entry.is_dir) continue;
      const anchor = document.createElement("a");
      anchor.href = api.downloadCsvUrl(entry.path);
      anchor.download = entry.name;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
    }
  }

  function openEntry(entry: CsvExplorerEntry) {
    if (entry.is_dir) navigateTo(relativeEntryPath(currentPath, entry));
    else downloadEntries([entry]);
  }

  async function deleteSelection() {
    setConfirmingDelete(false);
    setErrorMessage("");
    try {
      for (const entry of selectedEntries) {
        await api.deleteCsvEntry(selectedDevice, relativeEntryPath(currentPath, entry));
      }
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "request_failed");
    }
    await loadDirectory(selectedDevice, currentPath);
  }

  function selectOnly(path: string) {
    setSelection(new Set([path]));
    setAnchorPath(path);
  }

  function handleRowClick(event: MouseEvent, entry: CsvExplorerEntry) {
    if (event.shiftKey && anchorPath) {
      const from = visible.findIndex((item) => item.path === anchorPath);
      const to = visible.findIndex((item) => item.path === entry.path);
      if (from >= 0 && to >= 0) {
        const [lo, hi] = from < to ? [from, to] : [to, from];
        setSelection(new Set(visible.slice(lo, hi + 1).map((item) => item.path)));
        return;
      }
    }
    if (event.metaKey || event.ctrlKey) {
      setSelection((current) => {
        const next = new Set(current);
        if (next.has(entry.path)) next.delete(entry.path);
        else next.add(entry.path);
        return next;
      });
      setAnchorPath(entry.path);
      return;
    }
    selectOnly(entry.path);
  }

  function moveSelection(step: number, extend: boolean) {
    if (visible.length === 0) return;
    const lastIndex = visible.findIndex((item) => item.path === anchorPath);
    const index = lastIndex < 0 ? (step > 0 ? 0 : visible.length - 1) : Math.max(0, Math.min(visible.length - 1, lastIndex + step));
    const path = visible[index].path;
    if (extend) {
      setSelection((current) => new Set([...current, path]));
      setAnchorPath(path);
    } else {
      selectOnly(path);
    }
    listRef.current?.querySelector<HTMLElement>(`[data-path="${CSS.escape(path)}"]`)?.scrollIntoView({ block: "nearest" });
  }

  function handleListKey(event: KeyboardEvent<HTMLDivElement>) {
    const command = event.metaKey || event.ctrlKey;
    if (event.key === "ArrowDown" && command) {
      event.preventDefault();
      if (selectedEntries.length === 1) openEntry(selectedEntries[0]);
    } else if (event.key === "ArrowUp" && command) {
      event.preventDefault();
      goUp();
    } else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      moveSelection(event.key === "ArrowDown" ? 1 : -1, event.shiftKey);
    } else if (event.key === "Enter" && selectedEntries.length === 1) {
      event.preventDefault();
      openEntry(selectedEntries[0]);
    } else if (command && event.key === "[") {
      event.preventDefault();
      goBack();
    } else if (command && event.key === "]") {
      event.preventDefault();
      goForward();
    } else if (command && event.key.toLowerCase() === "a") {
      event.preventDefault();
      setSelection(new Set(visible.map((item) => item.path)));
    } else if ((event.key === "Backspace" && command) || event.key === "Delete") {
      event.preventDefault();
      if (selectedEntries.length) setConfirmingDelete(true);
    } else if (event.key === "Escape") {
      setSelection(new Set());
    }
  }

  function toggleSort(key: SortKey) {
    // A new column starts in its natural order: names A→Z, newest and largest first.
    setSort((current) => (current.key === key ? { key, ascending: !current.ascending } : { key, ascending: key === "name" || key === "kind" }));
  }

  function SortHeader({ column, label }: { column: SortKey; label: string }) {
    const active = sort.key === column;
    return (
      <button
        type="button"
        className={`finder-col finder-col-${column}${active ? " active" : ""}`}
        aria-sort={active ? (sort.ascending ? "ascending" : "descending") : "none"}
        onClick={() => toggleSort(column)}
      >
        <span>{label}</span>
        {active ? (sort.ascending ? <ChevronUp size={12} strokeWidth={2.4} /> : <ChevronDown size={12} strokeWidth={2.4} />) : null}
      </button>
    );
  }

  const statusText = selectedEntries.length
    ? t("filesSelectedCount").replace("{selected}", String(selectedEntries.length)).replace("{count}", String(visible.length))
    : t("filesItemCount").replace("{count}", String(visible.length));
  const deleteTitle = selectedEntries.length === 1
    ? t("filesDeleteOne").replace("{name}", selectedEntries[0].name)
    : t("filesDeleteMany").replace("{count}", String(selectedEntries.length));

  return (
    <>
      <section className="page-header">
        <div>
          <h2>{t("csvExport")}</h2>
          <p className="page-copy">{t("csvExportCopy")}</p>
        </div>
      </section>

      <section className="finder-window" aria-label={t("fileExplorer")}>
        <header className="finder-toolbar">
          <div className="finder-nav">
            <button type="button" className="finder-tool" title={`${t("filesBack")} (⌘[)`} aria-label={t("filesBack")} disabled={!backStack.length} onClick={goBack}>
              <ChevronLeft size={18} strokeWidth={2} />
            </button>
            <button type="button" className="finder-tool" title={`${t("filesForward")} (⌘])`} aria-label={t("filesForward")} disabled={!forwardStack.length} onClick={goForward}>
              <ChevronRight size={18} strokeWidth={2} />
            </button>
          </div>
          <h3 className="finder-title">
            {pathParts.length ? pathParts[pathParts.length - 1] : device ? deviceLabel(device) : t("fileExplorer")}
          </h3>
          <div className="finder-actions">
            <button type="button" className="finder-tool" title={`${t("parentFolder")} (⌘↑)`} aria-label={t("parentFolder")} disabled={!currentPath} onClick={goUp}>
              <ChevronUp size={17} strokeWidth={2} />
            </button>
            <button
              type="button"
              className="finder-tool"
              title={t("download")}
              aria-label={t("download")}
              disabled={selectedFiles.length === 0}
              onClick={() => downloadEntries(selectedFiles)}
            >
              <Download size={16} strokeWidth={2} />
            </button>
            <button
              type="button"
              className="finder-tool danger"
              title={`${t("delete")} (⌘⌫)`}
              aria-label={t("delete")}
              disabled={selectedEntries.length === 0}
              onClick={() => setConfirmingDelete(true)}
            >
              <Trash2 size={16} strokeWidth={2} />
            </button>
            <label className="finder-search">
              <Search size={14} strokeWidth={2} aria-hidden="true" />
              <input type="search" value={query} placeholder={t("filesSearch")} aria-label={t("filesSearch")} onChange={(event) => setQuery(event.target.value)} />
            </label>
          </div>
        </header>

        <div className="finder-body">
          <nav className="finder-sidebar" aria-label={t("filesDevices")}>
            <h4>{t("filesDevices")}</h4>
            {loadingDevices ? <p className="finder-sidebar-note">{t("loading")}</p> : null}
            {!loadingDevices && devices.length === 0 ? <p className="finder-sidebar-note">{t("noDevicesDiscovered")}</p> : null}
            {devices.map((item) => (
              <button
                key={item.device_uid}
                type="button"
                className={`finder-sidebar-item${item.device_uid === selectedDevice ? " selected" : ""}`}
                title={item.device_uid}
                onClick={() => setSelectedDevice(item.device_uid)}
              >
                <Cpu size={14} strokeWidth={2} aria-hidden="true" />
                <span>{deviceLabel(item)}</span>
              </button>
            ))}
          </nav>

          <div className="finder-list-pane">
            <div className="finder-list-head" role="row">
              <SortHeader column="name" label={t("filesColName")} />
              <SortHeader column="modified" label={t("filesColModified")} />
              <SortHeader column="size" label={t("filesColSize")} />
              <SortHeader column="kind" label={t("filesColKind")} />
            </div>
            <div
              ref={listRef}
              className="finder-list"
              role="listbox"
              aria-multiselectable="true"
              aria-label={t("fileExplorer")}
              tabIndex={0}
              onKeyDown={handleListKey}
              onClick={(event) => {
                if (event.target === event.currentTarget) setSelection(new Set());
              }}
            >
              {errorMessage ? <p className="notice error finder-notice">{errorMessage}</p> : null}
              {loadingFiles ? <p className="finder-empty">{t("loading")}</p> : null}
              {!loadingFiles && !errorMessage && items.length === 0 ? <p className="finder-empty">{selectedDevice ? t("emptyFolder") : t("selectDevice")}</p> : null}
              {!loadingFiles && items.length > 0 && visible.length === 0 ? (
                <p className="finder-empty">{t("filesNoMatch").replace("{query}", query.trim())}</p>
              ) : null}
              {!loadingFiles && visible.map((entry) => {
                const selected = selection.has(entry.path);
                return (
                  <div
                    key={entry.path}
                    data-path={entry.path}
                    role="option"
                    aria-selected={selected}
                    className={`finder-row${selected ? " selected" : ""}`}
                    onClick={(event) => handleRowClick(event, entry)}
                    onDoubleClick={() => openEntry(entry)}
                  >
                    <span className="finder-cell finder-name">
                      {entry.is_dir
                        ? <Folder size={16} strokeWidth={1.8} className="finder-icon folder" aria-hidden="true" />
                        : <FileSpreadsheet size={16} strokeWidth={1.8} className="finder-icon file" aria-hidden="true" />}
                      <span>{entry.name}</span>
                    </span>
                    <span className="finder-cell finder-muted">{formatModified(entry.modified_ms, locale, t)}</span>
                    <span className="finder-cell finder-muted finder-size">{entry.is_dir ? "—" : formatFileSize(entry.size)}</span>
                    <span className="finder-cell finder-muted">{entry.is_dir ? t("filesKindFolder") : t("filesKindCsv")}</span>
                  </div>
                );
              })}
            </div>
          </div>

          <aside className="finder-preview" aria-label={t("preview")}>
            {selectedEntries.length === 0 ? <p className="finder-empty">{t("noPreviewSelected")}</p> : null}
            {selectedEntries.length > 1 ? (
              <div className="finder-preview-hero">
                <FileSpreadsheet size={40} strokeWidth={1.4} aria-hidden="true" />
                <strong>{t("filesMultiSelected").replace("{count}", String(selectedEntries.length))}</strong>
                <span>{formatFileSize(selectedFiles.reduce((sum, item) => sum + Number(item.size || 0), 0))}</span>
              </div>
            ) : null}
            {selectedEntries.length === 1 && selectedEntries[0].is_dir ? (
              <div className="finder-preview-hero">
                <Folder size={44} strokeWidth={1.4} className="finder-icon folder" aria-hidden="true" />
                <strong>{selectedEntries[0].name}</strong>
                <span>{t("filesKindFolder")} · {formatModified(selectedEntries[0].modified_ms, locale, t)}</span>
              </div>
            ) : null}
            {singleFile ? (
              <>
                <div className="finder-preview-hero">
                  <FileSpreadsheet size={40} strokeWidth={1.4} className="finder-icon file" aria-hidden="true" />
                  <strong>{singleFile.name}</strong>
                  <span>{t("filesKindCsv")} · {formatFileSize(singleFile.size)}</span>
                </div>
                <dl className="finder-info">
                  <dt>{t("filesColModified")}</dt>
                  <dd>{formatModified(singleFile.modified_ms, locale, t)}</dd>
                  {preview ? (
                    <>
                      <dt>{t("csvColumns")}</dt>
                      <dd>{preview.columns}</dd>
                      <dt>{t("previewRows")}</dt>
                      <dd>{preview.row_count_previewed}</dd>
                      <dt>{t("headerDetected")}</dt>
                      <dd>{preview.has_header ? t("yes") : t("no")}</dd>
                    </>
                  ) : null}
                </dl>
                <button className="button primary finder-download" type="button" onClick={() => downloadEntries([singleFile])}>
                  <Download size={15} strokeWidth={2} aria-hidden="true" />
                  {t("download")}
                </button>
                {loadingPreview ? <p className="finder-empty">{t("loadingPreview")}</p> : null}
                {previewError ? <p className="notice error">{previewError}</p> : null}
                {!loadingPreview && preview ? (
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
                ) : null}
              </>
            ) : null}
          </aside>
        </div>

        <footer className="finder-footer">
          <nav className="finder-pathbar" aria-label={t("currentPath")}>
            <button type="button" disabled={!selectedDevice} onClick={() => navigateTo("")}>
              <Cpu size={12} strokeWidth={2} aria-hidden="true" />
              {device ? deviceLabel(device) : t("selectDevice")}
            </button>
            {pathParts.map((part, index) => (
              <span key={`${part}-${index}`} className="finder-pathbar-step">
                <ChevronRight size={11} strokeWidth={2} aria-hidden="true" />
                <button type="button" onClick={() => navigateTo(pathParts.slice(0, index + 1).join("/"))}>
                  <Folder size={12} strokeWidth={2} aria-hidden="true" />
                  {part}
                </button>
              </span>
            ))}
          </nav>
          <span className="finder-status">
            {statusText} · {t("total")} {formatFileSize(totalBytes)}
          </span>
        </footer>
      </section>
      <p className="finder-hint">{t("filesHint")}</p>

      {confirmingDelete && selectedEntries.length ? (
        <ConfirmModal
          title={deleteTitle}
          message={selectedEntries.some((item) => item.is_dir) ? t("filesDeleteBodyFolders") : t("filesDeleteBody")}
          confirmLabel={t("delete")}
          cancelLabel={t("cancel")}
          destructive
          onCancel={() => setConfirmingDelete(false)}
          onConfirm={() => void deleteSelection()}
        />
      ) : null}
    </>
  );
}
