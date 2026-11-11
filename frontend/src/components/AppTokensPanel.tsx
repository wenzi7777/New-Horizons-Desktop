import { useCallback, useEffect, useState } from "react";

import { ConfirmModal } from "./ConfirmModal";
import { useI18n } from "../i18n";
import { api, type AppTokenEntry } from "../lib/api";
import { relayDisplayName } from "../lib/relayKind";

function formatTime(ms: number | null, never: string) {
  return ms ? new Date(ms).toLocaleString() : never;
}

// The apps signed in to this Backend: NH Studio / NH Pocket sign in with a
// Desktop account (POST /api/app-tokens/login), each sign-in one entry here.
// An admin can only revoke them; nothing is created from this page.
export function AppTokensPanel() {
  const { t } = useI18n();
  const [items, setItems] = useState<AppTokenEntry[]>([]);
  const [error, setError] = useState("");
  const [confirmRevoke, setConfirmRevoke] = useState<AppTokenEntry | null>(null);

  const reload = useCallback(async () => {
    try {
      setItems((await api.appTokens()).items);
      setError("");
    } catch (err) {
      setError(`${t("appTokenError")} ${err instanceof Error ? err.message : String(err)}`);
    }
  }, [t]);

  useEffect(() => {
    void reload();
  }, [reload]);

  async function revoke(item: AppTokenEntry) {
    setError("");
    try {
      await api.revokeAppToken(item.id);
      await reload();
    } catch (err) {
      setError(`${t("appTokenError")} ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return (
    <section className="gateway-tools panel app-tokens-panel">
      <div className="gateway-tools-copy">
        <h3>{t("appTokensTitle")}</h3>
        <p>{t("appTokensCopy")}</p>
      </div>

      {error ? <p className="notice error">{error}</p> : null}
      {items.length ? (
        <ul className="app-token-list">
          {items.map((item) => (
            <li key={item.id} className={item.active ? "" : "revoked"}>
              <div className="app-token-main">
                <strong>{item.name}</strong>
                <span className="relay-badge">{relayDisplayName(item)}</span>
                <span className="relay-badge">{item.role === "user" ? t("appTokenRoleUser") : t("appTokenRoleAdmin")}</span>
                {item.active ? null : <span className="relay-badge muted">{t("appTokenRevoked")}</span>}
              </div>
              <small className="mono">{item.token_hint}</small>
              <small>
                {t("appTokenCreatedAt")}: {formatTime(item.created_at_ms, t("appTokenNever"))} · {t("appTokenLastUsed")}:{" "}
                {formatTime(item.last_used_at_ms, t("appTokenNever"))}
              </small>
              {item.active ? (
                <button className="button danger compact" type="button" onClick={() => setConfirmRevoke(item)}>
                  {t("appTokenRevoke")}
                </button>
              ) : null}
            </li>
          ))}
        </ul>
      ) : (
        <p className="page-copy">{t("appTokenNone")}</p>
      )}

      {confirmRevoke ? (
        <ConfirmModal
          title={t("appTokenRevokeConfirm")}
          message={`${confirmRevoke.name} (${relayDisplayName(confirmRevoke)}) — ${t("appTokenRevokeCopy")}`}
          confirmLabel={t("appTokenRevoke")}
          cancelLabel={t("cancel")}
          destructive
          onConfirm={() => {
            const item = confirmRevoke;
            setConfirmRevoke(null);
            void revoke(item);
          }}
          onCancel={() => setConfirmRevoke(null)}
        />
      ) : null}
    </section>
  );
}
