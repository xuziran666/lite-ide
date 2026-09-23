import { useRef, type PointerEvent as ReactPointerEvent } from "react";

interface SplitterProps {
  orientation: "vertical" | "horizontal";
  onDrag: (delta: number) => void;
}

function Splitter({ orientation, onDrag }: SplitterProps) {
  const draggingRef = useRef(false);
  const lastPosRef = useRef(0);

  const startDrag = (e: ReactPointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    draggingRef.current = true;
    lastPosRef.current = orientation === "vertical" ? e.clientX : e.clientY;
    document.body.classList.add("layout-resizing", `layout-resizing-${orientation}`);
  };

  const move = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (!draggingRef.current) return;
    const pos = orientation === "vertical" ? e.clientX : e.clientY;
    const delta = pos - lastPosRef.current;
    lastPosRef.current = pos;
    onDrag(delta);
  };

  const stopDrag = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (!draggingRef.current) return;
    draggingRef.current = false;
    document.body.classList.remove("layout-resizing", `layout-resizing-${orientation}`);
    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId);
    }
  };

  return (
    <div
      role="separator"
      aria-orientation={orientation}
      className={`splitter splitter-${orientation}`}
      onPointerDown={startDrag}
      onPointerMove={move}
      onPointerUp={stopDrag}
      onPointerCancel={stopDrag}
    />
  );
}

export default Splitter;