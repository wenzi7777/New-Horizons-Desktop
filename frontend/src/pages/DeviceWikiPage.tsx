import { Fragment, useEffect, useMemo, useState } from "react";
import { Link, useParams } from "react-router-dom";

import { useI18n } from "../i18n";
import { api, type WikiDeviceEntry, type WikiDocumentResponse, type WikiEntry } from "../lib/api";
import { wikiSlugFromHardwareModel } from "../lib/boardProfile";
import { normalizeDevice, useDevicesPolling } from "../lib/device";

function inlineNodes(text: string) {
  const nodes: JSX.Element[] = [];
  const pattern = /`([^`]+)`|\[([^\]]+)\]\(([^)]+)\)/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) !== null) {
    if (match.index > lastIndex) {
      nodes.push(<Fragment key={`text-${lastIndex}`}>{text.slice(lastIndex, match.index)}</Fragment>);
    }
    if (match[1]) {
      nodes.push(<code key={`code-${match.index}`}>{match[1]}</code>);
    } else {
      nodes.push(
        <a key={`link-${match.index}`} href={match[3]} target="_blank" rel="noreferrer">
          {match[2]}
        </a>,
      );
    }
    lastIndex = pattern.lastIndex;
  }
  if (lastIndex < text.length) {
    nodes.push(<Fragment key={`text-${lastIndex}`}>{text.slice(lastIndex)}</Fragment>);
  }
  return nodes.length > 0 ? nodes : text;
}

function parseTableRow(line: string) {
  const trimmed = line.trim();
  if (!trimmed.startsWith("|") || !trimmed.endsWith("|")) return null;
  return trimmed
    .slice(1, -1)
    .split("|")
    .map((cell) => cell.trim());
}

export function renderMarkdown(content: string) {
  const lines = content.replace(/\r\n/g, "\n").split("\n");
  const nodes: JSX.Element[] = [];
  let index = 0;
  let codeBlock: string[] | null = null;

  while (index < lines.length) {
    const line = lines[index];
    const trimmed = line.trim();

    if (trimmed.startsWith("```")) {
      if (codeBlock) {
        nodes.push(
          <pre key={`code-${index}`}>
            <code>{codeBlock.join("\n")}</code>
          </pre>,
        );
        codeBlock = null;
      } else {
        codeBlock = [];
      }
      index += 1;
      continue;
    }

    if (codeBlock) {
      codeBlock.push(line);
      index += 1;
      continue;
    }

    if (!trimmed) {
      index += 1;
      continue;
    }

    const tableHeader = parseTableRow(line);
    const nextRow = parseTableRow(lines[index + 1] ?? "");
    if (tableHeader && nextRow && nextRow.every((cell) => /^:?-{3,}:?$/.test(cell))) {
      const bodyRows: string[][] = [];
      index += 2;
      while (index < lines.length) {
        const row = parseTableRow(lines[index]);
        if (!row) break;
        bodyRows.push(row);
        index += 1;
      }
      nodes.push(
        <div key={`table-${index}`} className="wiki-table-wrap">
          <table className="wiki-table">
            <thead>
              <tr>{tableHeader.map((cell, cellIndex) => <th key={cellIndex}>{inlineNodes(cell)}</th>)}</tr>
            </thead>
            <tbody>
              {bodyRows.map((row, rowIndex) => (
                <tr key={rowIndex}>
                  {row.map((cell, cellIndex) => <td key={cellIndex}>{inlineNodes(cell)}</td>)}
                </tr>
              ))}
            </tbody>
          </table>
        </div>,
      );
      continue;
    }

    if (trimmed.startsWith("# ")) {
      nodes.push(<h1 key={`h1-${index}`}>{inlineNodes(trimmed.slice(2))}</h1>);
      index += 1;
      continue;
    }
    if (trimmed.startsWith("## ")) {
      nodes.push(<h2 key={`h2-${index}`}>{inlineNodes(trimmed.slice(3))}</h2>);
      index += 1;
      continue;
    }
    if (trimmed.startsWith("### ")) {
      nodes.push(<h3 key={`h3-${index}`}>{inlineNodes(trimmed.slice(4))}</h3>);
      index += 1;
      continue;
    }
    if (trimmed.startsWith("- ")) {
      const items: string[] = [];
      while (index < lines.length && lines[index].trim().startsWith("- ")) {
        items.push(lines[index].trim().slice(2));
        index += 1;
      }
      nodes.push(
        <ul key={`ul-${index}`}>
          {items.map((item, itemIndex) => <li key={itemIndex}>{inlineNodes(item)}</li>)}
        </ul>,
      );
      continue;
    }

    nodes.push(<p key={`p-${index}`}>{inlineNodes(trimmed)}</p>);
    index += 1;
  }

  return nodes;
}

export function DeviceWikiPage() {
  const { t, locale } = useI18n();
  const { deviceUid } = useParams();
  const { devices } = useDevicesPolling();
  const [deviceEntries, setDeviceEntries] = useState<WikiDeviceEntry[]>([]);
  const [selectedDevice, setSelectedDevice] = useState("");
  const [entries, setEntries] = useState<WikiEntry[]>([]);
  const [selectedPath, setSelectedPath] = useState("");
  const [document, setDocument] = useState<WikiDocumentResponse | null>(null);
  const [errorMessage, setErrorMessage] = useState("");

  const selectedRuntimeDevice = useMemo(() => {
    const runtimeDevice = devices.find((item) => item.device_uid === deviceUid);
    return runtimeDevice ? normalizeDevice(runtimeDevice) : null;
  }, [deviceUid, devices]);

  useEffect(() => {
    let cancelled = false;
    void api.wikiDevices()
      .then((response) => {
        if (cancelled) return;
        setDeviceEntries(response.items);
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        setErrorMessage(error instanceof Error ? error.message : "wiki_devices_failed");
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!deviceEntries.length) return;
    const inferredSlug = selectedRuntimeDevice ? wikiSlugFromHardwareModel(selectedRuntimeDevice.hardwareModel) : "";
    const nextDevice = deviceEntries.find((entry) => entry.slug === inferredSlug)?.slug ?? deviceEntries[0]?.slug ?? "";
    if (nextDevice && !selectedDevice) {
      setSelectedDevice(nextDevice);
    }
  }, [deviceEntries, selectedDevice, selectedRuntimeDevice]);

  useEffect(() => {
    if (!selectedDevice) return;
    let cancelled = false;
    void api.wikiDirectory(selectedDevice, "", locale)
      .then((response) => {
        if (cancelled) return;
        setEntries(response.items);
        const preferred = response.items.find((item) => item.path === "README.md") ?? response.items[0] ?? null;
        setSelectedPath("");
        setDocument(null);
        if (preferred) setSelectedPath(preferred.path);
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        setErrorMessage(error instanceof Error ? error.message : "wiki_directory_failed");
      });
    return () => {
      cancelled = true;
    };
  }, [selectedDevice, locale]);

  useEffect(() => {
    if (!selectedDevice || !selectedPath) return;
    let cancelled = false;
    void api.wikiDocument(selectedDevice, selectedPath, locale)
      .then((response) => {
        if (cancelled) return;
        setDocument(response);
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        setErrorMessage(error instanceof Error ? error.message : "wiki_document_failed");
      });
    return () => {
      cancelled = true;
    };
  }, [selectedDevice, selectedPath, locale]);

  return (
    <>
      <section className="page-header">
        <div>
          <h2>{t("wikiTitle")}</h2>
          <p className="page-copy">{t("wikiCopy")}</p>
        </div>
        <div className="page-header-actions">
          <Link className="button" to="/">
            {t("home")}
          </Link>
          {document?.github_url ? (
            <a className="button" href={document.github_url} target="_blank" rel="noreferrer">
              {t("wikiSource")}
            </a>
          ) : null}
        </div>
      </section>

      {errorMessage ? <p className="notice error">{errorMessage}</p> : null}

      <section className="wiki-workspace">
        <aside className="panel wiki-device-panel">
          <h3>{t("wikiDevices")}</h3>
          {deviceEntries.length === 0 ? <p>{t("wikiEmptyDevices")}</p> : null}
          <div className="wiki-list">
            {deviceEntries.map((entry) => (
              <button
                key={entry.slug}
                className={entry.slug === selectedDevice ? "button active" : "button"}
                type="button"
                onClick={() => {
                  setSelectedDevice(entry.slug);
                  setSelectedPath("");
                  setDocument(null);
                }}
              >
                {entry.name}
              </button>
            ))}
          </div>
        </aside>

        <aside className="panel wiki-document-panel">
          <h3>{t("wikiDocuments")}</h3>
          {entries.length === 0 ? <p>{t("wikiEmptyDocuments")}</p> : null}
          <div className="wiki-list">
            {entries.filter((entry) => !entry.is_dir).map((entry) => (
              <button
                key={entry.path}
                className={entry.path === selectedPath ? "button active" : "button"}
                type="button"
                onClick={() => setSelectedPath(entry.path)}
              >
                {entry.name}
              </button>
            ))}
          </div>
        </aside>

        <article className="panel wiki-preview-panel">
          <div className="wiki-preview-content">
            {document ? renderMarkdown(document.content) : <p>{t("loading")}</p>}
          </div>
        </article>
      </section>
    </>
  );
}
