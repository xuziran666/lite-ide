import type { EditorSettings } from "../../commands";
import { useConfigStore } from "../../stores/configStore";

function NumberField({
  label,
  value,
  min,
  max,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  onChange: (value: number) => void;
}) {
  const handleChange = (raw: string) => {
    const parsed = Number.parseInt(raw, 10);
    if (Number.isNaN(parsed)) return;
    onChange(Math.min(Math.max(parsed, min), max));
  };
  return (
    <label className="settings-field settings-row">
      <span className="settings-label">{label}</span>
      <input
        type="number"
        className="settings-input"
        value={value}
        min={min}
        max={max}
        onChange={(e) => handleChange(e.target.value)}
      />
    </label>
  );
}

interface Option<T extends string> {
  value: T;
  label: string;
}

const LINE_NUMBERS: Option<EditorSettings["lineNumbers"]>[] = [
  { value: "on", label: "开启" },
  { value: "off", label: "关闭" },
  { value: "relative", label: "相对" },
];

const RENDER_WHITESPACE: Option<EditorSettings["renderWhitespace"]>[] = [
  { value: "none", label: "不显示" },
  { value: "boundary", label: "边界" },
  { value: "selection", label: "选区" },
  { value: "all", label: "全部" },
  { value: "trailing", label: "行尾" },
];

const RENDER_LINE_HIGHLIGHT: Option<EditorSettings["renderLineHighlight"]>[] = [
  { value: "none", label: "关闭" },
  { value: "gutter", label: "行号槽" },
  { value: "line", label: "整行" },
  { value: "all", label: "行号槽与整行" },
];

const MATCH_BRACKETS: Option<EditorSettings["matchBrackets"]>[] = [
  { value: "always", label: "始终" },
  { value: "never", label: "从不" },
  { value: "near", label: "邻近" },
];

const CURSOR_STYLE: Option<EditorSettings["cursorStyle"]>[] = [
  { value: "line", label: "竖线" },
  { value: "block", label: "方块" },
  { value: "underline", label: "下划线" },
  { value: "line-thin", label: "细竖线" },
  { value: "block-outline", label: "空心方块" },
  { value: "underline-thin", label: "细下划线" },
];

const CURSOR_BLINKING: Option<EditorSettings["cursorBlinking"]>[] = [
  { value: "blink", label: "Blink" },
  { value: "smooth", label: "Smooth" },
  { value: "phase", label: "Phase" },
  { value: "expand", label: "Expand" },
  { value: "solid", label: "Solid" },
];

const AUTO_CLOSING_STRATEGY: Option<EditorSettings["autoClosingBrackets"]>[] = [
  { value: "languageDefined", label: "由语言决定" },
  { value: "always", label: "始终" },
  { value: "beforeWhitespace", label: "空白前" },
  { value: "never", label: "从不" },
];

const AUTO_SURROUND_STRATEGY: Option<EditorSettings["autoSurround"]>[] = [
  { value: "languageDefined", label: "由语言决定" },
  { value: "quotes", label: "引号" },
  { value: "brackets", label: "括号" },
  { value: "never", label: "从不" },
];

function SelectField<T extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: T;
  options: Option<T>[];
  onChange: (value: T) => void;
}) {
  return (
    <label className="settings-field settings-row">
      <span className="settings-label">{label}</span>
      <select
        className="settings-select"
        value={value}
        onChange={(e) => onChange(e.target.value as T)}
      >
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </label>
  );
}

function CheckField({
  label,
  detail,
  checked,
  onChange,
}: {
  label: string;
  detail: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <label className="settings-field settings-check">
      <span className="settings-check-text">
        <span className="settings-label">{label}</span>
        <span className="settings-detail">{detail}</span>
      </span>
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
      />
    </label>
  );
}

function EditorSection() {
  const editor = useConfigStore((s) => s.editor);
  const updateEditor = useConfigStore((s) => s.updateEditor);

  return (
    <div className="settings-section">
      <h3 className="settings-section-title">编辑器</h3>
      <NumberField
        label="字号"
        value={editor.fontSize}
        min={6}
        max={64}
        onChange={(fontSize) => void updateEditor({ fontSize })}
      />
      <NumberField
        label="制表符大小"
        value={editor.tabSize}
        min={1}
        max={16}
        onChange={(tabSize) => void updateEditor({ tabSize })}
      />
      <label className="settings-field settings-row">
        <span className="settings-label">自动换行</span>
        <select
          className="settings-select"
          value={editor.wordWrap}
          onChange={(e) => void updateEditor({ wordWrap: e.target.value })}
        >
          <option value="off">关闭</option>
          <option value="on">开启</option>
        </select>
      </label>
      <label className="settings-field settings-row">
        <span className="settings-label">Color Theme</span>
        <select
          className="settings-select"
          value={editor.theme}
          onChange={(e) => void updateEditor({ theme: e.target.value })}
        >
          <option value="vs">Light</option>
          <option value="vs-dark">Dark</option>
          <option value="hc-black">High Contrast</option>
          <option value="hc-light">High Contrast Light</option>
        </select>
      </label>
      <CheckField
        label="显示缩略图"
        detail="在右侧显示代码概览缩略图。"
        checked={editor.minimap}
        onChange={(minimap) => void updateEditor({ minimap })}
      />
      <CheckField
        label="Ctrl + 滚轮缩放"
        detail="按住 Ctrl（macOS 为 Cmd）滚动鼠标滚轮时调整编辑器字号（8–40）。"
        checked={editor.mouseWheelZoom}
        onChange={(mouseWheelZoom) => void updateEditor({ mouseWheelZoom })}
      />

      <div className="settings-group-title">字体</div>
      <label className="settings-field settings-row">
        <span className="settings-label">字体族</span>
        <input
          type="text"
          className="settings-input"
          spellCheck={false}
          placeholder="Consolas, 'Courier New', monospace"
          value={editor.fontFamily}
          onChange={(e) => void updateEditor({ fontFamily: e.target.value })}
        />
      </label>
      <CheckField
        label="连字"
        detail="启用字体连字（Fira Code 等字体的 =>、!= 合字）。"
        checked={editor.fontLigatures}
        onChange={(fontLigatures) => void updateEditor({ fontLigatures })}
      />

      <div className="settings-group-title">显示</div>
      <SelectField
        label="行号"
        value={editor.lineNumbers}
        options={LINE_NUMBERS}
        onChange={(lineNumbers) => void updateEditor({ lineNumbers })}
      />
      <SelectField
        label="空白字符"
        value={editor.renderWhitespace}
        options={RENDER_WHITESPACE}
        onChange={(renderWhitespace) => void updateEditor({ renderWhitespace })}
      />
      <SelectField
        label="当前行高亮"
        value={editor.renderLineHighlight}
        options={RENDER_LINE_HIGHLIGHT}
        onChange={(renderLineHighlight) =>
          void updateEditor({ renderLineHighlight })
        }
      />
      <CheckField
        label="缩进参考线"
        detail="显示缩进层级的竖线。"
        checked={editor.guides.indentation}
        onChange={(indentation) => void updateEditor({ guides: { indentation } })}
      />
      <CheckField
        label="代码折叠"
        detail="在行号槽显示折叠控件。"
        checked={editor.folding}
        onChange={(folding) => void updateEditor({ folding })}
      />
      <SelectField
        label="括号匹配"
        value={editor.matchBrackets}
        options={MATCH_BRACKETS}
        onChange={(matchBrackets) => void updateEditor({ matchBrackets })}
      />
      <CheckField
        label="平滑滚动"
        detail="滚动时使用动画过渡。"
        checked={editor.smoothScrolling}
        onChange={(smoothScrolling) => void updateEditor({ smoothScrolling })}
      />

      <div className="settings-group-title">光标</div>
      <SelectField
        label="光标样式"
        value={editor.cursorStyle}
        options={CURSOR_STYLE}
        onChange={(cursorStyle) => void updateEditor({ cursorStyle })}
      />
      <SelectField
        label="光标闪烁"
        value={editor.cursorBlinking}
        options={CURSOR_BLINKING}
        onChange={(cursorBlinking) => void updateEditor({ cursorBlinking })}
      />

      <div className="settings-group-title">编辑</div>
      <CheckField
        label="粘贴时格式化"
        detail="用当前语言的格式化器格式化粘贴的内容（是否生效取决于是否有 formatter）。"
        checked={editor.formatOnPaste}
        onChange={(formatOnPaste) => void updateEditor({ formatOnPaste })}
      />
      <CheckField
        label="输入时格式化"
        detail="输入时自动格式化代码（是否生效取决于是否有 formatter）。"
        checked={editor.formatOnType}
        onChange={(formatOnType) => void updateEditor({ formatOnType })}
      />
      <SelectField
        label="自动闭合括号"
        value={editor.autoClosingBrackets}
        options={AUTO_CLOSING_STRATEGY}
        onChange={(autoClosingBrackets) =>
          void updateEditor({ autoClosingBrackets })
        }
      />
      <SelectField
        label="自动闭合引号"
        value={editor.autoClosingQuotes}
        options={AUTO_CLOSING_STRATEGY}
        onChange={(autoClosingQuotes) =>
          void updateEditor({ autoClosingQuotes })
        }
      />
      <SelectField
        label="自动包裹"
        value={editor.autoSurround}
        options={AUTO_SURROUND_STRATEGY}
        onChange={(autoSurround) => void updateEditor({ autoSurround })}
      />
      <CheckField
        label="去除自动空白"
        detail="行变空时移除自动缩进/自动闭合留下的空白。"
        checked={editor.trimAutoWhitespace}
        onChange={(trimAutoWhitespace) =>
          void updateEditor({ trimAutoWhitespace })
        }
      />
      <CheckField
        label="拖放文本"
        detail="允许用鼠标拖动选中文本来移动内容。"
        checked={editor.dragAndDrop}
        onChange={(dragAndDrop) => void updateEditor({ dragAndDrop })}
      />
      <CheckField
        label="复制时保留语法高亮"
        detail="复制到剪贴板时写入带语法高亮的 HTML。"
        checked={editor.copyWithSyntaxHighlighting}
        onChange={(copyWithSyntaxHighlighting) =>
          void updateEditor({ copyWithSyntaxHighlighting })
        }
      />
      <CheckField
        label="括号对着色"
        detail="按嵌套层级给配对的括号着色。"
        checked={editor.bracketPairColorization.enabled}
        onChange={(enabled) =>
          void updateEditor({ bracketPairColorization: { enabled } })
        }
      />
      <p className="settings-hint">以上修改会立即应用到当前已打开的编辑器。</p>
    </div>
  );
}

export default EditorSection;