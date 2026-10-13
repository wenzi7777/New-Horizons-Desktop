import { useEffect, useState, type FormEvent } from "react";

import { useI18n } from "../../i18n";
import { normalizeAuthor } from "../../lib/sdkProject";

// Asked on the first visit to the Studio, and reachable from its toolbar
// afterwards. Required the first time (no author yet), so it cannot be
// dismissed until a name is given.
export function StudioAuthorDialog({
  current,
  onSave,
  onClose,
}: {
  current: string;
  onSave: (author: string) => void;
  onClose: (() => void) | null;
}) {
  const { t } = useI18n();
  const [draft, setDraft] = useState(current);
  const normalized = normalizeAuthor(draft);

  useEffect(() => {
    if (!onClose) return undefined;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (normalized) onSave(normalized);
  };

  return (
    <div className="modal-backdrop" role="presentation" onClick={onClose ?? undefined}>
      <form
        className="modal-panel confirm-modal-panel sdk-author-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="sdk-author-title"
        onClick={(event) => event.stopPropagation()}
        onSubmit={submit}
      >
        <h3 id="sdk-author-title">{t("sdkAuthorTitle")}</h3>
        <p className="service-muted">{t("sdkAuthorCopy")}</p>
        <div className="field">
          <label htmlFor="sdk-author-input">{t("sdkAuthorLabel")}</label>
          <input
            id="sdk-author-input"
            autoFocus
            value={draft}
            maxLength={40}
            placeholder="jane_doe"
            onChange={(event) => setDraft(event.target.value)}
          />
          {draft.trim() && normalized !== draft.trim() ? (
            <small className="field-hint">{t("sdkAuthorNormalized").replace("{author}", normalized)}</small>
          ) : null}
        </div>
        <div className="actions compact">
          {onClose ? (
            <button className="button" type="button" onClick={onClose}>{t("cancel")}</button>
          ) : null}
          <button className="button primary" type="submit" disabled={!normalized}>{t("sdkAuthorSave")}</button>
        </div>
      </form>
    </div>
  );
}
