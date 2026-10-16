import { Suspense, lazy } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { ChartLine, Gauge, type LucideIcon } from "lucide-react";
import { useI18n } from "../i18n";
import { PressureControlTool } from "../tools/PressureControlTool";

// The analysis tool parses whole recordings and draws its own charts; loaded
// on first open so it stays out of the bundle every other page downloads.
const RecordingAnalysisTool = lazy(() => import("../tools/analysis/RecordingAnalysisTool"));

interface ToolDescriptor {
  id: string;
  nameKey: string;
  descriptionKey: string;
  icon: LucideIcon;
  component: React.ComponentType;
}

const TOOL_REGISTRY: ToolDescriptor[] = [
  {
    id: "recording-analysis",
    nameKey: "toolAnalysisName",
    descriptionKey: "toolAnalysisDesc",
    icon: ChartLine,
    component: RecordingAnalysisTool,
  },
  {
    id: "pressure-control",
    nameKey: "pluginPressureControlName",
    descriptionKey: "pluginPressureControlDesc",
    icon: Gauge,
    component: PressureControlTool,
  },
];

export function ToolsPage() {
  const { toolId } = useParams<{ toolId?: string }>();
  const navigate = useNavigate();
  const { t } = useI18n();

  const active = toolId
    ? TOOL_REGISTRY.find((tool) => tool.id === toolId)
    : null;

  if (active) {
    const ToolComponent = active.component;
    const Icon = active.icon;
    return (
      <div className="plugin-page-container">
        <div className="plugin-page-header">
          <button
            className="button plugin-back-btn"
            type="button"
            onClick={() => navigate("/tools")}
          >
            ← {t("toolBack")}
          </button>
          <span className="plugin-page-title">
            <Icon size={18} strokeWidth={2} aria-hidden="true" />
            {t(active.nameKey)}
          </span>
        </div>
        <div className="plugin-page-body">
          <Suspense fallback={<p className="page-subtitle">{t("loading")}</p>}>
            <ToolComponent />
          </Suspense>
        </div>
      </div>
    );
  }

  return (
    <div className="plugins-list-page">
      <div className="page-header">
        <h1>{t("toolsTitle")}</h1>
        <p className="page-subtitle">{t("toolsSubtitle")}</p>
      </div>
      <div className="plugin-card-grid">
        {TOOL_REGISTRY.map((tool) => {
          const Icon = tool.icon;
          return (
            <button
              key={tool.id}
              className="plugin-card"
              type="button"
              onClick={() => navigate(`/tools/${tool.id}`)}
            >
              <div className="plugin-card-icon"><Icon size={28} strokeWidth={1.8} aria-hidden="true" /></div>
              <div className="plugin-card-name">{t(tool.nameKey)}</div>
              <div className="plugin-card-desc">{t(tool.descriptionKey)}</div>
              <div className="plugin-card-open">{t("toolOpen")} →</div>
            </button>
          );
        })}
      </div>
    </div>
  );
}
