interface Props {
  title: string;
  message?: string;
  confirmLabel?: string;
  danger?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

function ConfirmDialog({
  title,
  message,
  confirmLabel = "删除",
  danger = true,
  onConfirm,
  onCancel,
}: Props) {
  return (
    <div className="modal-overlay">
      <div className="modal">
        <p className="modal-title">{title}</p>
        {message && <p className="modal-message">{message}</p>}
        <div className="modal-actions">
          <button
            type="button"
            className={danger ? "danger-btn" : ""}
            onClick={onConfirm}
          >
            {confirmLabel}
          </button>
          <button type="button" onClick={onCancel}>
            取消
          </button>
        </div>
      </div>
    </div>
  );
}

export default ConfirmDialog;