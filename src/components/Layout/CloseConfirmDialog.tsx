interface Props {
  dirtyFiles: string[];
  saving: boolean;
  onSaveAll: () => void;
  onDiscard: () => void;
  onCancel: () => void;
}

function CloseConfirmDialog({
  dirtyFiles,
  saving,
  onSaveAll,
  onDiscard,
  onCancel,
}: Props) {
  return (
    <div className="modal-overlay">
      <div className="modal">
        <p className="modal-title">有未保存的更改，要保存吗？</p>
        <p className="modal-message">{dirtyFiles.join("、")}</p>
        <div className="modal-actions">
          <button type="button" disabled={saving} onClick={onSaveAll}>
            {saving ? "保存中…" : "保存并退出"}
          </button>
          <button type="button" disabled={saving} onClick={onDiscard}>
            不保存
          </button>
          <button type="button" disabled={saving} onClick={onCancel}>
            取消
          </button>
        </div>
      </div>
    </div>
  );
}

export default CloseConfirmDialog;
