import { useParams, useNavigate } from "react-router-dom";
import { useI18n } from "../i18n";
import { PressureControlPlugin } from "../plugins/PressureControlPlugin";

interface PluginDescriptor {
  id: string;
  nameKey: string;
  descriptionKey: string;
  icon: string;
  component: React.ComponentType;
}

const PLUGIN_REGISTRY: PluginDescriptor[] = [
  {
    id: "pressure-control",
    nameKey: "pluginPressureControlName",
    descriptionKey: "pluginPressureControlDesc",
    icon: "",
    component: PressureControlPlugin,
  },
];

export function PluginsPage() {
  const { pluginId } = useParams<{ pluginId?: string }>();
  const navigate = useNavigate();
  const { t } = useI18n();

  const active = pluginId
    ? PLUGIN_REGISTRY.find((p) => p.id === pluginId)
    : null;

  if (active) {
    const PluginComponent = active.component;
    return (
      <div className="plugin-page-container">
        <div className="plugin-page-header">
          <button
            className="button plugin-back-btn"
            type="button"
            onClick={() => navigate("/plugins")}
          >
            ← {t("pluginBack")}
          </button>
          <span className="plugin-page-title">
            {active.icon ? `${active.icon} ` : ""}{t(active.nameKey)}
          </span>
        </div>
        <div className="plugin-page-body">
          <PluginComponent />
        </div>
      </div>
    );
  }

  return (
    <div className="plugins-list-page">
      <div className="page-header">
        <h1>{t("pluginsTitle")}</h1>
        <p className="page-subtitle">{t("pluginsSubtitle")}</p>
      </div>
      <div className="plugin-card-grid">
        {PLUGIN_REGISTRY.map((plugin) => (
          <button
            key={plugin.id}
            className="plugin-card"
            type="button"
            onClick={() => navigate(`/plugins/${plugin.id}`)}
          >
            {plugin.icon && <div className="plugin-card-icon">{plugin.icon}</div>}
            <div className="plugin-card-name">{t(plugin.nameKey)}</div>
            <div className="plugin-card-desc">{t(plugin.descriptionKey)}</div>
            <div className="plugin-card-open">{t("pluginOpen")} →</div>
          </button>
        ))}
      </div>
    </div>
  );
}
