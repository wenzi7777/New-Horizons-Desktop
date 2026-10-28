import { useState } from "react";

import { useI18n } from "../i18n";
import { Markdown } from "./Markdown";

// A release's notes (the changelog_url an update check reports), fetched on
// demand and rendered as Markdown under a show/hide button.
export function ChangelogPanel({ url }: { url: string }) {
  const { t } = useI18n();
  const [visible, setVisible] = useState(false);
  const [loading, setLoading] = useState(false);
  const [body, setBody] = useState("");
  const [error, setError] = useState("");

  async function toggle() {
    if (visible) {
      setVisible(false);
      return;
    }
    setVisible(true);
    setLoading(true);
    setError("");
    try {
      const response = await fetch(url);
      if (!response.ok) throw new Error(`http_${response.status}`);
      const text = (await response.text()).trim();
      setBody(text);
      if (!text) setError(t("changelogUnavailable"));
    } catch (failure) {
      setBody("");
      setError(failure instanceof Error ? failure.message : t("changelogUnavailable"));
    } finally {
      setLoading(false);
    }
  }

  return (
    <>
      <div className="actions compact">
        <button className="button" type="button" disabled={loading} onClick={() => void toggle()}>
          {visible ? t("hideChangelog") : loading ? t("loading") : t("viewChangelog")}
        </button>
      </div>
      {visible ? (
        <div className="changelog-panel">
          {loading ? <p className="service-muted">{t("loading")}</p> : null}
          {error ? <p className="service-muted">{error}</p> : null}
          {body ? <Markdown source={body} /> : null}
        </div>
      ) : null}
    </>
  );
}
