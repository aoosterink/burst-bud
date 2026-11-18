import { useEffect, useRef } from 'react';

export interface ConfirmRequest {
  title: string;
  body: string;
  confirmLabel: string;
  cancelLabel?: string;
  onConfirm: () => void;
  onCancel: () => void;
}

export function ConfirmDialog({ title, body, confirmLabel, cancelLabel = 'Stay', onConfirm, onCancel }: ConfirmRequest) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const d = ref.current!;
    if (!d.open) d.showModal();
    return () => d.close();
  }, []);
  return (
    <dialog
      ref={ref}
      className="confirm"
      onCancel={(e) => {
        e.preventDefault();
        onCancel();
      }}
      onClick={(e) => e.target === ref.current && onCancel()}
      aria-labelledby="confirm-title"
    >
      <h2 id="confirm-title">{title}</h2>
      <p className="muted">{body}</p>
      <div className="confirm-actions">
        <button className="btn subtle" onClick={onCancel} autoFocus>
          {cancelLabel}
        </button>
        <button className="primary" onClick={onConfirm}>
          {confirmLabel}
        </button>
      </div>
    </dialog>
  );
}
