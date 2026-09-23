import { useEffect, useRef, useState } from "react";

interface Props {
  title: string;
  initial?: string;
  confirmLabel?: string;
  onConfirm: (value: string) => void;
  onCancel: () => void;
}

function NameInputDialog({
  title,
  initial = "",
  confirmLabel = "确定",
  onConfirm,
  onCancel,
}: Props) {
  const [value, setValue] = useState(initial);
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    const input = inputRef.current;
    if (input) {
      input.focus();
      input.select();
    }
  }, []);

  function submit() {
    const trimmed = value.trim();
    if (!trimmed) return;
    onConfirm(trimmed);
  }

  return (
    <div className="modal-overlay">
      <div className="modal">
        <p className="modal-title">{title}</p>
        <input
          ref={inputRef}
          className="name-input"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") submit();
            else if (e.key === "Escape") onCancel();
          }}
        />
        <div className="modal-actions">
          <button type="button" disabled={!value.trim()} onClick={submit}>
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

export default NameInputDialog;