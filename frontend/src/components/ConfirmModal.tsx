import { useEffect } from "react";
import { TriangleAlert } from "lucide-react";

interface ConfirmModalProps {
  title: string;
  message: string;
  confirmLabel: string;
  cancelLabel: string;
  onConfirm: () => void;
  onCancel: () => void;
}

export function ConfirmModal({ title, message, confirmLabel, cancelLabel, onConfirm, onCancel }: ConfirmModalProps) {
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onCancel();
      if (e.key === "Enter") onConfirm();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onConfirm, onCancel]);

  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true" aria-labelledby="confirm-modal-title" onClick={onCancel}>
      <div className="modal-panel confirm-modal-panel" onClick={(e) => e.stopPropagation()}>
        <div className="confirm-modal-icon"><TriangleAlert size={36} strokeWidth={1.5} /></div>
        <h3 id="confirm-modal-title">{title}</h3>
        <p className="confirm-modal-message">{message}</p>
        <div className="confirm-modal-actions">
          <button className="button" type="button" onClick={onCancel}>{cancelLabel}</button>
          <button className="button primary" type="button" onClick={onConfirm}>{confirmLabel}</button>
        </div>
      </div>
    </div>
  );
}
