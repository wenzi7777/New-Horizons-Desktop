import { useCallback, useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { ChevronLeft, ChevronRight, RefreshCw, Search } from "lucide-react";
import { api, type DeviceEntry } from "../lib/api";
import { useDevicesPolling } from "../lib/device";
import {
  type AppCatalogEntry,
  categoriesOf,
  useLocalised,
} from "../lib/appLibrary";
import { Markdown } from "../components/Markdown";
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
          <span>{entry.author}</span>
          <span>v{entry.version}</span>
          <span className="app-card-minos">{t("appMinOs")} {entry.min_os}</span>
        </div>
      </div>
      <span className="app-card-get" aria-hidden="true">{t("appView")}</span>
    </button>
  );
}

function AppDetail({ entry, onBack, devices }: {
  entry: AppCatalogEntry;
  onBack: () => void;
  devices: DeviceEntry[];
}) {
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
      <button type="button" className="button ghost compact app-back" onClick={onBack}>
        <ChevronLeft size={16} strokeWidth={2} />
        {t("appStoreTitle")}
      </button>

      <div className="app-detail-hero">
        <AppIcon entry={entry} />
        <div className="app-detail-hero-text">
          <h2>{localised(entry.name)}</h2>
          <p className="app-detail-author">{entry.author}</p>
          <p className="app-detail-summary">{localised(entry.summary)}</p>
        </div>
      </div>

      <dl className="app-detail-facts">
        <div><dt>{t("appVersion")}</dt><dd>v{entry.version}</dd></div>
        <div><dt>{t("appMinOs")}</dt><dd>{entry.min_os}</dd></div>
        {typeof entry.estimated_us === "number"
          ? <div><dt>{t("appEstimatedCost")}</dt><dd>~{entry.estimated_us} µs</dd></div> : null}
        {typeof entry.nodes === "number"
          ? <div><dt>{t("appNodes")}</dt><dd>{entry.nodes}</dd></div> : null}
        <div><dt>{t("appSize")}</dt><dd>{entry.package.size} B</dd></div>
        {entry.category ? <div><dt>{t("appCategory")}</dt><dd>{entry.category}</dd></div> : null}
        {entry.license ? <div><dt>{t("appLicense")}</dt><dd>{entry.license}</dd></div> : null}
      </dl>

      {entry.capabilities?.length ? (
        <div className="app-detail-capabilities">
          <span>{t("appCapabilities")}</span>
          {entry.capabilities.map((name) => <span key={name} className="app-pill">{name}</span>)}
        </div>
      ) : null}

      <section className="app-detail-install">
        <h3>{t("appInstallPickDevice")}</h3>
        <ul className="app-group-list">
          {devices.map((device) => (
            <li key={device.device_uid}>
              <Link
                className="app-device-row"
                to={`/device/${encodeURIComponent(device.device_uid)}/apps?install=${encodeURIComponent(entry.id)}`}
              >
                <span className="app-device-name">
                  {device.display_name || device.device_name || device.device_uid}
                </span>
                <span className="app-mono">
                  {(device.display_name || device.device_name) &&
                   (device.display_name || device.device_name) !== device.device_uid
                    ? device.device_uid : ""}
                </span>
                <ChevronRight size={16} strokeWidth={2} aria-hidden="true" />
              </Link>
            </li>
          ))}
          {!devices.length ? <li className="app-empty">{t("appInstallNoDevices")}</li> : null}
        </ul>
      </section>

      {readme ? (
        <section className="app-detail-readme">
          <h3>{t("appReadme")}</h3>
          <Markdown source={readme} />
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

  const { devices } = useDevicesPolling();
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
        <button type="button" className="button ghost compact app-back" onClick={() => navigate("/apps")}>
          <ChevronLeft size={16} strokeWidth={2} />
          {t("appStoreTitle")}
        </button>
      </div>
    );
  }

  if (active) {
    return (
      <div className="app-store-page">
        <AppDetail entry={active} onBack={() => navigate("/apps")} devices={devices} />
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
        <button
          type="button"
          className="button ghost compact icon-button"
          onClick={() => void load(true)}
          disabled={status === "loading"}
          aria-label={t("appLibraryRefresh")}
          title={t("appLibraryRefresh")}
        >
          <RefreshCw size={15} strokeWidth={2} className={status === "loading" ? "spinning" : undefined} />
        </button>
      </header>

      {stale ? <p className="notice warning">{t("appLibraryStale")}</p> : null}
      {status === "error" ? (
        <p className="notice error">{t("appLibraryError")}{error ? `: ${error}` : ""}</p>
      ) : null}

      <div className="app-store-filters">
        <label className="app-search">
          <Search size={15} strokeWidth={2} aria-hidden="true" />
          <input
            type="search"
            value={query}
            placeholder={t("appLibrarySearch")}
            aria-label={t("appLibrarySearch")}
            onChange={(event) => setQuery(event.target.value)}
          />
        </label>
        {categories.length > 1 ? (
          <div className="app-category-chips" role="tablist" aria-label={t("appCategory")}>
            {[ALL_CATEGORIES, ...categories].map((name) => (
              <button
                key={name}
                type="button"
                role="tab"
                aria-selected={category === name}
                className={`app-chip${category === name ? " active" : ""}`}
                onClick={() => setCategory(name)}
              >
                {name === ALL_CATEGORIES ? t("appCategoryAll") : name}
              </button>
            ))}
          </div>
        ) : null}
      </div>

      {status === "loading" && !items.length ? (
        <div className="app-card-grid" aria-busy="true">
          {[0, 1, 2, 3].map((index) => <div key={index} className="app-card skeleton" />)}
        </div>
      ) : null}
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
