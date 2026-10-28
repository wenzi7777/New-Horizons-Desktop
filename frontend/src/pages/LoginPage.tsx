import { useState, type FormEvent } from "react";

import { useI18n } from "../i18n";
import { useAuth } from "../lib/auth";
import { LAB_NAME } from "../components/AboutDialog";

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
      {/* The lab and university, at the foot of the page. */}
      <div className="login-backdrop" aria-hidden="true">
        <span className="login-backdrop-credit">
          {LAB_NAME}
          <br />
          {t("aboutUniversity")}
        </span>
      </div>
      <section className="login-panel">
        <form className="login-form" onSubmit={handleSubmit}>
          <div className="login-heading">
            <span>NH Console</span>
            <h1>{t("loginTitle")}</h1>
          </div>
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
        </form>
      </section>
    </main>
  );
}
