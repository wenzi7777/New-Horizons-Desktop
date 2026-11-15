import { useI18n } from "../../i18n";
import {
  type AppResources,
  type DeviceApp,
  formatBytes,
  formatCpu,
  moreThatFit,
} from "../../lib/deviceApps";

/**
 * What the running apps take of the device, the way a phone's "running
 * services" screen shows memory: one bar per resource, a segment per app, in
 * the app's colour, and what is left.
 *
 * Memory is the app pool (firmware v2.1.0). Time is the apps' live CPU, ~10 s,
 * against what the governor lets the apps have at most (`ceilingPermille` of
 * the loop): measured, not estimated -- estimates only decide admission.
 */
export function AppResourceBar({
  running,
  resources,
  cpuByApp,
  ceilingPermille,
  colourOf,
}: {
  running: DeviceApp[];
  resources: AppResources | null;
  /** Live cpu10 (permille of wall time) by app id. */
  cpuByApp: Map<string, number>;
  ceilingPermille: number;
  colourOf: (id: string) => number;
}) {
  const { t } = useI18n();
  if (!resources) return null;
  const poolBytes = Math.max(1, resources.poolBytes);
  const ceiling = Math.max(1, ceilingPermille);
  const cpuTotal = running.reduce((sum, app) => sum + (cpuByApp.get(app.id) ?? 0), 0);
  const typical =
    running.length > 0
      ? Math.round(running.reduce((sum, app) => sum + app.memoryBytes, 0) / running.length)
      : 0;
  const more = moreThatFit(resources, typical);

  return (
    <div className="apps-resources" aria-label={t("appsResources")}>
      <div className="apps-resource">
        <div className="apps-resource-caption">
          <span>{t("appsMemory")}</span>
          <span className="apps-resource-value">
            {formatBytes(resources.poolUsed)} / {formatBytes(resources.poolBytes)}
          </span>
        </div>
        <div className="apps-resource-track" role="img"
             aria-label={`${formatBytes(resources.poolUsed)} / ${formatBytes(resources.poolBytes)}`}>
          {running.map((app) => (
            <span
              key={app.id}
              className={`apps-resource-segment apps-colour-${colourOf(app.id)}`}
              style={{ width: `${(app.memoryBytes / poolBytes) * 100}%` }}
              title={`${app.name}: ${formatBytes(app.memoryBytes)}`}
            />
          ))}
        </div>
      </div>

      <div className="apps-resource">
        <div className="apps-resource-caption">
          <span>{t("appsCpu")}</span>
          <span className="apps-resource-value">
            {formatCpu(cpuTotal)} / {formatCpu(ceiling)}
          </span>
        </div>
        <div className="apps-resource-track" role="img" aria-label={`${formatCpu(cpuTotal)} / ${formatCpu(ceiling)}`}>
          {running.map((app) => {
            const cpu = cpuByApp.get(app.id) ?? 0;
            return cpu > 0 ? (
              <span
                key={app.id}
                className={`apps-resource-segment apps-colour-${colourOf(app.id)}`}
                style={{ width: `${Math.min(100, (cpu / ceiling) * 100)}%` }}
                title={`${app.name}: ${formatCpu(cpu)}`}
              />
            ) : null;
          })}
        </div>
      </div>

      {running.length ? (
        <ul className="apps-resource-legend">
          {running.map((app) => (
            <li key={app.id}>
              <i className={`apps-colour-${colourOf(app.id)}`} aria-hidden="true" />
              {app.name}
            </li>
          ))}
        </ul>
      ) : null}

      <p className="apps-resource-note">
        {more !== null
          ? t("appsMoreFit").replace("{count}", String(more)).replace("{size}", formatBytes(typical))
          : t("appsPoolFree").replace("{free}", formatBytes(resources.poolFree))}
      </p>
    </div>
  );
}
