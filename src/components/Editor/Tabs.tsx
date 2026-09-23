import { useEffect, useRef } from "react";
import { useEditorStore } from "../../stores/editorStore";

function Tabs() {
  const openFiles = useEditorStore((s) => s.openFiles);
  const activePath = useEditorStore((s) => s.activePath);
  const pendingClosePath = useEditorStore((s) => s.pendingClosePath);
  const setActive = useEditorStore((s) => s.setActive);
  const requestCloseTab = useEditorStore((s) => s.requestCloseTab);
  const confirmCloseTab = useEditorStore((s) => s.confirmCloseTab);
  const cancelCloseTab = useEditorStore((s) => s.cancelCloseTab);

  const barRef = useRef<HTMLDivElement | null>(null);

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

  const pending = openFiles.find((t) => t.path === pendingClosePath) ?? null;

  return (
    <>
      <div className="tabs-bar" ref={barRef}>
        {openFiles.map((t) => (
          <div
            key={t.path}
            className={`tab${t.path === activePath ? " active" : ""}`}
            data-active={t.path === activePath}
            onClick={() => setActive(t.path)}
            onMouseDown={(e) => {
              if (e.button === 1) {
                e.preventDefault();
                requestCloseTab(t.path);
              }
            }}
            title={t.path}
          >
            <span className="tab-name">{t.name}</span>
            {t.dirty && <span className="tab-dirty" />}
            <button
              type="button"
              className="tab-close"
              title="关闭"
              onClick={(e) => {
                e.stopPropagation();
                requestCloseTab(t.path);
              }}
            >
              ×
            </button>
          </div>
        ))}
      </div>

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
