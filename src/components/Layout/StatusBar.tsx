import { useEditorStore } from "../../stores/editorStore";

function StatusBar() {
  const activePath = useEditorStore((s) => s.activePath);
  const openFiles = useEditorStore((s) => s.openFiles);
  const cursor = useEditorStore((s) => s.cursor);

  const active = openFiles.find((t) => t.path === activePath) ?? null;

  return (
    <footer className="status-bar">
      {active && (
        <span className="status-item">
          {cursor ? `行 ${cursor.line}，列 ${cursor.column}` : "行 -, 列 -"}
        </span>
      )}
      {active && cursor && cursor.selected > 0 && (
        <span className="status-item">{`已选择 ${cursor.selected} 个字符`}</span>
      )}
      <span className="status-spacer" />
      {active && (
        <>
          <span className="status-item">{active.language}</span>
          <span className="status-item">空格: 2</span>
          <span className="status-item">UTF-8</span>
          {active.dirty && (
            <span className="status-item status-dirty">未保存</span>
          )}
        </>
      )}
    </footer>
  );
}

export default StatusBar;
