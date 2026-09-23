import { useEffect, useMemo, useState } from "react";
import { AlertTriangle, CheckCircle2, Download, Info, XCircle } from "lucide-react";

import { useI18n } from "../../i18n";
import {
  downloadFile,
  exportFiles,
  runtimeShares,
  sha256Hex,
  type SdkProject,
} from "../../lib/sdkProject";
import {
  DEFAULT_BUDGET_US,
  MAX_NODES,
  MAX_PACKAGE_BYTES,
  WINDOW_POOL,
  type Analysis,
  type Diagnostic,
  type FlowNode,
} from "../../sdk/lib/index.mjs";

type Props = {
  project: SdkProject;
  analysis: Analysis;
  onRevealLine: (line: number) => void;
};

/** Everything on a node except its op and wiring, as `key=value`. */
function nodeParams(node: FlowNode): string {
  return Object.entries(node)
    .filter(([key]) => key !== "op" && key !== "in")
    .map(([key, value]) => `${key}=${typeof value === "string" ? value : JSON.stringify(value)}`)
    .join("  ");
}

function nodeInputs(node: FlowNode): string {
  if (node.in === undefined) return "";
  return (Array.isArray(node.in) ? node.in : [node.in]).map((index) => `#${index}`).join(", ");
}

function Meter({ label, value, limit, unit, warnAt }: {
  label: string;
  value: number;
  limit: number;
  unit?: string;
  warnAt?: number;
}) {
  const share = limit > 0 ? Math.min(value / limit, 1) : 0;
  const state = value > limit ? "over" : warnAt !== undefined && value > warnAt ? "warn" : "ok";
  return (
    <div className={`sdk-meter sdk-meter-${state}`}>
      <div className="sdk-meter-head">
        <span>{label}</span>
        <strong>
          {value.toLocaleString()}
          <small> / {limit.toLocaleString()}{unit ? ` ${unit}` : ""}</small>
        </strong>
      </div>
      <div className="sdk-meter-track" aria-hidden="true">
        <div className="sdk-meter-fill" style={{ width: `${share * 100}%` }} />
      </div>
    </div>
  );
}

function DiagnosticRow({ diagnostic, onRevealLine }: { diagnostic: Diagnostic; onRevealLine: (line: number) => void }) {
  const Icon = diagnostic.severity === "error" ? XCircle : diagnostic.severity === "warning" ? AlertTriangle : Info;
  const content = (
    <>
      <Icon size={14} strokeWidth={2} aria-hidden="true" />
      <span className="sdk-diagnostic-message">{diagnostic.message}</span>
      {diagnostic.line ? <span className="sdk-diagnostic-where">{diagnostic.line}{diagnostic.col ? `:${diagnostic.col}` : ""}</span> : null}
    </>
  );
  return diagnostic.line ? (
    <button type="button" className={`sdk-diagnostic sdk-diagnostic-${diagnostic.severity}`} onClick={() => onRevealLine(diagnostic.line ?? 1)}>
      {content}
    </button>
  ) : (
    <div className={`sdk-diagnostic sdk-diagnostic-${diagnostic.severity}`}>{content}</div>
  );
}

export function BuildPanel({ project, analysis, onRevealLine }: Props) {
  const { t } = useI18n();
  const [digest, setDigest] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setDigest(null);
    if (analysis.bytes) {
      void sha256Hex(analysis.bytes).then((hex) => {
        if (!cancelled) setDigest(hex);
      });
    }
    return () => {
      cancelled = true;
    };
  }, [analysis.bytes]);

  const files = useMemo(() => exportFiles(project, analysis), [project, analysis]);
  const errors = analysis.diagnostics.filter((d) => d.severity === "error");
  const validation = analysis.validation;
  const report = analysis.report;
  const nodes = (analysis.package?.nodes ?? []) as FlowNode[];
  const costByIndex = new Map(report?.breakdown.map((item) => [item.index, item.us]) ?? []);
  const manifestVersion = String(analysis.package?.manifest?.version ?? "");

  // A library app reopened here either still is the published package, or it
  // has been changed -- and a changed package must not reuse its version.
  let originNote: { tone: "success" | "warning" | "neutral"; text: string } | null = null;
  if (project.origin?.packageSha256 && digest) {
    if (digest === project.origin.packageSha256) {
      originNote = { tone: "success", text: t("sdkOriginIdentical").replace("{version}", project.origin.version) };
    } else if (manifestVersion === project.origin.version) {
      originNote = { tone: "warning", text: t("sdkOriginBumpVersion").replace("{version}", project.origin.version) };
    } else {
      originNote = { tone: "neutral", text: t("sdkOriginChanged").replace("{from}", project.origin.version).replace("{to}", manifestVersion) };
    }
  }

  return (
    <div className="sdk-panel-body">
      <div className={`sdk-verdict ${analysis.ok ? "ok" : "fail"}`}>
        {analysis.ok ? <CheckCircle2 size={18} strokeWidth={2} /> : <XCircle size={18} strokeWidth={2} />}
        <div>
          <strong>{analysis.ok ? t("sdkVerdictOk") : t("sdkVerdictFail").replace("{count}", String(errors.length))}</strong>
          <p>{analysis.ok ? t("sdkVerdictOkDetail") : t("sdkVerdictFailDetail")}</p>
        </div>
      </div>

      {originNote ? <p className={`notice ${originNote.tone === "neutral" ? "" : originNote.tone}`}>{originNote.text}</p> : null}

      {analysis.diagnostics.length ? (
        <section className="sdk-section">
          <h3>{t("sdkDiagnostics")}</h3>
          <div className="sdk-diagnostics">
            {analysis.diagnostics.map((diagnostic, index) => (
              <DiagnosticRow key={`${index}-${diagnostic.message}`} diagnostic={diagnostic} onRevealLine={onRevealLine} />
            ))}
          </div>
        </section>
      ) : null}

      {validation ? (
        <section className="sdk-section">
          <h3>{t("sdkLimits")}</h3>
          <div className="sdk-meters">
            {validation.kind === "flow" ? (
              <>
                <Meter label={t("sdkNodes")} value={validation.nodes} limit={MAX_NODES} warnAt={MAX_NODES - 2} />
                <Meter
                  label={t("sdkCost").replace("{cells}", String(validation.cellCount ?? ""))}
                  value={validation.estimatedUs}
                  limit={validation.budgetUs ?? DEFAULT_BUDGET_US}
                  unit="µs"
                />
                <Meter label={t("sdkWindowPool")} value={validation.windowFloats ?? 0} limit={WINDOW_POOL} unit={t("sdkFloats")} />
              </>
            ) : null}
            <Meter label={t("sdkPackageSize")} value={validation.size} limit={MAX_PACKAGE_BYTES} unit="B" warnAt={MAX_PACKAGE_BYTES * 0.85} />
          </div>
          {validation.kind === "flow" ? (
            <div className="sdk-shares">
              <span>{t("sdkShareTitle")}</span>
              {runtimeShares(60).map(({ apps, us }) => (
                <span key={apps} className={validation.estimatedUs > us ? "over" : undefined}>
                  {t("sdkShareApps").replace("{n}", String(apps))} <strong>{us} µs</strong>
                </span>
              ))}
            </div>
          ) : null}
          <dl className="sdk-facts">
            <div><dt>{t("sdkMinOs")}</dt><dd>{validation.minOs}</dd></div>
            {validation.kind === "flow" && report ? (
              <div><dt>{t("sdkShared")}</dt><dd>{report.reused}</dd></div>
            ) : null}
            {validation.kind === "readout" ? (
              <>
                <div><dt>{t("sdkSources")}</dt><dd>{validation.sources}</dd></div>
                <div><dt>{t("sdkRefresh")}</dt><dd>{validation.refreshMs} ms</dd></div>
              </>
            ) : null}
            <div>
              <dt>{t("sdkCapabilities")}</dt>
              <dd className="sdk-chips">
                {((analysis.package?.manifest?.capabilities ?? []) as string[]).map((cap) => <span key={cap} className="sdk-chip">{cap}</span>)}
              </dd>
            </div>
            {digest ? <div><dt>sha256</dt><dd className="sdk-mono sdk-digest" title={digest}>{digest.slice(0, 16)}…</dd></div> : null}
          </dl>
        </section>
      ) : null}

      {nodes.length ? (
        <section className="sdk-section">
          <h3>{t("sdkGraph")}</h3>
          <table className="sdk-table">
            <thead>
              <tr>
                <th>#</th>
                <th>{t("sdkOp")}</th>
                <th>{t("sdkInputs")}</th>
                <th>{t("sdkParams")}</th>
                <th className="num">µs</th>
                <th className="num">{t("sdkLine")}</th>
              </tr>
            </thead>
            <tbody>
              {nodes.map((node, index) => {
                const line = report?.nodeLines[index];
                return (
                  <tr key={index}>
                    <td className="sdk-mono">{index}</td>
                    <td className="sdk-mono">{node.op}</td>
                    <td className="sdk-mono sdk-nowrap">{nodeInputs(node)}</td>
                    <td className="sdk-mono sdk-params">{nodeParams(node)}</td>
                    <td className="num sdk-mono">{costByIndex.get(index) ?? ""}</td>
                    <td className="num">
                      {line ? (
                        <button type="button" className="sdk-link" onClick={() => onRevealLine(line)}>{line}</button>
                      ) : null}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </section>
      ) : null}

      <section className="sdk-section">
        <h3>{t("sdkExport")}</h3>
        <p className="sdk-hint">{t("sdkExportHint")}</p>
        <div className="sdk-export">
          {files.map((file) => (
            <button key={file.filename} type="button" className={`button compact${file.filename === "app.nha" ? " primary" : ""}`} onClick={() => downloadFile(file)}>
              <Download size={14} strokeWidth={2} />
              {file.filename}
            </button>
          ))}
          {!files.length ? <span className="sdk-hint">{t("sdkExportBlocked")}</span> : null}
        </div>
      </section>
    </div>
  );
}
