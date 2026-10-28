import { useState, type FormEvent } from "react";

import { useI18n } from "../i18n";
import { useAuth } from "../lib/auth";
import { LAB_NAME, LAB_URL, UNIVERSITY_URL } from "../components/AboutDialog";

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
      <footer className="login-credit">
        <a href={LAB_URL} target="_blank" rel="noreferrer">{LAB_NAME}</a>
        <span aria-hidden="true">·</span>
        <a href={UNIVERSITY_URL} target="_blank" rel="noreferrer">{t("aboutUniversity")}</a>
      </footer>
    </main>
  );
}
