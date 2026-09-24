# lite-ide 功能汇总

> 版本 0.1.0 · 代码基线 `main@df57238` · 最后更新 2026-09

基于 Tauri v2 的轻量级跨平台代码编辑器，核心为**文件树**、**代码编辑器（Monaco）**、**内置终端（xterm.js + portable-pty）**、**任务/设置系统**，以及**项目导航**与**内置 LSP 客户端**。

## 1. 技术栈

| 层 | 技术 | 版本 |
|---|---|---|
| 应用外壳 | Tauri | 2（本地 2.11.6） |
| 前端 | React / TypeScript / Vite | 19.1 / 6.0 / 8.0 |
| 状态管理 | Zustand | 5.0.3 |
| 编辑器 | monaco-editor | 0.56 |
| 终端 | @xterm/xterm（+ addon-fit、addon-webgl） | 6.0 / 0.11 / 0.19 |
| 后端能力 | notify（文件监听）、portable-pty（伪终端）、tauri-plugin-dialog（目录选择）、regex（全局搜索） | 8.2 / 0.9 / 2 / 1 |
| 语言服务器（外部，从 PATH 查找） | rust-analyzer / clangd / typescript-language-server | — |

## 2. 功能总览

| 模块 | 能力 | 状态 |
|---|---|---|
| 工作区 | 输入路径或系统对话框选择、切换、启动自动恢复（可配置） | ✅ |
| 文件树 | 懒加载、展开折叠、右键增删改、复制路径、外部变更自动刷新、跟随当前编辑文件 | ✅ |
| 编辑器 | 多标签、脏标记、保存、关闭确认、外部变更处理、46 种扩展名高亮、编辑参数可配置 | ✅ |
| 终端 | 多标签真实 PTY、任务终端、默认 shell 可配置、JetBrains 风格 Ctrl+C | ✅ |
| 任务 | 全局 tasks.json、任务中心、变量展开与 Windows 路径归一化、专用任务终端 | ✅ |
| 设置 | 通用/编辑器/终端/任务/键盘快捷键 5 分区，user.json 读写（含 lsp 配置） | ✅ |
| 项目导航 | Quick Open（Ctrl+P）、全局搜索（Ctrl+Shift+F）、右侧栏（搜索/大纲/问题） | ✅ |
| 语言服务 | 内置 LSP 客户端：Rust（rust-analyzer）、C/C++（clangd）、TS/JS（typescript-language-server）：诊断/补全/悬停/定义/大纲、Ctrl+左键跳转 | ✅ |
| 布局 | 三栏拖拽 + 右侧栏、文件树/终端折叠、底部状态栏、设置页覆盖中心区 | ✅ |
| 窗口 | 最小尺寸、标题跟随工作区、关窗未保存保护（可配置） | ✅ |
| 命令面板 / Git / 调试 / 主题切换 | — | ❌ 未实现 |

## 3. 工作区管理

- **选择**：欢迎页可手输路径（Enter 直接打开）或调用系统目录选择框；打开后由 Rust 校验目录存在 → `canonicalize` → 写入应用状态，并重启文件监听、结束旧终端会话、停止所有语言服务器。
- **切换**：文件树头部「切换工作区」按钮。
- **自动恢复**：受设置项 `general.restoreLastWorkspace` 控制（默认开）。开启时启动把上次工作区写入的 `session.json` 路径自动打开；若该目录已被删除或移动，则**静默回退**欢迎页（不弹错误）。配置先于工作区决策加载（App 启动先 `loadConfig` 再 `init`）。
- 打开工作区会整体重置编辑器标签、文件树、右侧栏/Quick Open 文件索引与语言服务运行时状态；任务列表为全局配置、**不随工作区切换而丢失**。

## 4. 文件树

- **懒加载**：点击目录才读取其内容；重新加载时保留已展开子树的展开状态。
- **排序**：目录优先 → 名称不区分大小写升序（后端完成）。
- **交互**：层级缩进、展开箭头、选中高亮、加载中指示、空目录占位「空文件夹」、节点级错误行、完整路径 tooltip。
- **右键菜单**：目录 → 新建文件／新建文件夹／复制路径（含相对路径）／重命名／删除；文件 → 打开／复制路径（含相对路径）／重命名／删除；头部「+」在工作区根新建。
- **重命名**：同步已打开标签的路径、语言与脏状态；**删除**：脏标签保留、非脏标签自动关闭。
- **外部变更**：`notify` 递归监听（500ms 防抖）自动刷新**已加载过**的受影响目录，未展开目录不刷新。

### 4.1 目录与文件规则

「树中隐藏」与「丢弃监听事件」是**两套独立清单**：

| 规则 | 名单 | 生效位置 |
|---|---|---|
| 树中隐藏 | `.git`、`target`、`dist`、`build`、`.cache` | `HIDDEN_DIRS` → `list_dir` |
| 丢弃 watcher 事件 | `.git`、`node_modules`、`target`、`dist`、`build`、`.cache` | `IGNORED_DIRS` → `path_is_ignored` |
| 自动定位不强展开 | `node_modules` | `AUTO_REVEAL_SKIP` → `revealPath` |

由此产生三条具体行为：

1. **`node_modules` 可见、可手动展开**（不在隐藏名单内）；
2. `node_modules` 内的文件系统事件**仍被丢弃** —— 该目录中的变化不会自动刷新树（折叠后重新展开才会更新），同时避免依赖安装/构建期间的事件风暴；
3. 打开 `node_modules/**` 中的文件时，标签与编辑器正常打开，但**不会**把树逐级展开到该文件；若其父目录已被手动展开，则照常高亮定位。

## 5. 编辑器

- **Monaco 配置**：`vs-dark`；字号（默认 14）、制表符大小（默认 2）、`wordWrap`（默认 off）、minimap（默认关）四项均可在设置中调整，并在保存后**立即热应用到所有已打开编辑器**（通过 `editor.updateOptions`）。
- **多标签**：点击切换、`×` 关闭、鼠标中键关闭、脏文件显示橙色圆点、标签保持固定宽度（超长省略）并支持滚轮横向滚动、激活标签自动滚入视野。
- **保存**：`Ctrl/Cmd+S`；脏状态基于 Monaco `versionId` 与 `savedVersion` 比较（不是简单布尔标记），因此撤销回已保存内容时会自动取消脏标记。
- **关闭脏标签**：弹出「保存 / 不保存 / 取消」三选一；保存失败时标签保持打开，避免丢失内容。
- **外部变更**：非脏文件自动重载且不置脏；脏文件保留本地修改并弹出提示横幅。
- **全局配置文件**：设置里「打开 tasks.json」以外部标签形式在内置编辑器打开全局配置；其保存走 `write_global_file`（白名单仅 `tasks.json`），不经过普通文件系统写路径。
- **只读外部文件**：语言服务定义跳转到工作区外文件（如 rustlib / libstdc++）时，以**只读标签**打开（`readOnly`），可高亮、可关闭，但从不置脏、`Ctrl/Cmd+S` 不保存、不进入最近关闭历史；切换工作区会关闭。它不加入文件树、Quick Open 或全局搜索。
- **语言高亮**：46 种扩展名映射（js/ts/jsx/tsx/html/css/scss/json/md/rs/c/cpp/py/java/kt/go/cs/php/rb/sh/ps1/sql/yaml/xml/toml/ini 等）+ 特殊文件名 `Dockerfile`（含 `dockerfile.*`）。
- **Monaco 原生能力**：查找／替换、多光标、括号匹配与跳转、代码折叠、撤销栈等。
- 读写错误与外部变更提示均以顶部可关闭横幅呈现；设置 toast 通知走底部全局 Toast 栈。

## 6. 内置终端

- **真实伪终端**：基于 `portable-pty`，设置 `TERM=xterm-256color`。
- **多标签**：顶部标签栏切换；`+` 新建「终端 N」，进程退出后标签显示「(已退出)」，可重启或关闭；默认 shell 关闭无确认。
- **默认 Shell**：设置中可选（后端探测本机已安装的 shell，Windows 顺序 `pwsh.exe` → `powershell.exe` → `cmd.exe`，Unix `$SHELL` → `/bin/sh`）；默认 `auto`。该值**只在 spawn 时读取**，新开的终端生效，已在运行的会话不受之后修改影响。
- **起始目录**：当前工作区；Windows 下会先把 `\\?\…` 扩展长度路径还原为普通路径，避免 shell 拒绝。
- **输出通道**：按 4KB 或 16ms 批量下发（空数据块 = 进程退出标记），reader/flusher 双线程。
- **尺寸自适应**：仅活动（可见）终端 `fit()` 并同步 PTY 的 cols/rows，隐藏实例与其零宽容器跳过。
- **键盘行为（JetBrains 风格 Ctrl+C）**：通过 xterm `attachCustomKeyEventHandler` 拦截，仅作用于获得焦点的当前实例：
  - 有选中文本 → `Ctrl+C` 复制选区（`navigator.clipboard.writeText`），**不**向 PTY 发送 `\x03`，并阻止 WebView 默认行为；
  - 无选中文本 → `Ctrl+C` 照常发送 `\x03` 中断当前命令；
  - `Ctrl+V`、`Ctrl+Shift+C` 等其余组合键行为不变。
- **工具栏**：清屏、折叠；进程退出后显示「进程已退出」与「重启」按钮（不自动重启）。
- **生命周期**：重启终端、切换工作区、关闭应用都会结束旧会话；Windows 下用 `taskkill /PID <pid> /T /F` 清理整棵进程树。

## 7. 任务系统

- **任务来源**：全局 `tasks.json`（与应用配置 `user.json` 同目录），格式为 `{"tasks": [{"name": "...", "command": "..."}]}`。文件不存在时任务列表为空；格式错误在任务中心显示可读错误。
- **任务中心（下拉）**：活动栏「任务」按钮或 `Ctrl+Ctrl` 双击 Ctrl 打开；`↑`/`↓` 选择、`Enter` 运行、`Esc` 关闭、鼠标悬停选中；运行中的任务显示 `●` 指示（活动栏与终端标签均有运行标记）。
- **变量展开**：命令支持 `workspaceFolder`、`workspaceFolderBasename`、`file`、`fileBasename`、`fileBasenameNoExtension`、`fileDirname`、`relativeFile`、`relativeFileDirname`。用到 `file*` 变量的任务在无活动文件时会拒绝运行并 toast 提示。
- **Windows 路径归一化**：绝对路径变量的展开结果（`workspaceFolder`/`file`/`fileDirname`）会把 `canonicalize` 产生的 `\\?\` 扩展长度前缀还原为普通路径（`\\?\E:\…` → `E:\…`，`\\?\UNC\…` → `\\…`），避免 MinGW `g++` 等工具拒绝；`relativeFile` 系列保持正斜杠相对路径不转换。工作区内部 canonical 路径与文件系统安全校验不受影响。
- **任务终端**：运行任务时自动复用/创建固定「任务」标签；若已有命令在跑，先向 PTY 写 `\x03` 中断并等待 350ms，再写入解析后的命令；shell 已退出则先重启再执行；首次 spawn 未完成时排队到 spawn 之后。
- **编辑入口**：设置 → 任务 →「打开 tasks.json」在内置编辑器打开（缺失时填入 `{"tasks": []}` 兜底）；保存后**需重启应用**才重新加载任务列表。

## 8. 项目导航

### 8.1 Quick Open（`Ctrl/Cmd+P`）

- 覆盖式输入框，输入文件名即时过滤；子序列模糊评分（连续命中、词首/路径分隔符命中、靠前位置加权），文件名权重高于路径，最多展示 **50** 条。
- 文件索引由 Rust `list_workspace_files` 一次性返回（工作区相对路径、正斜杠、目录优先排序由前端负责），跳过隐藏目录（`.git`/`target`/`dist`/`build`/`.cache`），**包含** `node_modules`；切换工作区清空缓存。
- `↑`/`↓` 选择、`Enter` 打开、`Esc` 关闭、鼠标点击/悬停选中；打开经 `openAndReveal`。

### 8.2 全局搜索（`Ctrl/Cmd+Shift+F`）

- 位于右侧栏「搜索」标签；输入防抖 **300ms** 自动搜索，`Enter` 立即搜索。
- 选项：区分大小写（`Aa`）、正则（`.*`）；结果按文件分组、显示 `行:列` 与整行文本，点击经 `openAndReveal` 跳转。
- 后端 `search_workspace`：递归遍历（跳过隐藏目录、包含 `node_modules`、不跟随 symlink 目录），逐行匹配；**上限**：总匹配 2000、单文件 200、单文件扫描 4MB、非 UTF-8 跳过。正则非法时返回可读错误。

### 8.3 右侧栏（大纲 / 问题）

- 顶部栏右侧按钮切换右侧栏；面板为 **搜索 / 大纲 / 问题** 三标签，宽度可拖拽。
- **大纲（Outline）**：调用 Monaco 的 `documentSymbol` 提供者（即语言服务）构建符号树，层级缩进、点击跳转到符号起始位置；无语言服务时 C/C++ 使用正则扫描回退（函数/类/结构体/枚举/命名空间/typedef/using 别名，基于花括号深度的**行扫描，非 AST**）。
- **问题（Problems）**：聚合当前所有 Monaco markers（按文件分组，显示严重级别 E/W/I/H、行:列、消息），点击跳转。

## 9. 语言服务（内置 LSP 客户端）

自建 LSP 客户端，不使用第三方 LSP 集成。传输为 stdio + JSON-RPC（`Content-Length` 帧），前端只通过 Tauri 命令与事件交互。

### 9.1 支持的语言与启动命令

| 语言 | Monaco 语言 | 扩展名 | 启动命令 | 服务器根 |
|---|---|---|---|---|
| Rust | `rust` | `.rs` | `rust-analyzer` | 最近的 `Cargo.toml`（不超出工作区） |
| C / C++ | `c`、`cpp` | `.c` `.h` `.cpp` `.cc` `.cxx` `.hpp` `.hh` `.hxx` | `clangd` | 工作区根 |
| TypeScript / JavaScript | `typescript`、`javascript` | `.ts` `.tsx` `.js` `.jsx` `.mjs` `.cjs` | `typescript-language-server --stdio` | 工作区根 |

- 服务器从 **PATH** 查找；未安装时不崩溃，该语言保持 disconnected 并 toast 明确报错，再次打开该语言文件会重试。
- C/C++ 与 TS 的根固定为工作区根，让服务器自行发现 `compile_commands.json` / `tsconfig.json`；打开外部定义文件**不会**改变根。

### 9.2 能力

诊断（`publishDiagnostics`）、补全（`.`,`:` 等触发字符、snippet）、悬停、定义、`documentSymbol`（大纲），以及 Ctrl/Cmd+左键定义跳转。诊断/补全/悬停/定义/大纲复用同一套 Monaco 提供者：**注册一次**（选择器覆盖全部受支持语言），按当前 model 的语言分发到对应服务器。

### 9.3 生命周期

- 首次打开某语言文件时**懒启动**；一个工作区每种语言最多一个服务器。
- 关闭某语言最后一个文件 → 停止该语言服务器；工作区切换 / 应用退出 → 停止所有服务器。
- 服务器崩溃（`lsp-exited`）→ 重置该语言状态并 toast；**不自动无限重启**，用户再次打开该语言文件时允许重新启动。
- 传输层对未知 JSON-RPC 形状不崩溃；服务器发来的请求（`workspace/configuration` 等）由客户端按协议应答。

### 9.4 定义与 Ctrl/Cmd+左键

- **定义提供者只返回位置，不产生跳转副作用**：Monaco 在 `Ctrl+hover` 时也会调用该提供者，早期在提供者内跳转会表现为「悬停即跳转」。现在 `Ctrl/Cmd+hover` 只显示可点击态与预览，**不跳转**；仅 **`Ctrl/Cmd+左键`** 才跳转（macOS 用 Cmd）。
- 跳转目标在工作区内 → 普通标签打开；在工作区外 → 只读外部标签（见 §5），支持跳入 rustlib / 系统头文件等。
- 定义目标会预创建只读预览模型，供 Monaco 悬停预览解析；非工作区文件不会发送给语言服务器。

### 9.5 C/C++ 工具链发现

- **`compile_commands.json` 优先**：clangd 原生发现源文件父目录与 `build/` 中的数据库；存在数据库时完全以其编译命令为准，不覆盖其编译器/头文件/参数，并移除本工具生成的回退文件。
- **无数据库时**：检测 PATH 中的 `g++`（其次 `gcc`），按其生成一个**受管 `.clangd`**（`CompileFlags.Compiler: <检测到的绝对路径>`），并以 `--enable-config`（让 `.clangd` 生效）+ `--query-driver=<该路径>`（允许 clangd 调用它以提取 libstdc++ 系统头文件）启动 clangd。由此避免 clangd 在 Windows 上默认使用 MSVC STL。
- 不硬编码任何 MinGW/msys/STL 路径；不修改 clangd；不自行解析 C++ 语义。项目自带 `.clangd` 时**不覆盖**；一旦出现 `compile_commands.json`，受管 `.clangd` 会被自动移除，MSVC/自定义工具链项目继续按自身配置工作。

### 9.6 TypeScript / JavaScript 的 worker 取舍

Monaco 内置的 TS/JS worker 也提供补全/悬停/定义/大纲/诊断。为避免与语言服务重复，启用内置 LSP 时**关闭**这些被取代的 worker 能力（保留格式化、重命名、引用、代码操作等未被取代的能力）；诊断仅来自 `typescript-language-server`。

### 9.7 配置（`user.json` 的 `lsp` 节）

允许覆盖三种服务器的命令与参数（缺省时使用默认值）：

```json
{
  "lsp": {
    "rust": { "command": "rust-analyzer", "args": [] },
    "cpp": { "command": "clangd", "args": [] },
    "typescript": { "command": "typescript-language-server", "args": ["--stdio"] }
  }
}
```

当前**未提供 Settings UI**，默认值 + PATH 生效；保存其它设置时会原样保留 `lsp` 节，不会被清空。

## 10. 设置系统

- **入口与布局**：活动栏底部 ⚙ 打开设置页，覆盖编辑器中心区域（`.workbench` 隐藏但保持挂载，Monaco 模型/标签/终端 PTY 不销毁）；「◀ 返回编辑器」关闭；活动栏文件树/任务按钮会先关闭设置。
- **分区**（左侧导航）：

| 分区 | 项目 | 生效时机 |
|---|---|---|
| 通用 | 恢复上次打开的文件夹；关闭时确认未保存的更改 | 前者下次启动；后者即时生效 |
| 编辑器 | 字号 6–64、制表符大小 1–16、自动换行 off/on、缩略图开关 | 立即热应用 |
| 终端 | 默认 Shell（下拉，含 `auto` 与探测到的壳） | 新终端会话（spawn 时） |
| 任务 | 打开 tasks.json 编辑全局任务 | 保存后重启应用 |
| 键盘快捷键 | 见下 | 立即生效 |

- **键盘快捷键**：10 个动作可录制重绑（`toggleExplorer`、`toggleTerminal`、`newTerminal`、`closeEditorTab`、`restoreClosedTab`、`nextEditorTab`、`previousEditorTab`、`openTaskCenter`、`quickOpen`、`globalSearch`）。录制规则：组合键须含 Ctrl/Meta、不得含 Alt、支持 `Ctrl+Ctrl` 双击（仅 `openTaskCenter` 可用）；跨动作重复检测（提示占用方）；`Esc` 取消录制。
- **持久化**：所有设置在改动时即时写回 `user.json`（后端做边界钳制/空值回退/非法 `wordWrap` 归 off）；`user.json` 缺失用默认值、损坏时用默认值并 toast 提示，绝不阻塞启动。keybindings 中未知动作被忽略。
- **user.json 结构**（camelCase）：

```json
{
  "keybindings": { "toggleExplorer": "Ctrl+B", "openTaskCenter": "Ctrl+Ctrl", "..." : "..." },
  "editor": { "fontSize": 14, "tabSize": 2, "wordWrap": "off", "minimap": false },
  "terminal": { "defaultShell": "auto" },
  "general": { "restoreLastWorkspace": true, "confirmBeforeClose": true },
  "lsp": {
    "rust": { "command": "rust-analyzer", "args": [] },
    "cpp": { "command": "clangd", "args": [] },
    "typescript": { "command": "typescript-language-server", "args": ["--stdio"] }
  }
}
```

## 11. 布局与窗口

- **四区域**：左侧文件树（180–500px）、中间编辑器、底部终端（高度 ≥120px）、右侧栏（搜索/大纲/问题）均可拖拽；终端高度不超过窗口 70% 且为编辑器保留至少 160px；窗口缩放时自动收敛到合法范围。
- **折叠**：文件树折叠时**完全让位**（编辑器与标签栏贴到窗口最左侧），展开按钮浮动于标签栏左上角；终端折叠为底部「▲ 展开终端」条；右侧栏由顶部栏按钮显隐。
- **窗口**：最小尺寸 720×480；标题显示「工作区名 - lite-ide」。
- **关窗保护**：受 `general.confirmBeforeClose` 控制（默认开）。存在未保存标签时拦截关闭，弹出「保存并退出 / 不保存 / 取消」；保存失败则中止退出。关闭后不再询问。

### 11.1 状态栏（底部）

| 位置 | 内容 |
|---|---|
| 左 | `行 N，列 M`；存在选区时追加 `已选择 N 个字符` |
| 右 | 当前文件语言、`空格: 2`、`UTF-8`；文件为脏时显示橙色「未保存」 |

> 当前没有换行符（CRLF/LF）检测能力，因此状态栏不显示换行符信息。

## 12. 快捷键

内置默认值（均可通过设置 → 键盘快捷键录制修改）：

| 快捷键 | 作用 |
|---|---|
| `Ctrl/Cmd + S` | 保存当前文件（不可重绑） |
| `Ctrl/Cmd + P` | Quick Open（快速打开文件） |
| `Ctrl/Cmd + Shift + F` | 全局搜索（右侧栏） |
| `Ctrl/Cmd + B` | 折叠／展开文件树 |
| `` Ctrl/Cmd + ` `` | 折叠／展开终端 |
| `Ctrl/Cmd + Shift + \`` | 新建终端 |
| `Ctrl/Cmd + W` | 关闭当前标签（脏文件走保存确认） |
| `Ctrl/Cmd + Shift + T` | 恢复关闭的标签 |
| `Ctrl + Tab` / `Ctrl + Shift + Tab` | 下一个／上一个标签 |
| `Ctrl + Ctrl`（快速按两次 Ctrl） | 打开任务中心 |
| `Ctrl/Cmd + 左键` | 跳转到定义（编辑器内） |
| 鼠标中键点击标签 | 关闭该标签 |
| 终端内 `Ctrl+C` | 有选区复制 / 无选区中断 |
| 终端内 `Ctrl+V` | 粘贴（不变） |

## 13. 数据与配置位置

| 内容 | 路径 |
|---|---|
| 会话（上次工作区） | `%APPDATA%\com.longanl.lite-ide\session.json`（Windows） |
| 用户配置（设置/快捷键/编辑器/lsp 等） | `%APPDATA%\com.longanl.lite-ide\user.json` |
| 全局任务列表 | `%APPDATA%\com.longanl.lite-ide\tasks.json` |
| C/C++ 回退配置（仅无 `compile_commands.json` 时生成） | `<工作区>/.clangd`（首行标记 `# Managed by lite-ide`，可安全删除） |
| 应用权限声明 | `src-tauri/capabilities/default.json` |
| 窗口与打包配置 | `src-tauri/tauri.conf.json` |

容错策略：`session.json` 缺失或损坏即降级为空会话；`user.json` 缺失用默认配置、损坏用默认配置并在前端 toast 提示；`tasks.json` 缺失视为空任务列表。`user.json`/`tasks.json` 均位于应用配置目录，由 `app_config_dir` 解析。

## 14. 已知限制与未实现

- 无命令面板（`Ctrl+Shift+P` 命令执行）；无 Git 集成；无格式化/重命名（来自语言服务器的重命名等未接入）；无调试；无主题切换（固定 `vs-dark`）。
- 语言服务依赖 PATH 中的外部服务器：`rust-analyzer` / `clangd` / `typescript-language-server` 需自行安装；未安装时对应语言无诊断/补全/跳转（TS/JS 内置 worker 的相关能力已被关闭以让位于语言服务）。
- C/C++ 无 `compile_commands.json` 时用 PATH 的 `g++`/`gcc` 回退；若项目实际使用 MSVC 却既无数据库也无 `.clangd`，回退可能与预期不符（提供数据库或项目自带 `.clangd` 即可覆盖）。
- 任务为**全局**（非按工作区），且 `tasks.json` 修改保存后需重启应用生效；无按任务的输出解析/错误匹配。
- 文件树**无虚拟化渲染**，展开超大目录时会有一次性卡顿；无单子目录链压缩（compact folders）。
- 非 UTF-8 文件无法打开（明确报错）；无编码选择、无换行符显示与转换、无自动保存。
- 标签不可拖拽排序，无「关闭其他／全部关闭」。
- 文件树无多选、无拖拽移动、无复制／剪切／粘贴文件。
- 终端无分屏、终端内搜索、多行选中粘贴确认；任务终端仅一个固定实例。
- `node_modules` 内部变化不触发自动刷新（其事件在监听层被过滤）。
- 全局搜索为逐行、非流式，且受 2000/200/4MB 上限；无「仅包含/排除」过滤器。
- 无前端测试框架，测试覆盖仅限 Rust 侧（112 个单元测试）；前端以 `tsc`/`vite build` 与手工清单验证。

## 15. 手工验收清单

```bash
pnpm install
pnpm tauri dev
```

1. 欢迎页选择或输入目录 → 进入界面；
2. 文件树：展开目录、右键新建文件/文件夹、重命名、删除、复制路径与相对路径；
3. 打开多个文件 → 标签切换、修改后出现脏标记、`Ctrl/Cmd+S` 保存、关闭脏标签出现三选一；
4. 用外部编辑器修改已打开文件 → 非脏自动重载、脏文件保留并提示；
5. 终端：多标签新建/切换、可交互执行命令、清屏、折叠后由底部条展开、`exit` 后显示退出提示与重启按钮；
6. 终端内 `ping 127.0.0.1 -t` 后 `Ctrl+C`（无选区）→ 命令被中断；鼠标选中文本后 `Ctrl+C` → 到外部剪贴板粘贴得到原文本、终端不出现 `^C`；`Ctrl+V` 行为不变；
7. 设置：活动栏 ⚙ → 调整字号/缩略图立即生效；改一个快捷键立即生效；把默认 shell 改为 `cmd.exe` → 新建终端生效、旧终端不变；
8. 任务：`Ctrl+Ctrl` 打开任务中心 → 运行「编译当前 C++」→ 任务终端出现并打印 `g++ "绝对路径" -o "绝对路径\bin\*.exe"`（路径无 `\\?\` 前缀）并生成 exe；运行中再跑任务 → 先 `^C` 中断再执行新命令；
9. 设置 → 任务 → 打开 tasks.json → 增删任务保存 → 重启应用后任务中心出现新任务；
10. 拖拽分隔条调整宽高；`Ctrl/Cmd+B` 折叠文件树 → 编辑器贴到窗口最左侧，左上角浮动按钮可展开；顶部栏按钮显隐右侧栏；
11. 底部状态栏随光标移动更新行列，选中文本显示字符数；
12. 树中可见并展开 `node_modules`，而 `.git`、`target`、`dist`、`build`、`.cache` 不可见；
13. **Quick Open**：`Ctrl/Cmd+P` → 输入文件名模糊匹配 → `Enter` 打开；`Esc` 关闭；
14. **全局搜索**：`Ctrl/Cmd+Shift+F` → 输入关键词自动搜索（可切 `Aa`/`.*`）→ 点击结果跳转；正则非法时显示错误；
15. **大纲 / 问题**：打开一个 `.rs`/`.cpp`/`.ts` → 右侧栏「大纲」显示符号并可跳转；制造一个语法错误 → 「问题」面板出现诊断，点击跳转；
16. **Rust LSP**：打开含 `std::vector` 的 `.rs` 项目 → 补全/悬停/诊断正常；`Ctrl+hover` 只显示可点击态**不跳转**；`Ctrl/Cmd+左键` 跳转到定义（含跳入 rustlib 外部只读标签）；
17. **C/C++ LSP**：打开含 `#include <vector>` 的 MinGW 项目（无 `compile_commands.json`）→ `Ctrl/Cmd+左键` `std::vector` 跳转到 **MinGW libstdc++** 的 `bits/stl_vector.h`（而非 MSVC）；项目放入 `compile_commands.json`（根或 `build/`）后重启语言服务 → 以数据库的编译器为准；
18. **TypeScript LSP**：打开 `.ts` → 补全/悬停/诊断/大纲正常，`Ctrl/Cmd+左键` 跳转到定义；
19. 设置关闭「恢复上次打开的文件夹」→ 重启回欢迎页；开启 → 自动回到上次工作区；把该目录改名后启动 → 静默回到欢迎页；
20. 修改文件但不保存 → 关闭应用 → 出现「保存并退出 / 不保存 / 取消」；勾选设置关闭该确认后 → 直接退出。
