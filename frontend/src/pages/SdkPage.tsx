import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { BookOpen, FilePlus2, FolderOpen, Library, Trash2, X } from "lucide-react";

import { BuildPanel } from "../components/sdk/BuildPanel";
import { CodeEditor, type CodeEditorHandle } from "../components/sdk/CodeEditor";
import { ReferencePanel } from "../components/sdk/ReferencePanel";
import { ConfirmModal } from "../components/ConfirmModal";
import { useI18n } from "../i18n";
import { api } from "../lib/api";
import { useLocalised, type AppCatalogEntry } from "../lib/appLibrary";
import { useAuth } from "../lib/auth";
import { useDevicesPolling } from "../lib/device";
import {
  TARGET_PRESETS,
  appIdOf,
  deviceTargets,
  flowTemplate,
  freshAppId,
  kindOfFile,
  loadActiveProjectId,
  loadProjects,
  newProject,
  readoutTemplate,
  saveActiveProjectId,
  saveProjects,
  type MatrixTarget,
  type SdkKind,
  type SdkProject,
} from "../lib/sdkProject";
import { analyzeFlow, analyzeReadout, type Analysis } from "../sdk/lib/index.mjs";

type Tab = "build" | "reference";

const ANALYZE_DELAY_MS = 150;
const SAVE_DELAY_MS = 400;

function useDebounced<T>(value: T, delayMs: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = window.setTimeout(() => setDebounced(value), delayMs);
    return () => window.clearTimeout(timer);
  }, [value, delayMs]);
  return debounced;
}

function analyze(project: SdkProject, target: MatrixTarget): Analysis {
  return project.kind === "flow"
    ? analyzeFlow(project.source, { cellCount: target.rows * target.cols })
    : analyzeReadout(project.source);
}

function LibraryPicker({ onOpen, onClose }: { onOpen: (entry: AppCatalogEntry) => Promise<void>; onClose: () => void }) {
  const { t } = useI18n();
  const localised = useLocalised();
  const [items, setItems] = useState<AppCatalogEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [opening, setOpening] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    api.appLibraryIndex()
      .then((catalog) => { if (!cancelled) setItems(catalog.items || []); })
      .catch((err: unknown) => { if (!cancelled) setError(err instanceof Error ? err.message : "request_failed"); });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true" aria-labelledby="sdk-library-title" onClick={onClose}>
      <div className="modal-panel sdk-library-panel" onClick={(event) => event.stopPropagation()}>
        <header className="sdk-library-header">
          <h3 id="sdk-library-title">{t("sdkOpenFromLibrary")}</h3>
          <button type="button" className="button ghost compact icon-button" onClick={onClose} aria-label={t("sdkClose")}>
            <X size={16} strokeWidth={2} />
          </button>
        </header>
        <p className="sdk-hint">{t("sdkOpenFromLibraryHint")}</p>
        {error ? <p className="notice error">{t("appLibraryError")}: {error}</p> : null}
        {!items && !error ? <p className="sdk-hint">{t("loading")}</p> : null}
        <div className="sdk-library-list">
          {(items ?? []).map((entry) => (
            <button
              key={entry.id}
              type="button"
              className="sdk-library-item"
              disabled={opening !== null}
              onClick={() => {
                setOpening(entry.id);
                onOpen(entry).catch((err: unknown) => {
                  setError(err instanceof Error ? err.message : "request_failed");
                  setOpening(null);
                });
              }}
            >
              {entry.icon_url ? <img src={entry.icon_url} alt="" className="sdk-library-icon" /> : <span className="sdk-library-icon" />}
              <span className="sdk-library-text">
                <strong>{localised(entry.name)}</strong>
                <small>{entry.id} · v{entry.version} · {entry.kind ?? "flow"}</small>
              </span>
              {opening === entry.id ? <span className="sdk-hint">{t("loading")}</span> : null}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

export function SdkPage() {
  const { t } = useI18n();
  const { user } = useAuth();
  const { normalized } = useDevicesPolling();
  const editorRef = useRef<CodeEditorHandle | null>(null);
  const fileInput = useRef<HTMLInputElement | null>(null);

  const [projects, setProjects] = useState<SdkProject[]>(() => {
    const stored = loadProjects();
    return stored.length ? stored : [newProject("flow", flowTemplate("my_app", user?.username ?? "author"))];
  });
  const [activeId, setActiveId] = useState<string>(() => {
    const remembered = loadActiveProjectId();
    return remembered ?? "";
  });
  const [tab, setTab] = useState<Tab>("build");
  const [targetKey, setTargetKey] = useState(TARGET_PRESETS[0].key);
  const [picking, setPicking] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState<SdkProject | null>(null);
  const [storageFailed, setStorageFailed] = useState(false);
  const [openError, setOpenError] = useState<string | null>(null);

  const active = projects.find((project) => project.id === activeId) ?? projects[0];

  const targets = useMemo(() => [...deviceTargets(normalized), ...TARGET_PRESETS], [normalized]);
  const target = targets.find((item) => item.key === targetKey) ?? TARGET_PRESETS[0];

  // Analysis runs on a short delay so typing stays smooth; the result is what
  // every panel and the editor's diagnostics show.
  const pending = useDebounced(active, ANALYZE_DELAY_MS);
  const analysis = useMemo(() => analyze(pending, target), [pending, target]);
  const lastGoodReport = useRef(analysis.report);
  if (analysis.report) lastGoodReport.current = analysis.report;

  const toSave = useDebounced(projects, SAVE_DELAY_MS);
  useEffect(() => {
    setStorageFailed(!saveProjects(toSave));
  }, [toSave]);
  useEffect(() => {
    if (active) saveActiveProjectId(active.id);
  }, [active]);

  const updateSource = useCallback((source: string) => {
    setProjects((current) => current.map((project) => (
      project.id === active.id ? { ...project, source, updatedAt: Date.now() } : project
    )));
  }, [active.id]);

  const addProject = useCallback((project: SdkProject) => {
    setProjects((current) => [project, ...current]);
    setActiveId(project.id);
    setTab("build");
  }, []);

  const createProject = (kind: SdkKind) => {
    const appId = freshAppId(projects, kind === "flow" ? "my_app" : "my_readout");
    const author = user?.username ?? "author";
    addProject(newProject(kind, kind === "flow" ? flowTemplate(appId, author) : readoutTemplate(appId, author)));
  };

  const openFile = async (file: File) => {
    setOpenError(null);
    const text = await file.text();
    const kind = kindOfFile(file.name, text);
    if (!kind) {
      setOpenError(t("sdkOpenUnsupported").replace("{name}", file.name));
      return;
    }
    addProject(newProject(kind, text));
  };

  const openFromLibrary = async (entry: AppCatalogEntry) => {
    const { source } = await api.appLibrarySource(entry.id);
    addProject(newProject(source.kind, source.source, {
      appId: source.id,
      version: source.version,
      packageSha256: source.package_sha256,
    }));
    setPicking(false);
  };

  const deleteProject = (project: SdkProject) => {
    setProjects((current) => {
      const remaining = current.filter((item) => item.id !== project.id);
      return remaining.length ? remaining : [newProject("flow", flowTemplate("my_app", user?.username ?? "author"))];
    });
    setConfirmDelete(null);
  };

  const errorCount = analysis.diagnostics.filter((d) => d.severity === "error").length;
  const revealLine = (line: number) => editorRef.current?.revealLine(line);
  const tabs: { id: Tab; label: string }[] = [
    { id: "build", label: t("sdkTabBuild") },
    { id: "reference", label: t("sdkTabReference") },
  ];

  return (
    <div className="sdk-page">
      <header className="app-store-header sdk-header">
        <div>
          <h1>{t("sdkTitle")}</h1>
          <p className="app-store-subtitle">{t("sdkSubtitle")}</p>
        </div>
        <div className="sdk-header-actions">
          <button type="button" className="button compact" onClick={() => createProject("flow")}>
            <FilePlus2 size={14} strokeWidth={2} />{t("sdkNewFlow")}
          </button>
          <button type="button" className="button compact" onClick={() => createProject("readout")}>
            <FilePlus2 size={14} strokeWidth={2} />{t("sdkNewReadout")}
          </button>
          <button type="button" className="button compact" onClick={() => fileInput.current?.click()}>
            <FolderOpen size={14} strokeWidth={2} />{t("sdkOpenFile")}
          </button>
          <button type="button" className="button compact" onClick={() => setPicking(true)}>
            <Library size={14} strokeWidth={2} />{t("sdkOpenFromLibrary")}
          </button>
          <input
            ref={fileInput}
            type="file"
            accept=".nhs,.json"
            hidden
            onChange={(event) => {
              const file = event.target.files?.[0];
              event.target.value = "";
              if (file) void openFile(file);
            }}
          />
        </div>
      </header>

      {storageFailed ? <p className="notice warning">{t("sdkStorageFailed")}</p> : null}
      {openError ? <p className="notice error">{openError}</p> : null}

      <div className="sdk-workspace">
        <aside className="sdk-projects" aria-label={t("sdkProjects")}>
          <h2>{t("sdkProjects")}</h2>
          <ul>
            {projects.map((project) => {
              const selected = project.id === active.id;
              return (
                <li key={project.id} className={selected ? "active" : undefined}>
                  <button type="button" className="sdk-project" onClick={() => setActiveId(project.id)} aria-current={selected ? "true" : undefined}>
                    <span className="sdk-project-id">{appIdOf(project) || t("sdkUntitled")}</span>
                    <span className="sdk-project-kind">{project.kind === "flow" ? ".nhs" : "readout"}{project.origin ? ` · ${t("sdkFromLibrary")}` : ""}</span>
                  </button>
                  <button type="button" className="sdk-project-delete" onClick={() => setConfirmDelete(project)} aria-label={t("sdkDeleteProject")} title={t("sdkDeleteProject")}>
                    <Trash2 size={13} strokeWidth={2} />
                  </button>
                </li>
              );
            })}
          </ul>
          <p className="sdk-hint sdk-projects-note">{t("sdkDraftsNote")}</p>
        </aside>

        <section className="sdk-editor" aria-label={t("sdkEditor")}>
          <div className="sdk-editor-toolbar">
            <span className={`sdk-status-dot ${analysis.ok ? "ok" : "fail"}`} aria-hidden="true" />
            <strong className="sdk-mono">{active.kind === "flow" ? "app.nhs" : "readout.json"}</strong>
            <span className="sdk-hint">
              {analysis.ok ? t("sdkStatusOk") : t("sdkStatusErrors").replace("{count}", String(errorCount))}
            </span>
            <label className="sdk-target">
              <span>{t("sdkTarget")}</span>
              <select value={target.key} onChange={(event) => setTargetKey(event.target.value)}>
                {targets.map((item) => <option key={item.key} value={item.key}>{item.label}</option>)}
              </select>
            </label>
          </div>
          <CodeEditor
            ref={editorRef}
            docKey={active.id}
            value={active.source}
            language={active.kind === "flow" ? "nhs" : "json"}
            diagnostics={pending.id === active.id && pending.source === active.source ? analysis.diagnostics : []}
            symbols={lastGoodReport.current}
            onChange={updateSource}
            ariaLabel={t("sdkEditor")}
          />
        </section>

        <section className="sdk-side" aria-label={t("sdkInspector")}>
          <div className="segmented-control sdk-tabs" role="tablist" style={{ gridTemplateColumns: `repeat(${tabs.length}, minmax(0, 1fr))` }}>
            {tabs.map((item) => (
              <button key={item.id} type="button" role="tab" aria-selected={tab === item.id} className={tab === item.id ? "active" : undefined} onClick={() => setTab(item.id)}>
                {item.label}
              </button>
            ))}
          </div>
          {tab === "build" ? <BuildPanel project={active} analysis={analysis} onRevealLine={revealLine} /> : null}
          {tab === "reference" ? <ReferencePanel kind={active.kind} /> : null}
        </section>
      </div>

      {picking ? <LibraryPicker onOpen={openFromLibrary} onClose={() => setPicking(false)} /> : null}
      {confirmDelete ? (
        <ConfirmModal
          title={t("sdkDeleteProject")}
          message={t("sdkDeleteProjectConfirm").replace("{name}", appIdOf(confirmDelete) || t("sdkUntitled"))}
          confirmLabel={t("delete")}
          cancelLabel={t("cancel")}
          onConfirm={() => deleteProject(confirmDelete)}
          onCancel={() => setConfirmDelete(null)}
        />
      ) : null}
      <a className="sdk-docs-link" href="https://github.com/wenzi7777/NHOS-App-Library/blob/main/docs/authoring.md" target="_blank" rel="noreferrer">
        <BookOpen size={14} strokeWidth={2} />{t("sdkAuthoringGuide")}
      </a>
    </div>
  );
}

export default SdkPage;
