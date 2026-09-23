import { useState } from "react";
import { useEditorStore } from "../../stores/editorStore";
import type { Tab } from "../../types";

function Tabs() {
  const openFiles = useEditorStore((s) => s.openFiles);
  const activePath = useEditorStore((s) => s.activePath);
  const setActive = useEditorStore((s) => s.setActive);
  const closeTab = useEditorStore((s) => s.closeTab);
  const save = useEditorStore((s) => s.save);
  const [pendingClose, setPendingClose] = useState<Tab | null>(null);

  function requestClose(tab: Tab) {
    if (tab.dirty) {
      setPendingClose(tab);
    } else {
      closeTab(tab.path);
    }
  }

  async function handleSaveAndClose() {
    if (!pendingClose) return;
    const ok = await save(pendingClose.path);
    if (ok) {
      closeTab(pendingClose.path);
      setPendingClose(null);
    }
  }

  function handleDiscardAndClose() {
    if (!pendingClose) return;
    closeTab(pendingClose.path);
    setPendingClose(null);
  }

  return (
    <>
      <div className="tabs-bar">
        {openFiles.map((t) => (
          <div
            key={t.path}
            className={`tab${t.path === activePath ? " active" : ""}`}
            onClick={() => setActive(t.path)}
            onMouseDown={(e) => {
              if (e.button === 1) {
                e.preventDefault();
                requestClose(t);
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
                requestClose(t);
              }}
            >
              ×
            </button>
          </div>
        ))}
      </div>

      {pendingClose && (
        <div className="modal-overlay">
          <div className="modal">
            <p className="modal-title">
              “{pendingClose.name}”有未保存的更改，要保存吗？
            </p>
            <div className="modal-actions">
              <button type="button" onClick={() => void handleSaveAndClose()}>
                保存
              </button>
              <button type="button" onClick={handleDiscardAndClose}>
                不保存
              </button>
              <button type="button" onClick={() => setPendingClose(null)}>
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