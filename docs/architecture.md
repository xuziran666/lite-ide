# lite-ide 架构说明

> 版本 0.1.0 · 代码基线 `main@5125feb`

## 1. 技术栈与版本

- 应用外壳：Tauri 2（本地 2.11.6），后端 Rust edition 2021
- 前端：React 19.1 + TypeScript 6.0（`strict`、`noUnusedLocals`/`noUnusedParameters` 均已开启）+ Vite 8.0
- 状态管理：Zustand 5.0.3
- 编辑器：monaco-editor 0.56
- 终端：@xterm/xterm 6 + addon-fit 0.11 + addon-webgl 0.19
- 其他：notify 8.2（文件监听）、portable-pty 0.9（伪终端）、tauri-plugin-dialog 2（目录选择）

## 2. 目录结构

```
lite-ide/
├── src/                        前端（42 个 ts/tsx + 样式）
│   ├── commands/index.ts       全部 IPC 调用的唯一出口（21 个命令封装）
│   ├── config/keybindings.ts   键位动作定义 / 解析 / 录制校验 / 双击 Ctrl 标记
│   ├── components/
│   │   ├── Layout/             AppLayout（三栏骨架/快捷键/关窗保护/设置覆盖区）、ActivityBar、
│   │   │                       TopBar、StatusBar、WorkspacePicker、CloseConfirmDialog
│   │   ├── FileTree/           FileTree、TreeNode、ContextMenu、NameInputDialog、
│   │   │                       ConfirmDialog、FileIcon、FolderIcon
│   │   ├── Editor/             Editor（Monaco 实例）、Tabs（含未保存确认）
│   │   ├── Terminal/           Terminal（xterm 多标签实例、工具栏、任务终端）
│   │   ├── Tasks/              TaskCenter（任务中心下拉）
│   │   ├── Settings/           SettingsView + General / Editor / Terminal / Tasks / Keyboard 五分区
│   │   ├── Toast/              ToastStack（全局 Toast 栈）
│   │   └── Splitter.tsx        可拖拽分隔条
│   ├── editor/                 monacoSetup（worker 环境）、modelStore（模型生命周期）
│   ├── stores/                 workspaceStore、fileTreeStore、editorStore、configStore、
│   │                           terminalStore、taskStore、uiStore
│   ├── types/index.ts          DirEntry / TreeNode / Tab / CursorInfo
│   ├── utils/                  language.ts（basename/dirname/joinPath/语言映射）、
│   │                           taskVariables.ts（任务变量展开 + Windows 路径归一化）
│   └── App.css                 全部样式（1445 行）
└── src-tauri/                  后端（15 个 Rust 文件 + 配置）
    ├── src/
    │   ├── lib.rs              插件与命令注册（21 个命令）
    │   ├── state.rs            AppState：workspace / watcher / terminals（HashMap<id, session>）三把 Mutex
    │   ├── session.rs          session.json 读写（容错降级）
    │   ├── config.rs           user.json 解析/钳制/写回、configured_shell、app_config_dir
    │   ├── shell.rs            shell 探测：Windows pwsh→powershell→cmd，Unix $SHELL→/bin/sh
    │   ├── tasks.rs            tasks.json 解析（TaskSpec，格式错误返回可读文案）
    │   ├── watcher.rs          notify 递归监听 + 500ms 防抖 + 事件下发
    │   ├── terminal.rs         PTY 会话 + reader/flusher 双线程批处理
    │   ├── error.rs            统一错误文案
    │   └── commands/
    │       ├── fs.rs           10 个文件系统/工作区命令 + 边界/名称校验
    │       ├── terminal.rs     6 个终端命令 + cwd 规范化
    │       ├── tasks.rs        load_tasks（读全局 tasks.json）
    │       └── config.rs       get/set_user_config + read/write_global_file（白名单 tasks.json）
    ├── capabilities/default.json  权限声明
    └── tauri.conf.json            窗口与打包配置
```

## 3. 分层与数据流

```
React 组件 ──► Zustand store ──► src/commands/index.ts ──► invoke() ──► Rust #[tauri::command]
     ▲                                                                          │
     └───────────── 事件 file-system-changed（string[]）◄── watcher.rs ◄─────────┘
     ▲                                                                          │
     └───────────── 终端输出 Channel<Vec<u8>>（per-session）◄── terminal.rs ◄─────┘
```

- 前端**不直接访问文件系统**，所有能力经 IPC 走 Rust；
- 工作区路径、watcher、终端会话（多会话 `HashMap<u64, TerminalSession>`）三者都保存在 Rust 侧 `AppState`（内存态）；
- 启动顺序：**先加载 `user.json`（`configStore.load()`），再据 `general.restoreLastWorkspace` 决定是否恢复上次工作区**，因此配置可以关闭自动恢复；
- 打开工作区会重置 `editorStore` / `fileTreeStore` / `terminalStore` / `taskStore` 的运行时状态并重新 `loadRoot`；任务列表为全局配置，不随工作区切换丢失。

## 4. IPC 命令清单（21 个）

| # | 命令 | 参数 | 返回 | 说明 |
|---|---|---|---|---|
| 1 | `list_dir` | `path` | `Entry[]` | 目录列举，隐藏目录过滤 + 目录优先排序 |
| 2 | `read_file` | `path` | `string` | UTF-8 读取，非 UTF-8 明确报错 |
| 3 | `write_file` | `path`, `content` | — | 保存文件 |
| 4 | `create_file` | `parent`, `name` | `Entry` | 新建文件 |
| 5 | `create_dir` | `parent`, `name` | `Entry` | 新建文件夹 |
| 6 | `rename_entry` | `path`, `newName` | `string` | 重命名，返回新路径 |
| 7 | `delete_entry` | `path` | — | 删除文件或递归删除目录 |
| 8 | `set_workspace` | `path` | `string` | 校验并设置工作区，重启 watcher、清理终端并写入 session |
| 9 | `get_workspace` | — | `string \| null` | 当前工作区 |
| 10 | `get_last_workspace` | — | `string \| null` | 上次工作区（目录不存在时返回 `null`） |
| 11 | `terminal_spawn` | `id`, `channel` | — | 用配置的 shell 在新 PTY 中启动会话，注册到 `id` |
| 12 | `terminal_write` | `id`, `data` | — | 向 PTY 写入用户输入 |
| 13 | `terminal_resize` | `id`, `cols`, `rows` | — | 同步 PTY 尺寸 |
| 14 | `terminal_kill` | `id` | — | 结束该会话（Windows 清理进程树） |
| 15 | `terminal_kill_all` | — | — | 结束全部会话（切工作区/退出） |
| 16 | `get_shells` | — | `string[]` | 本机可用 shell（按优先级排序） |
| 17 | `load_tasks` | — | `TaskSpec[] \| null` | 读全局 `tasks.json`，缺失返回 `null` |
| 18 | `get_user_config` | — | `UserConfig` | 默认值合并 `user.json` 后的完整配置 |
| 19 | `set_user_config` | `config` | — | 钳制/回退后写回 `user.json` |
| 20 | `read_global_file` | `name` | `string \| null` | 读全局配置（白名单 `tasks.json`） |
| 21 | `write_global_file` | `name`, `content` | — | 写全局配置（白名单 `tasks.json`） |

## 5. 事件契约

| 事件 | 载荷 | 触发方 | 消费方 |
|---|---|---|---|
| `file-system-changed` | `string[]`（去重并排序的绝对路径） | `watcher.rs`（500ms 防抖后批量 emit） | `AppLayout`：同时驱动 `fileTreeStore.onFileSystemChanged` 与 `editorStore.onExternalChange` |

终端输出**不走全局事件**：`terminal_spawn` 时前端传入独立的 `Channel<Vec<u8>>`，每个 PTY 会话独占一条通道（空数据块 = 进程退出标记）。

## 6. 前端状态管理

| 模块 | 职责 |
|---|---|
| `workspaceStore` | 工作区路径、`init`（恢复上次工作区）、`openWorkspace`（设置并重置其余 store） |
| `fileTreeStore` | 树的加载与刷新（`loadRoot`/`toggleDir`/`loadChildren`/`refreshPath`/`revealPath`）、CRUD 包装、`selectedPath`、`version` 竞态令牌 |
| `editorStore` | 打开标签、`activePath`、脏状态、`save`，关闭流程、外部变更、光标信息、`openGlobalFile`（外部标签打开 `tasks.json`，保存路由到 `writeGlobalFile`） |
| `configStore` | 用户配置加载/热更新、`settingsOpen`、键位录制落盘（`saveKeybinding` 冲突检测）、shell 列表 |
| `terminalStore` | 终端记录（id/name/exited/kind）、多标签 create/close/select、退出标记 |
| `taskStore` | 任务列表、任务中心开关、任务终端 id、运行状态、`runTask`（变量解析→排队→任务终端执行） |
| `uiStore` | 全局 Toast 提示 |
| `editor/modelStore` | Monaco `ITextModel` 生命周期、`savedVersion` 脏判定、`rekeyPath`（重命名保留脏状态）、`setModelContent`（静默重载） |

`version` 令牌用于丢弃过期的异步加载结果（切换工作区、重复加载时的竞态保护）。

## 7. 编辑器模型与脏状态

- 每个打开的文件对应一个 Monaco `ITextModel`（URI 由文件路径规范化而来，反斜杠统一为 `/`）；
- 脏状态 = `model.getVersionId() !== savedVersion`，内容变更时通过回调同步到 `editorStore`；
- 保存成功后把 `savedVersion` 推进到当前版本；
- 外部变更且本地非脏时，用 `suppressChange` 抑制回调再更新内容，避免误标脏；
- 重命名时 `rekeyPath` 把旧模型内容迁移到新路径并保留脏状态；
- 全局配置文件（`tasks.json`）以 `external` 标签打开，保存走 IPC `write_global_file`（命令白名单），不经过普通文件系统路径；编辑器参数（字号/制表符/换行/缩略图）通过订阅 `configStore` 热应用到活动 Monaco 实例。

## 8. 文件系统安全边界

所有文件操作都以当前工作区为根，并经过以下校验：

| 函数 | 作用 |
|---|---|
| `validate_within_workspace` | 词法归一化 `.`/`..` → 从最深存在祖先 `canonicalize` → 校验 `starts_with(workspace)` → 拼回未存在后缀；覆盖绝对路径越界与 symlink 逃逸 |
| `leaf_path_within_workspace` | 建/改/删目标：父目录 canonicalize（防 symlink 逃逸），叶子本身不 canonicalize（操作 symlink 自身而非跟随） |
| `validate_entry_name` | 名称合法性：非空、非 `.`/`..`、不含 `/` 与 `\`、Windows 保留字符 `< > : " \| ? *`、不以 `.` 或空格结尾 |
| 根目录保护 | 禁止删除或重命名工作区根目录 |
| 冲突保护 | 目标已存在时拒绝创建/重命名，避免覆盖 |

全局配置文件（`read_global_file`/`write_global_file`）不受工作区约束，但路径被硬性白名单 `GLOBAL_CONFIG_FILES = ["tasks.json"]` 锁死，只能访问应用配置目录内的这一个文件。

## 9. 目录过滤三套规则（实现）

| 常量 | 定义位置 | 消费点 | 语义 |
|---|---|---|---|
| `HIDDEN_DIRS`（5 项） | `commands/fs.rs` | `do_list_dir` → `is_hidden_name` | 不出现在文件树 |
| `IGNORED_DIRS`（6 项，含 `node_modules`） | `commands/fs.rs` | `path_is_ignored` → `watcher.rs` | 丢弃文件系统事件 |
| `AUTO_REVEAL_SKIP`（`node_modules`） | `stores/fileTreeStore.ts` | `revealPath` | 自动定位时不展开 |

- 前两者按「路径组件名字相等」匹配：实现成本低，但不区分位置（任何层级同名目录都会命中）；
- `watcher.rs` 仅在事件路径位于工作区内且未被忽略时才收集，500ms 后批量 `emit`；
- `revealPath` 先设置高亮，再判断是否需要展开，命中 `AUTO_REVEAL_SKIP` 时直接返回。

## 10. 持久化与配置

三份 JSON 全部位于 `app_config_dir()`（Windows：`%APPDATA%\com.longanl.lite-ide\`）：

| 文件 | 内容 | 读写入口 | 容错 |
|---|---|---|---|
| `session.json` | `{ "last_workspace": "…" }` | `set_workspace` 写；`get_last_workspace` 读 | 缺失/损坏/目录消失一律降级为 `null`，回退欢迎页 |
| `user.json` | `keybindings` / `editor` / `terminal` / `general`（camelCase） | `config.rs` `load`/`save` | 缺失用默认值；损坏用默认值并 toast 提示；未知键位动作忽略；值越界钳制、空 shell 回 `auto`、非法 `wordWrap` 归 `off` |
| `tasks.json` | `{ "tasks": [{ "name", "command" }] }` | `load_tasks` 读；`write_global_file` 写（设置内编辑） | 缺失视为空列表；格式错误在任务中心显示「tasks.json 格式错误」 |

生效时机：

| 配置 | 热应用 | 新会话 | 下次启动 | 需手动重启 |
|---|---|---|---|---|
| 编辑器参数（字号/制表符/换行/缩略图） | ✅ | | | |
| 键盘快捷键 | ✅ | | | |
| 终端默认 shell | | ✅（spawn 时读取） | | |
| 关窗确认 | ✅ | | | |
| 恢复上次文件夹 | | | ✅ | |
| `tasks.json` 任务列表 | | | | ✅ |

## 11. 任务系统

- **来源**：全局 `tasks.json`（见 §10）；`TaskSpec{ name, command }`，前端不解析，由 Rust `parse_tasks` 校验。
- **任务中心（下拉）**：活动栏「任务」按钮或 `Ctrl+Ctrl` 打开；`↑`/`↓` 选择、`Enter` 运行、`Esc` 关闭。
- **变量展开**：`resolveTaskCommand`（`utils/taskVariables.ts`）支持 8 个占位符：`workspaceFolder`、`workspaceFolderBasename`、`file`、`fileBasename`、`fileBasenameNoExtension`、`fileDirname`、`relativeFile`、`relativeFileDirname`。`relativeFile`/`relativeFileDirname` 按 workspace 前缀剥离并统一正斜杠。
- **Windows 路径归一化**：`normalizeTaskPath` 对绝对路径变量（`workspaceFolder`/`file`/`fileDirname`）剥离 `canonicalize` 产生的 `\\?\`（含 `\\?\UNC\`）前缀，避免 shell 工具（MinGW `g++`）拒绝；工作区内部 canonical 路径与 §8 安全校验不受影响。
- **任务终端**：`taskStore.runTask` 解析命令 → `ensureTaskTerminal()` 复用/创建固定「任务」标签 → 若正在运行先 `terminalWrite(id, "\u0003")` 中断并等待 350ms → `terminalWrite` 写入命令加 `\r`；shell 已退出则先重启、spawn 未完成则排队。
- 需要 `file*` 变量的任务在无活动文件时拒绝运行并 toast 提示；任务列表为全局，不随工作区切换丢失。

## 12. 终端多会话与键盘行为

- **多会话**：Rust `AppState.terminals` 为 `HashMap<u64, TerminalSession>`，按前端分配的 `id` 注册；spawn/写/改/杀均带 `id`，互不干扰。
- **默认 shell**：`terminal_spawn` 时读取 `config.rs::configured_shell`（用户配置存在且文件仍有效时用之，否则 `shell.rs::current_shell` 探测：Windows `pwsh.exe`→`powershell.exe`→`cmd.exe`，Unix `$SHELL`→`/bin/sh`）；只在 spawn 时解析，运行中会话不受之后配置修改影响。
- **cwd 规范化**：`normalize_cwd` 在 spawn 前把 `\\?\…` / `\\?\UNC\…` 还原为 shell 可接受的普通路径（与任务变量归一化同源问题、不同层级处理）。
- **键盘（JetBrains 风格 Ctrl+C）**：xterm 实例经 `attachCustomKeyEventHandler` 拦截；仅对获得焦点的当前实例生效（隐藏实例不接收键盘事件），普通终端与任务终端共用同一 hook：
  - 有选区：`Ctrl+C` → `navigator.clipboard.writeText(selection)`，返回 `false` 吞掉事件（不发 `\x03`、不触发 WebView 默认行为）；
  - 无选区：`Ctrl+C` → 交还 xterm 默认处理，发送 `\x03` 中断；
  - `Ctrl+V`、`Ctrl+Shift+C` 等不受影响。

## 13. Tauri 权限与窗口配置

- 权限（`capabilities/default.json`）：`core:default`、`core:window:allow-destroy`（关窗确认后强制退出）、`core:window:allow-set-title`（标题跟随工作区）、`dialog:default`（目录选择）；
- 终端复制使用 WebView 的 `navigator.clipboard`（标准 Web API），无需额外能力声明；事件监听（`listen`、`onCloseRequested`）依赖 `core:event:default` 中的 `allow-listen`；
- 窗口（`tauri.conf.json`）：默认 `800×600`，最小 `720×480`，`beforeDevCommand` 为 `pnpm dev`，`frontendDist` 指向 `../dist`。

## 14. 测试覆盖（42 个 Rust 单测）

| 模块 | 覆盖点 |
|---|---|
| `commands/fs.rs` | 路径归一化、工作区内/外目标校验、绝对路径与 `..` 逃逸、symlink 逃逸、名称合法性、文件与目录创建、重复创建、重命名与冲突、删除（含递归）、根目录保护、隐藏目录过滤、watcher 忽略判定 |
| `commands/terminal.rs` | Windows 扩展长度路径（`\\?\`）与 UNC 前缀还原、普通路径保持不变 |
| `config.rs` | 默认键位、键位合并/未知动作忽略、编辑器/终端/通用覆盖解析、缺失分区回退、越界钳制、空 shell 回退、损坏/空 `user.json` 降级、camelCase 序列化键名 |
| `tasks.rs` | 任务列表解析、空对象容错、非法 JSON、非对象根、缺 name/command 字段报错 |
| `session.rs` | session 解析、损坏 JSON、空输入、缺失字段容错 |

前端无测试框架，以 `tsc`/`vite build` 与手工清单验证（见 `docs/features.md` §13）。

## 15. 验证命令

```bash
cd src-tauri && cargo check     # Rust 类型检查
cd src-tauri && cargo test      # Rust 单测（42 个）
pnpm build                      # TypeScript 检查 + Vite 构建
pnpm tauri dev                  # 启动开发环境
```