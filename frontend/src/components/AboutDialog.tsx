import { useEffect, useState } from "react";

import { useI18n } from "../i18n";
import { groupNotesByVersion, pickNotes } from "../lib/releaseNotes";
import { compareVersions } from "../lib/versioning";
import { Markdown } from "./Markdown";
import { UAizuLogo } from "./UAizuLogo";
import { Select } from "./Select";

export const LAB_NAME = "Human Intelligent Sensing Lab";
export const LAB_URL = "https://isensing.u-aizu.ac.jp/";
export const UNIVERSITY_URL = "https://u-aizu.ac.jp/";

// Release notes are the repo's notes/vX.Y.Z.md (plus .ja.md / .en.md
// translations), one lazy chunk each so the changelog costs nothing until
// someone opens it.
const NOTE_LOADERS = import.meta.glob<string>("../../../notes/v*.md", { query: "?raw", import: "default" });
const NOTES = [
  ...groupNotesByVersion(
    Object.entries(NOTE_LOADERS).map(([path, load]) => ({ name: path.slice(path.lastIndexOf("/") + 1), value: load })),
  ),
]
  .map(([version, loaders]) => ({ version, loaders }))
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
  const { t, locale } = useI18n();
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
    const load = note ? pickNotes(note.loaders, locale) : undefined;
    if (!load) return undefined;
    let cancelled = false;
    setNotes(null);
    load().then((source) => {
      if (!cancelled) setNotes(stripTitle(source));
    });
    return () => {
      cancelled = true;
    };
  }, [selected, locale]);

  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true" aria-labelledby="about-title" onClick={onClose}>
      <div className="modal-panel about-panel" onClick={(e) => e.stopPropagation()}>
        <div className="about-product">
          <h3 id="about-title">NH Console</h3>
          <small>{version}</small>
        </div>
        {NOTES.length > 0 ? (
          <section className="about-changelog" aria-labelledby="about-changelog-title">
            <div className="about-changelog-head">
              <h4 id="about-changelog-title">{t("aboutChangelog")}</h4>
              <Select value={selected} onChange={(e) => setSelected(e.target.value)} aria-label={t("aboutChangelogVersion")}>
                {NOTES.map((note) => (
                  <option key={note.version} value={note.version}>
                    {note.version}
                    {note.version === version ? ` (${t("aboutCurrentVersion")})` : ""}
                  </option>
                ))}
              </Select>
            </div>
            <div className="about-changelog-body">
              {notes === null ? <p className="about-changelog-loading">…</p> : <Markdown source={notes} />}
            </div>
          </section>
        ) : null}
        <div className="about-credits">
          <a className="about-lab" href={LAB_URL} target="_blank" rel="noreferrer">{LAB_NAME}</a>
          <a className="about-university" href={UNIVERSITY_URL} target="_blank" rel="noreferrer">
            <UAizuLogo className="about-uaizu-logo" title={t("aboutUniversity")} />
            <span>{t("aboutUniversity")}</span>
          </a>
        </div>
        <div className="about-actions">
          <button className="button primary" type="button" onClick={onClose} autoFocus>
            {t("aboutClose")}
          </button>
        </div>
      </div>
    </div>
  );
}
