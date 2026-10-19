import type { ReactNode } from "react";

// Building blocks shared by the Diagnostics cards (DeviceHealthCard,
// ScanHealthCard): a row of headline numbers, then grouped label/value lists.

export type HealthTone = "neutral" | "good" | "warn" | "bad";

export function HealthSummary({ children }: { children: ReactNode }) {
  return <div className="health-summary">{children}</div>;
}

export function HealthStat({
  label,
  value,
  sub,
  tone = "neutral",
}: {
  label: string;
  value: string;
  sub?: string;
  tone?: HealthTone;
}) {
  return (
    <div className={`health-stat tone-${tone}`}>
      <div className="health-stat-label">{label}</div>
      <div className="health-stat-value">{value}</div>
      {sub ? <div className="health-stat-sub">{sub}</div> : null}
    </div>
  );
}

export function HealthGroups({ children }: { children: ReactNode }) {
  return <div className="health-groups">{children}</div>;
}

export function HealthGroup({ title, children, footnote }: { title: string; children: ReactNode; footnote?: ReactNode }) {
  return (
    <section className="health-group">
      <h5 className="health-group-heading">{title}</h5>
      <div className="health-rows">{children}</div>
      {footnote ? <p className="health-group-footnote">{footnote}</p> : null}
    </section>
  );
}

export function HealthRow({
  label,
  value,
  hint,
  tone = "neutral",
}: {
  label: string;
  value: ReactNode;
  hint?: string;
  tone?: HealthTone;
}) {
  return (
    <div className={`health-row tone-${tone}`}>
      <div className="health-row-label">
        <span>{label}</span>
        {hint ? <small>{hint}</small> : null}
      </div>
      <div className="health-row-value">{value}</div>
    </div>
  );
}

export function HealthCallout({ tone, title, items }: { tone: HealthTone; title: string; items: string[] }) {
  return (
    <div className={`health-callout tone-${tone}`} role="status">
      <strong>{title}</strong>
      <ul>
        {items.map((item) => (
          <li key={item}>{item}</li>
        ))}
      </ul>
    </div>
  );
}

export function HealthBars({ rows }: { rows: { label: string; share: number; value: string }[] }) {
  return (
    <div className="health-bars">
      {rows.map((row) => (
        <div className="health-bar-row" key={row.label}>
          <span className="health-bar-label">{row.label}</span>
          <span className="health-bar-track">
            {/* A non-zero bucket stays visible even when it is a sliver. */}
            <span
              className="health-bar-fill"
              style={{ width: row.share > 0 ? `max(3px, ${(row.share * 100).toFixed(2)}%)` : "0" }}
            />
          </span>
          <span className="health-bar-value">{row.value}</span>
        </div>
      ))}
    </div>
  );
}

export function formatCount(value: unknown): string {
  return typeof value === "number" && Number.isFinite(value) ? value.toLocaleString() : "-";
}

export function formatPercent(share: number): string {
  if (share === 0) return "0%";
  if (share < 0.001) return "<0.1%";
  return `${(share * 100).toFixed(share < 0.1 ? 1 : 0)}%`;
}
