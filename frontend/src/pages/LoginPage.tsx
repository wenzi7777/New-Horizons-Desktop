import { useState, type FormEvent } from "react";

import { useI18n } from "../i18n";
import { useAuth } from "../lib/auth";

export function LoginPage() {
  const { t } = useI18n();
  const { login, loginError } = useAuth();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submitting) return;
    setSubmitting(true);
    try {
      await login(username, password);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <main className="login-shell">
      <section className="login-panel">
        <div className="login-copy">
          <h1>{t("loginTitle")}</h1>
          <p>{t("loginCopy")}</p>
        </div>
        <form className="login-form" onSubmit={handleSubmit}>
          <label className="field">
            <span>{t("loginUsername")}</span>
            <input value={username} onChange={(event) => setUsername(event.target.value)} autoComplete="username" />
          </label>
          <label className="field">
            <span>{t("loginPassword")}</span>
            <input
              type="password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              autoComplete="current-password"
            />
          </label>
          {loginError ? <p className="notice error">{loginError}</p> : null}
          <button className="button primary" type="submit" disabled={submitting}>
            {submitting ? t("loggingIn") : t("loginAction")}
          </button>
          <p className="login-help">{t("loginContactAdmin")}</p>
        </form>
      </section>
    </main>
  );
}
