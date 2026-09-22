import { useCallback, useEffect, useMemo, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { api } from "../lib/api";
import {
  type AppCatalogEntry,
  categoriesOf,
  useLocalised,
} from "../lib/appLibrary";
import { useI18n } from "../i18n";

const ALL_CATEGORIES = "__all__";

function AppIcon({ entry }: { entry: AppCatalogEntry }) {
  const [failed, setFailed] = useState(false);
  if (!entry.icon_url || failed) {
    return <div className="app-card-icon app-card-icon-fallback" aria-hidden="true" />;
  }
  return (
    <img
      className="app-card-icon"
      src={entry.icon_url}
      alt=""
      loading="lazy"
      onError={() => setFailed(true)}
    />
  );
}

function AppCard({ entry, onOpen }: { entry: AppCatalogEntry; onOpen: () => void }) {
  const { t } = useI18n();
  const localised = useLocalised();
  return (
    <button type="button" className="app-card" onClick={onOpen}>
      <AppIcon entry={entry} />
      <div className="app-card-body">
        <div className="app-card-title">{localised(entry.name)}</div>
        <div className="app-card-summary">{localised(entry.summary)}</div>
        <div className="app-card-meta">
          <span>v{entry.version}</span>
          <span>{entry.author}</span>
          <span className="app-card-minos">{t("appMinOs")} {entry.min_os}</span>
        </div>
      </div>
    </button>
  );
}

function AppDetail({ entry, onBack }: { entry: AppCatalogEntry; onBack: () => void }) {
  const { t, locale } = useI18n();
  const localised = useLocalised();
  const [readme, setReadme] = useState<string | null>(null);

  useEffect(() => {
    const url = entry.readme_url?.[locale] || entry.readme_url?.en;
    if (!url) {
      setReadme(null);
      return;
    }
    let cancelled = false;
    // The README lives in the library repo, not behind our API -- the OTA
    // changelog is fetched the same way.
    fetch(url)
      .then((response) => (response.ok ? response.text() : null))
      .then((text) => {
        if (!cancelled) setReadme(text);
      })
      .catch(() => {
        if (!cancelled) setReadme(null);
      });
    return () => {
      cancelled = true;
    };
  }, [entry, locale]);

  return (
    <div className="app-detail">
      <div className="app-detail-header">
        <button type="button" className="button" onClick={onBack}>
          ← {t("appStoreTitle")}
        </button>
      </div>
      <div className="app-detail-hero">
        <AppIcon entry={entry} />
        <div>
          <h2>{localised(entry.name)}</h2>
          <p className="app-detail-summary">{localised(entry.summary)}</p>
        </div>
      </div>

      <dl className="app-detail-facts">
        <div><dt>{t("appVersion")}</dt><dd>v{entry.version}</dd></div>
        <div><dt>{t("appAuthor")}</dt><dd>{entry.author}</dd></div>
        <div><dt>{t("appMinOs")}</dt><dd>{entry.min_os}</dd></div>
        {entry.license ? <div><dt>{t("appLicense")}</dt><dd>{entry.license}</dd></div> : null}
        {entry.category ? <div><dt>{t("appCategory")}</dt><dd>{entry.category}</dd></div> : null}
        {typeof entry.nodes === "number"
          ? <div><dt>{t("appNodes")}</dt><dd>{entry.nodes}</dd></div> : null}
        {typeof entry.estimated_us === "number"
          ? <div><dt>{t("appEstimatedCost")}</dt><dd>~{entry.estimated_us} µs</dd></div> : null}
        <div><dt>{t("appSize")}</dt><dd>{entry.package.size} B</dd></div>
        {entry.capabilities?.length
          ? <div><dt>{t("appCapabilities")}</dt><dd>{entry.capabilities.join(", ")}</dd></div>
          : null}
      </dl>

      <p className="app-detail-install-hint">{t("appInstallComingSoon")}</p>

      {readme ? (
        <section className="app-detail-readme">
          <h3>{t("appReadme")}</h3>
          <pre>{readme}</pre>
        </section>
      ) : null}
    </div>
  );
}

export function AppStorePage() {
  const { appId } = useParams<{ appId?: string }>();
  const navigate = useNavigate();
  const { t } = useI18n();
  const localised = useLocalised();

  const [items, setItems] = useState<AppCatalogEntry[]>([]);
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const [stale, setStale] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [category, setCategory] = useState(ALL_CATEGORIES);
  const [query, setQuery] = useState("");

  const load = useCallback(async (refresh = false) => {
    setStatus("loading");
    try {
      const catalog = await api.appLibraryIndex(refresh);
      setItems(catalog.items || []);
      setStale(Boolean(catalog.stale));
      setError(catalog.error || null);
      setStatus("ready");
    } catch (err) {
      setError(err instanceof Error ? err.message : "request_failed");
      setStatus("error");
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const categories = useMemo(() => categoriesOf(items), [items]);
  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return items.filter((entry) => {
      if (category !== ALL_CATEGORIES && (entry.category || "other") !== category) return false;
      if (!needle) return true;
      return [entry.id, entry.author, localised(entry.name), localised(entry.summary)]
        .join(" ")
        .toLowerCase()
        .includes(needle);
    });
  }, [items, category, query, localised]);

  const active = appId ? items.find((entry) => entry.id === appId) : null;

  if (appId && status === "ready" && !active) {
    return (
      <div className="app-store-page">
        <p className="notice error">{t("appNotFound")}</p>
        <button type="button" className="button" onClick={() => navigate("/apps")}>
          ← {t("appStoreTitle")}
        </button>
      </div>
    );
  }

  if (active) {
    return (
      <div className="app-store-page">
        <AppDetail entry={active} onBack={() => navigate("/apps")} />
      </div>
    );
  }

  return (
    <div className="app-store-page">
      <header className="app-store-header">
        <div>
          <h1>{t("appStoreTitle")}</h1>
          <p className="app-store-subtitle">{t("appStoreSubtitle")}</p>
        </div>
        <button type="button" className="button" onClick={() => void load(true)}>
          {t("appLibraryRefresh")}
        </button>
      </header>

      {stale ? <p className="notice warning">{t("appLibraryStale")}</p> : null}
      {status === "error" ? (
        <p className="notice error">{t("appLibraryError")}{error ? `: ${error}` : ""}</p>
      ) : null}

      <div className="app-store-filters">
        <input
          type="search"
          value={query}
          placeholder={t("appLibrarySearch")}
          onChange={(event) => setQuery(event.target.value)}
        />
        <select value={category} onChange={(event) => setCategory(event.target.value)}>
          <option value={ALL_CATEGORIES}>{t("appCategoryAll")}</option>
          {categories.map((name) => (
            <option key={name} value={name}>{name}</option>
          ))}
        </select>
      </div>

      {status === "loading" && !items.length ? <p>{t("loading")}</p> : null}
      {status !== "loading" && !visible.length ? (
        <p className="app-store-empty">{t("appLibraryEmpty")}</p>
      ) : null}

      <div className="app-card-grid">
        {visible.map((entry) => (
          <AppCard
            key={entry.id}
            entry={entry}
            onOpen={() => navigate(`/apps/${encodeURIComponent(entry.id)}`)}
          />
        ))}
      </div>
    </div>
  );
}
