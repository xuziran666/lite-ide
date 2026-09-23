import { useEffect, useLayoutEffect, useRef, useState } from "react";

export interface ContextMenuAction {
  label: string;
  danger?: boolean;
  onClick: () => void;
}

interface Props {
  x: number;
  y: number;
  actions: ContextMenuAction[];
  onClose: () => void;
}

function ContextMenu({ x, y, actions, onClose }: Props) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [pos, setPos] = useState({ x, y });

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    setPos({
      x: Math.min(x, window.innerWidth - rect.width - 4),
      y: Math.min(y, window.innerHeight - rect.height - 4),
    });
  }, [x, y]);

  useEffect(() => {
    function close() {
      onClose();
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("mousedown", close);
    window.addEventListener("keydown", onKey);
    window.addEventListener("blur", onClose);
    return () => {
      window.removeEventListener("mousedown", close);
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("blur", onClose);
    };
  }, [onClose]);

  return (
    <div
      className="context-menu"
      style={{ left: pos.x, top: pos.y }}
      ref={ref}
      onMouseDown={(e) => e.stopPropagation()}
      onContextMenu={(e) => e.preventDefault()}
    >
      {actions.map((action) => (
        <button
          key={action.label}
          type="button"
          className={`context-menu-item${action.danger ? " danger" : ""}`}
          onClick={() => {
            action.onClick();
            onClose();
          }}
        >
          {action.label}
        </button>
      ))}
    </div>
  );
}

export default ContextMenu;