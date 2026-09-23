import { useMemo, useState } from "react";
import { Search } from "lucide-react";

import { useI18n } from "../../i18n";
import { functionDoc } from "../../lib/nhsLanguage";
import type { SdkKind } from "../../lib/sdkProject";
import {
  DEFAULT_BUDGET_US,
  FEATURE_FIELDS,
  LANGUAGE,
  LED_COLOURS,
  MAX_DEBOUNCE_MS,
  MAX_EVENT_NAME,
  MAX_NODES,
  MAX_OLED_DIGITS,
  MAX_OLED_LABEL,
  MAX_PACKAGE_BYTES,
  MAX_WINDOW,
  OLED_ROWS,
  OPS,
  WINDOW_POOL,
  readoutset,
} from "../../sdk/lib/index.mjs";

// Everything here is read from the SDK itself, so the reference cannot
// describe a language the compiler does not accept.

const STATEMENTS = [
  ["app", 'app <id> { name "…"  version 1.0.0  author you  summary "…" }'],
  ["region", "region <name> = rows <a>..<b>, cols <c>..<d>"],
  ["signal", "signal <name> = <expression>"],
  ["event", "event <name> when <expression> > <number> [hyst <n>] [for <n>ms]"],
  ["emit", "emit <name> value <expression> on rise(<event>)"],
  ["led", "led <colour> when <event>"],
  ["show", 'show <row> "<label>" <expression> [digits <n>]'],
  ["bar", 'bar <row> "<label>" <expression> range <lo>..<hi>'],
  ["gate", "gate (<expression> < <number>) { signal / event / emit / led / show / bar … }"],
] as const;

export function ReferencePanel({ kind }: { kind: SdkKind }) {
  const { t } = useI18n();
  const [query, setQuery] = useState("");
  const needle = query.trim().toLowerCase();
  const match = (...texts: string[]) => !needle || texts.some((text) => text.toLowerCase().includes(needle));

  const functions = useMemo(() => LANGUAGE.functions.map((name) => ({ name, ...functionDoc(name) })), []);
  const ops = useMemo(() => Object.values(OPS), []);

  const limits: [string, string][] = [
    [t("sdkLimitNodes"), String(MAX_NODES)],
    [t("sdkLimitBudget"), `${DEFAULT_BUDGET_US} µs`],
    [t("sdkLimitWindow"), `${MAX_WINDOW}`],
    [t("sdkLimitPool"), `${WINDOW_POOL}`],
    [t("sdkLimitEvent"), `${MAX_EVENT_NAME}`],
    [t("sdkLimitDebounce"), `${MAX_DEBOUNCE_MS} ms`],
    [t("sdkLimitPackage"), `${MAX_PACKAGE_BYTES} B`],
    [t("sdkLimitOledRows"), `0–${OLED_ROWS - 1}`],
    [t("sdkLimitOledLabel"), `${MAX_OLED_LABEL}`],
    [t("sdkLimitOledDigits"), `0–${MAX_OLED_DIGITS}`],
  ];

  return (
    <div className="sdk-panel-body">
      <label className="app-search sdk-reference-search">
        <Search size={15} strokeWidth={2} aria-hidden="true" />
        <input type="search" value={query} placeholder={t("sdkReferenceSearch")} aria-label={t("sdkReferenceSearch")} onChange={(event) => setQuery(event.target.value)} />
      </label>

      {kind === "flow" ? (
        <>
          <section className="sdk-section">
            <h3>{t("sdkRefStatements")}</h3>
            <div className="sdk-ref-list">
              {STATEMENTS.filter(([name, form]) => match(name, form)).map(([name, form]) => (
                <code key={name} className="sdk-ref-form">{form}</code>
              ))}
            </div>
            <p className="sdk-hint">{t("sdkRefComparisonNote")}</p>
          </section>

          <section className="sdk-section">
            <h3>{t("sdkRefFunctions")}</h3>
            <table className="sdk-table">
              <tbody>
                {functions.filter((fn) => match(fn.name, fn.info ?? "")).map((fn) => (
                  <tr key={fn.name}>
                    <td className="sdk-mono sdk-nowrap">{fn.name}{fn.args}</td>
                    <td>{fn.info}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>

          <section className="sdk-section">
            <h3>{t("sdkRefValues")}</h3>
            <dl className="sdk-facts">
              <div><dt>{t("sdkRefFeatureFields")}</dt><dd className="sdk-chips">{FEATURE_FIELDS.map((f) => <span key={f} className="sdk-chip sdk-mono">{f}</span>)}</dd></div>
              <div><dt>{t("sdkRefColours")}</dt><dd className="sdk-chips">{Object.entries(LED_COLOURS).map(([name, [r, g, b]]) => (
                <span key={name} className="sdk-chip"><i className="sdk-swatch" style={{ background: `rgb(${r}, ${g}, ${b})` }} />{name}</span>
              ))}</dd></div>
            </dl>
          </section>

          <section className="sdk-section">
            <h3>{t("sdkRefOps")}</h3>
            <p className="sdk-hint">{t("sdkRefOpsHint")}</p>
            <table className="sdk-table">
              <thead>
                <tr><th>{t("sdkOp")}</th><th>{t("sdkRefCost")}</th><th>{t("sdkMinOs")}</th><th /></tr>
              </thead>
              <tbody>
                {ops.filter((op) => match(op.name, op.summary)).map((op) => (
                  <tr key={op.name}>
                    <td className="sdk-mono sdk-nowrap">{op.name}</td>
                    <td className="sdk-mono sdk-nowrap">{op.sweep ? `${op.nsPerCell} ns/cell` : `${op.nsFlat} ns`}</td>
                    <td className="sdk-mono">{op.since}</td>
                    <td>{op.summary}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
        </>
      ) : (
        <>
          <section className="sdk-section">
            <h3>{t("sdkRefSources")}</h3>
            <p className="sdk-hint">{t("sdkRefSourcesHint")}</p>
            <div className="sdk-chips">{[...readoutset.ALLOWED_SOURCES].filter((s) => match(s)).map((s) => <span key={s} className="sdk-chip sdk-mono">{s}</span>)}</div>
          </section>
          <section className="sdk-section">
            <h3>{t("sdkRefFormats")}</h3>
            <div className="sdk-chips">{[...readoutset.FORMATS].map((f) => <span key={f} className="sdk-chip sdk-mono">{f}</span>)}</div>
          </section>
          <section className="sdk-section">
            <h3>{t("sdkRefSections")}</h3>
            <div className="sdk-ref-list">
              <code className="sdk-ref-form">{'{ "kind": "stats", "title": "…", "items": [{ "label", "source", "field", "format", "hint" }] }'}</code>
              <code className="sdk-ref-form">{'{ "kind": "table", "title": "…", "source": "…", "columns": [{ "label", "field", "format", "bar", "bar_max" }] }'}</code>
            </div>
          </section>
        </>
      )}

      <section className="sdk-section">
        <h3>{t("sdkLimits")}</h3>
        <dl className="sdk-facts">
          {limits.filter(([label]) => match(label)).map(([label, value]) => (
            <div key={label}><dt>{label}</dt><dd className="sdk-mono">{value}</dd></div>
          ))}
        </dl>
      </section>
    </div>
  );
}
