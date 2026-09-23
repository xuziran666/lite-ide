import { useEffect, useRef, useState } from "react";
import type {
  MouseEvent as ReactMouseEvent,
  PointerEvent as ReactPointerEvent,
} from "react";
import { useEditorStore } from "../../stores/editorStore";
import ContextMenu, { type ContextMenuAction } from "../FileTree/ContextMenu";

const DRAG_THRESHOLD = 4;

interface DragState {
  path: string;
  fromIndex: number;
  overIndex: number;
  pointerId: number;
  startX: number;
  active: boolean;
}

interface MenuState {
  x: number;
  y: number;
  path: string;
}

function Tabs() {
  const openFiles = useEditorStore((s) => s.openFiles);
  const activePath = useEditorStore((s) => s.activePath);
  const pendingClosePath = useEditorStore((s) => s.pendingClosePath);
  const setActive = useEditorStore((s) => s.setActive);
  const requestCloseTab = useEditorStore((s) => s.requestCloseTab);
  const confirmCloseTab = useEditorStore((s) => s.confirmCloseTab);
  const cancelCloseTab = useEditorStore((s) => s.cancelCloseTab);
  const reorderTabs = useEditorStore((s) => s.reorderTabs);
  const closeOthers = useEditorStore((s) => s.closeOthers);
  const closeRight = useEditorStore((s) => s.closeRight);
  const closeAll = useEditorStore((s) => s.closeAll);

  const barRef = useRef<HTMLDivElement | null>(null);
  const dragRef = useRef<DragState | null>(null);
  const suppressClickRef = useRef(false);
  const [drag, setDrag] = useState<DragState | null>(null);
  const [menu, setMenu] = useState<MenuState | null>(null);

  // Keep the active tab visible while many files are open.
  useEffect(() => {
    const bar = barRef.current;
    if (!bar || !activePath) return;
    bar
      .querySelector<HTMLElement>('[data-active="true"]')
      ?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [activePath, openFiles.length]);

  // Horizontal wheel scrolling, so a long tab strip stays usable.
  useEffect(() => {
    const bar = barRef.current;
    if (!bar) return;
    const onWheel = (e: WheelEvent) => {
      if (e.deltaY === 0 || bar.scrollWidth <= bar.clientWidth) return;
      e.preventDefault();
      bar.scrollLeft += e.deltaY;
    };
    bar.addEventListener("wheel", onWheel, { passive: false });
    return () => bar.removeEventListener("wheel", onWheel);
  }, []);

  const computeOverIndex = (clientX: number): number => {
    const bar = barRef.current;
    const source = dragRef.current?.path;
    if (!bar) return 0;
    const tabs = Array.from(
      bar.querySelectorAll<HTMLElement>(":scope > .tab"),
    ).filter((el) => el.dataset.path !== source);
    for (let i = 0; i < tabs.length; i += 1) {
      const rect = tabs[i].getBoundingClientRect();
      if (clientX < rect.left + rect.width / 2) return i;
    }
    return tabs.length;
  };

  const beginDrag = (e: ReactPointerEvent, path: string) => {
    if (e.button !== 0) return;
    if ((e.target as HTMLElement).closest(".tab-close")) return;
    const fromIndex = openFiles.findIndex((t) => t.path === path);
    if (fromIndex < 0) return;
    suppressClickRef.current = false;
    e.currentTarget.setPointerCapture(e.pointerId);
    const next: DragState = {
      path,
      fromIndex,
      overIndex: fromIndex,
      pointerId: e.pointerId,
      startX: e.clientX,
      active: false,
    };
    dragRef.current = next;
    setDrag(next);
  };

  const moveDrag = (e: ReactPointerEvent, path: string) => {
    const d = dragRef.current;
    if (!d || d.pointerId !== e.pointerId || d.path !== path) return;
    if (!d.active) {
      if (Math.abs(e.clientX - d.startX) < DRAG_THRESHOLD) return;
      const next = { ...d, active: true };
      dragRef.current = next;
      setDrag(next);
      return;
    }
    const over = computeOverIndex(e.clientX);
    if (over === d.overIndex) return;
    const next = { ...d, overIndex: over };
    dragRef.current = next;
    setDrag(next);
  };

  const endDrag = (e: ReactPointerEvent, path: string) => {
    const d = dragRef.current;
    if (!d || d.pointerId !== e.pointerId || d.path !== path) return;
    if (d.active) {
      suppressClickRef.current = true;
      if (d.fromIndex !== d.overIndex) {
        reorderTabs(d.fromIndex, d.overIndex);
      }
    }
    dragRef.current = null;
    setDrag(null);
  };

  const cancelDrag = (e: ReactPointerEvent, path: string) => {
    const d = dragRef.current;
    if (!d || d.pointerId !== e.pointerId || d.path !== path) return;
    dragRef.current = null;
    setDrag(null);
  };

  const handleContextMenu = (e: ReactMouseEvent, path: string) => {
    e.preventDefault();
    e.stopPropagation();
    setMenu({ x: e.clientX, y: e.clientY, path });
  };

  // Show the dragged tab moving through the strip while dragging; otherwise
  // render tabs in the store order.
  const orderedPaths =
    drag?.active && dragRef.current
      ? (() => {
          const paths = openFiles.map((t) => t.path);
          const without = paths.filter((p) => p !== drag.path);
          const index = Math.max(
            0,
            Math.min(drag.overIndex, without.length),
          );
          without.splice(index, 0, drag.path);
          return without;
        })()
      : openFiles.map((t) => t.path);

  const buildTabActions = (path: string): ContextMenuAction[] => [
    { label: "关闭", onClick: () => requestCloseTab(path) },
    ...(openFiles.length > 1
      ? [
          { label: "关闭其他", onClick: () => closeOthers(path) },
          { label: "关闭右侧", onClick: () => closeRight(path) },
          { label: "关闭全部", onClick: () => closeAll() },
        ]
      : []),
  ];

  const pending = openFiles.find((t) => t.path === pendingClosePath) ?? null;

  return (
    <>
      <div className="tabs-bar" ref={barRef}>
        {orderedPaths.map((path) => {
          const tab = openFiles.find((t) => t.path === path);
          if (!tab) return null;
          const isActive = tab.path === activePath;
          const isDragging = drag?.active && drag.path === tab.path;
          const className =
            "tab" + (isActive ? " active" : "") + (isDragging ? " dragging" : "");
          return (
            <div
              key={tab.path}
              className={className}
              data-active={isActive}
              data-path={tab.path}
              title={tab.path}
              onClick={() => {
                if (suppressClickRef.current) {
                  suppressClickRef.current = false;
                  return;
                }
                setActive(tab.path);
              }}
              onContextMenu={(e) => handleContextMenu(e, tab.path)}
              onPointerDown={(e) => beginDrag(e, tab.path)}
              onPointerMove={(e) => moveDrag(e, tab.path)}
              onPointerUp={(e) => endDrag(e, tab.path)}
              onPointerCancel={(e) => cancelDrag(e, tab.path)}
              onMouseDown={(e) => {
                if (e.button === 1) {
                  e.preventDefault();
                  requestCloseTab(tab.path);
                }
              }}
            >
              <span className="tab-name">{tab.name}</span>
              {tab.dirty && <span className="tab-dirty" />}
              <button
                type="button"
                className="tab-close"
                title="关闭"
                onClick={(e) => {
                  e.stopPropagation();
                  requestCloseTab(tab.path);
                }}
              >
                ×
              </button>
            </div>
          );
        })}
      </div>

      {menu && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          actions={buildTabActions(menu.path)}
          onClose={() => setMenu(null)}
        />
      )}

      {pending && (
        <div className="modal-overlay">
          <div className="modal">
            <p className="modal-title">“{pending.name}”有未保存的更改，要保存吗？</p>
            <div className="modal-actions">
              <button type="button" onClick={() => void confirmCloseTab(true)}>
                保存
              </button>
              <button type="button" onClick={() => void confirmCloseTab(false)}>
                不保存
              </button>
              <button type="button" onClick={cancelCloseTab}>
                取消
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

export default Tabs;