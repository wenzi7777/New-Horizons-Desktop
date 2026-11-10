import { useCallback, useEffect, useState, type FormEvent } from "react";

import { ConfirmModal } from "./ConfirmModal";
import { Select } from "./Select";
import { useI18n } from "../i18n";
import { api, type AppTokenEntry } from "../lib/api";
import { copyText } from "../lib/clipboard";
import { relayDisplayName } from "../lib/relayKind";

function formatTime(ms: number | null, never: string) {
  return ms ? new Date(ms).toLocaleString() : never;
}

// The tokens NH Studio / NH Pocket sign in with: one per app install, made
// here by an admin. The token is shown once, right after it is made; the
// server keeps only its hash.
export function AppTokensPanel() {
  const { t } = useI18n();
  const [items, setItems] = useState<AppTokenEntry[]>([]);
  const [name, setName] = useState("");
  const [clientType, setClientType] = useState<"studio" | "pocket">("studio");
  const [role, setRole] = useState<"admin" | "user">("admin");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [created, setCreated] = useState<{ token: string; item: AppTokenEntry } | null>(null);
  const [copied, setCopied] = useState(false);
  const [confirmRevoke, setConfirmRevoke] = useState<AppTokenEntry | null>(null);

  const reload = useCallback(async () => {
    try {
      setItems((await api.appTokens()).items);
    } catch (err) {
      setError(`${t("appTokenError")} ${err instanceof Error ? err.message : String(err)}`);
    }
  }, [t]);

  useEffect(() => {
    void reload();
  }, [reload]);

  async function create(event: FormEvent) {
    event.preventDefault();
    if (!name.trim()) return;
    setBusy(true);
    setError("");
    setCopied(false);
    try {
      const result = await api.createAppToken(name.trim(), clientType, role);
      setCreated({ token: result.token, item: result.item });
      setName("");
      await reload();
    } catch (err) {
      setError(`${t("appTokenError")} ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setBusy(false);
    }
  }

  async function revoke(item: AppTokenEntry) {
    setError("");
    try {
      await api.revokeAppToken(item.id);
      if (created?.item.id === item.id) setCreated(null);
      await reload();
    } catch (err) {
      setError(`${t("appTokenError")} ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  async function copyCreated() {
    if (!created) return;
    try {
      await copyText(created.token);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  }

  return (
    <section className="gateway-tools panel app-tokens-panel">
      <div className="gateway-tools-copy">
        <h3>{t("appTokensTitle")}</h3>
        <p>{t("appTokensCopy")}</p>
      </div>

      <form className="app-token-form" onSubmit={create}>
        <label>
          <span>{t("appTokenName")}</span>
          <input
            value={name}
            maxLength={64}
            placeholder={t("appTokenNamePlaceholder")}
            onChange={(event) => setName(event.target.value)}
          />
        </label>
        <label>
          <span>{t("appTokenType")}</span>
          <Select value={clientType} onChange={(event) => setClientType(event.target.value === "pocket" ? "pocket" : "studio")}>
            <option value="studio">NH Studio</option>
            <option value="pocket">NH Pocket</option>
          </Select>
        </label>
        <label>
          <span>{t("appTokenRole")}</span>
          <Select value={role} onChange={(event) => setRole(event.target.value === "user" ? "user" : "admin")}>
            <option value="admin">{t("appTokenRoleAdmin")}</option>
            <option value="user">{t("appTokenRoleUser")}</option>
          </Select>
        </label>
        <button className="button primary" type="submit" disabled={busy || !name.trim()}>
          {t("appTokenCreate")}
        </button>
      </form>

      {error ? <p className="notice error">{error}</p> : null}
      {created ? (
        <div className="notice success app-token-created">
          <p>{t("appTokenCreated")}</p>
          <div className="app-token-secret">
            <code>{created.token}</code>
            <button className="button compact" type="button" onClick={() => void copyCreated()}>
              {copied ? t("appTokenCopied") : t("appTokenCopy")}
            </button>
          </div>
        </div>
      ) : null}

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
