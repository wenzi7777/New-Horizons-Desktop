import { useEffect, useState } from "react";
import "@fontsource/cormorant-garamond/latin-600-italic.css";

import { useI18n } from "../i18n";
import { compareVersions } from "../lib/versioning";
import { Markdown } from "./Markdown";
import { UAizuLogo } from "./UAizuLogo";

export const LAB_NAME = "Human Intelligent Sensing Lab";

// Release notes are the repo's notes/vX.Y.Z.md, one lazy chunk each so the
// changelog costs nothing until someone opens it.
const NOTE_LOADERS = import.meta.glob<string>("../../../notes/v*.md", { query: "?raw", import: "default" });
const NOTES = Object.entries(NOTE_LOADERS)
  .map(([path, load]) => ({ version: path.slice(path.lastIndexOf("/") + 1, -".md".length), load }))
  .sort((a, b) => compareVersions(b.version, a.version));

// Each note opens with "# vX.Y.Z", which the version picker already shows.
function stripTitle(source: string) {
  return source.replace(/^#\s+v\S+\s*\n/, "");
}

interface AboutDialogProps {
  version: string;
  onClose: () => void;
}

export function AboutDialog({ version, onClose }: AboutDialogProps) {
  const { t } = useI18n();
  const [selected, setSelected] = useState(() =>
    NOTES.some((note) => note.version === version) ? version : NOTES[0]?.version ?? "",
  );
  const [notes, setNotes] = useState<string | null>(null);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  useEffect(() => {
    const note = NOTES.find((entry) => entry.version === selected);
    if (!note) return undefined;
    let cancelled = false;
    setNotes(null);
    note.load().then((source) => {
      if (!cancelled) setNotes(stripTitle(source));
    });
    return () => {
      cancelled = true;
    };
  }, [selected]);

  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true" aria-labelledby="about-title" onClick={onClose}>
      <div className="modal-panel about-panel" onClick={(e) => e.stopPropagation()}>
        <div className="about-identity">
          <div className="about-product">
            <h3 id="about-title">New Horizons OS</h3>
            <small>{t("appTitle")} {version}</small>
          </div>
          <p className="about-lab">{LAB_NAME}</p>
          <div className="about-university">
            <UAizuLogo className="about-uaizu-logo" />
            <span>{t("aboutUniversity")}</span>
          </div>
        </div>
        {NOTES.length > 0 ? (
          <section className="about-changelog" aria-labelledby="about-changelog-title">
            <div className="about-changelog-head">
              <h4 id="about-changelog-title">{t("aboutChangelog")}</h4>
              <select value={selected} onChange={(e) => setSelected(e.target.value)} aria-label={t("aboutChangelogVersion")}>
                {NOTES.map((note) => (
                  <option key={note.version} value={note.version}>
                    {note.version}
                    {note.version === version ? ` (${t("aboutCurrentVersion")})` : ""}
                  </option>
                ))}
              </select>
            </div>
            <div className="about-changelog-body">
              {notes === null ? <p className="about-changelog-loading">…</p> : <Markdown source={notes} />}
            </div>
          </section>
        ) : null}
        <div className="about-actions">
          <button className="button primary" type="button" onClick={onClose} autoFocus>
            {t("aboutClose")}
          </button>
        </div>
      </div>
    </div>
  );
}
