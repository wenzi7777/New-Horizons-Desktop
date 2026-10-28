import { useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";

import { useI18n, type Locale } from "../i18n";
import { DeviceWikiPage, renderMarkdown } from "./DeviceWikiPage";

// The Desktop guide ships with the app: src/manual/<locale>/NN-slug.md, one
// chapter per file, ordered by the number. Each chapter is its own chunk.
const CHAPTER_LOADERS = import.meta.glob<string>("../manual/*/*.md", { query: "?raw", import: "default" });

type Chapter = { slug: string; load: () => Promise<string> };

function chaptersFor(locale: Locale): Chapter[] {
  const prefix = `../manual/${locale}/`;
  return Object.entries(CHAPTER_LOADERS)
    .filter(([path]) => path.startsWith(prefix))
    .map(([path, load]) => ({ slug: path.slice(prefix.length, -".md".length), load }))
    .sort((a, b) => a.slug.localeCompare(b.slug));
}

// Chapter titles come from each file's "# " line; loading them all up front
// is cheap (a few KB) and keeps the list in the file's own words.
function titleOf(source: string, fallback: string) {
  const match = /^#\s+(.+)$/m.exec(source);
  return match ? match[1].trim() : fallback;
}

function DesktopGuide() {
  const { locale } = useI18n();
  const chapters = useMemo(() => {
    const own = chaptersFor(locale);
    return own.length ? own : chaptersFor("en");
  }, [locale]);
  const [sources, setSources] = useState<Record<string, string>>({});
  const [selected, setSelected] = useState("");

  useEffect(() => {
    let cancelled = false;
    setSources({});
    Promise.all(chapters.map(async (chapter) => [chapter.slug, await chapter.load()] as const)).then((loaded) => {
      if (!cancelled) setSources(Object.fromEntries(loaded));
    });
    return () => {
      cancelled = true;
    };
  }, [chapters]);

  const current = chapters.some((chapter) => chapter.slug === selected) ? selected : chapters[0]?.slug ?? "";
  const source = sources[current];

  return (
    <section className="manual-workspace">
      <nav className="panel manual-chapters">
        {chapters.map((chapter, index) => (
          <button
            key={chapter.slug}
            className={chapter.slug === current ? "manual-chapter active" : "manual-chapter"}
            type="button"
            onClick={() => setSelected(chapter.slug)}
          >
            <span className="manual-chapter-number">{index + 1}</span>
            <span>{titleOf(sources[chapter.slug] ?? "", chapter.slug.replace(/^\d+-/, ""))}</span>
          </button>
        ))}
      </nav>
      <article className="panel wiki-preview-panel">
        <div className="wiki-preview-content">{source === undefined ? null : renderMarkdown(source)}</div>
      </article>
    </section>
  );
}

export function ManualPage() {
  const { t } = useI18n();
  const [params, setParams] = useSearchParams();
  const tab = params.get("tab") === "wiki" ? "wiki" : "guide";

  return (
    <>
      <section className="page-header">
        <div>
          <h2>{t("manualTitle")}</h2>
          <p className="page-copy">{t("manualCopy")}</p>
        </div>
        <div className="segmented-control manual-tabs" role="tablist">
          <button
            type="button"
            role="tab"
            aria-selected={tab === "guide"}
            className={tab === "guide" ? "active" : ""}
            onClick={() => setParams({}, { replace: true })}
          >
            {t("manualGuide")}
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={tab === "wiki"}
            className={tab === "wiki" ? "active" : ""}
            onClick={() => setParams({ tab: "wiki" }, { replace: true })}
          >
            {t("manualWiki")}
          </button>
        </div>
      </section>
      {tab === "guide" ? <DesktopGuide /> : <DeviceWikiPage embedded />}
    </>
  );
}
