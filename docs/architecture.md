# lite-ide 架构说明

> 版本 0.3.1

## 1. 技术栈与版本

- 应用外壳：Tauri 2（本地 2.11.6），后端 Rust edition 2021
- 前端：React 19.1 + TypeScript 6.0（`strict`、`noUnusedLocals`/`noUnusedParameters` 均已开启）+ Vite 8.0
- 状态管理：Zustand 5.0.3
- 编辑器：monaco-editor 0.56
- 终端：@xterm/xterm 6 + addon-fit 0.11 + addon-webgl 0.19
- 其他：notify 8.2（文件监听）、portable-pty 0.9（伪终端）、tauri-plugin-dialog 2（目录选择）、regex 1（全局搜索）
- 外部子进程协议：`Content-Length` 帧（`src-tauri/src/framing.rs`，LSP 与 DAP 共用）+ LSP（JSON-RPC 2.0）+ DAP（`Debug Adapter Protocol`，报文形状与 JSON-RPC 不同）
- 语言服务器（外部进程，从 PATH 查找）：rust-analyzer / clangd / typescript-language-server
- 调试适配器（外部进程，从 PATH 查找，由 `user.json` 的 `debug.adapters.<languageId>` 指定，如 lldb-dap）：**无内置默认值**

## 2. 目录结构

```
lite-ide/
├── src/                        前端（91 个 ts/tsx，含类型声明与样式）
│   ├── commands/index.ts       全部 IPC 调用的唯一出口（41 个命令封装）
│   ├── config/keybindings.ts   键位动作定义 / 解析 / 录制校验 / 双击 Ctrl 标记
│   ├── components/
│   │   ├── Layout/             AppLayout（骨架/快捷键/关窗保护/设置覆盖区/右侧栏）、ActivityBar、
│   │   │                       TopBar（自定义标题栏：Logo + 品牌 + 工作区名 + 三个布局切换按钮（左主栏 / 终端 / 右栏）
│   │   │                       + 任务中心 + 最小化/最大化(还原)/关闭 + 拖拽区）、StatusBar、
│   │   │                       RightSidebar、WorkspacePicker、CloseConfirmDialog
│   │   ├── FileTree/           FileTree、TreeNode、ContextMenu、NameInputDialog、
│   │   │                       ConfirmDialog、FileIcon、FolderIcon
│   │   ├── Editor/             Editor（Monaco 实例）、Tabs（含未保存确认）
│   │   ├── Debug/              DebugPanel（启动按钮 + 状态行 + 断点 / 调用堆栈 / 变量 / 输出）、
│   │   │                       DebugFloatToolbar（编辑器内的浮层会话工具栏）
│   │   ├── DiffView/           DiffView（只读 Monaco Diff 浮层：Git / 提交对比共用）
│   │   ├── Terminal/           Terminal（xterm 多标签实例、工具栏、任务终端、Debug 终端）
│   │   ├── Tasks/              TaskCenter（任务中心下拉）
│   │   ├── Search/             QuickOpen（覆盖式）、GlobalSearch（右侧栏）
│   │   ├── References/         ReferencesPanel（查找引用结果）
│   │   ├── Outline/            OutlinePanel（documentSymbol）
│   │   ├── Problems/           ProblemsPanel（Monaco markers 聚合）
│   │   ├── Settings/           SettingsView + General / Editor / Files / Terminal / Tasks / Debug / Keyboard 七分区
│   │   ├── Toast/              ToastStack（全局 Toast 栈）
│   │   └── Splitter.tsx        可拖拽分隔条
│   ├── editor/                 monacoSetup（worker 环境 + 关闭被 LSP 取代的 TS/JS worker 能力）、
│   │                           modelStore（模型生命周期）、cppOutline（C/C++ Outline 回退扫描器）
│   ├── lsp/                    protocol（wire 类型与转换）、languages（语言描述表）、
│   │                           client（通用 LSP 客户端：session/事件/provider/定义跳转/引用/重命名/签名/代码操作/格式化）、
│   │                           workspaceEdit（WorkspaceEdit 解析与安全应用）
│   ├── debug/                  types（调试领域类型，无语言分支）、protocol（DAP wire 类型与窄化辅助）、
│   │                           stateMachine（纯函数状态机 + 断点裁决合并）、
│   │                           launchConfig（启动配置：默认值 ⊕ 用户配置 ⊕ 变量展开、launch/attach）、
│   │                           session（协议编排：事件路由、断点推送、栈/线程/变量加载、启停）、
│   │                           editorDecorations（装订线断点圆点 + 当前执行行高亮）
│   ├── stores/                 workspaceStore、fileTreeStore、editorStore、configStore、gitStore、diffStore、
│   │                           terminalStore、taskStore、searchStore、debugStore、uiStore
│   ├── types/                  index.ts（DirEntry/TreeNode/Tab/CursorInfo）、monaco-internals.d.ts
│   ├── utils/                  language.ts（basename/dirname/joinPath/语言映射）、
│   │                           reveal.ts（openAndReveal：工作区内/外分流）、
│   │                           pathIdentity.ts（canonicalPath/fileKey/sameFile/isPathInsideWorkspace，
│   │                           路径同一性 + 工作区内判定，编辑器打开入口与「打开文件」共用）、
│   │                           autoSave.ts（自动保存调度：延迟/失焦触发）、
│   │                           taskVariables.ts（任务变量展开 + Windows 路径归一化）
│   └── App.css                 全部样式（3211 行，含 Phase 13.1 `--vo-*` 设计 Token 层与 `debug-*` 调试面板）
└── src-tauri/                  后端（29 个 Rust 源码文件 + 1 个集成测试 + 配置）
    ├── src/
    │   ├── lib.rs              插件与命令注册（41 个命令，含 10 个 Git / 4 个 LSP / 3 个调试）
    │   ├── state.rs            AppState：workspace / watcher / terminals(HashMap) / lsp(HashMap<语言, session>) /
    │   │                       debug(单个调试槽) / debug_terminal(被调试进程的终端 id)
    │   ├── session.rs          session.json 读写（容错降级）
    │   ├── config.rs           user.json 解析/钳制/写回（含 lsp、debug 节）、configured_shell、app_config_dir
    │   ├── shell.rs            shell 探测：Windows pwsh→powershell→cmd，Unix $SHELL→/bin/sh
    │   ├── tasks.rs            tasks.json 解析（TaskSpec，格式错误返回可读文案）
    │   ├── watcher.rs          notify 递归监听 + 500ms 防抖 + 事件下发
    │   ├── terminal.rs         PTY 会话 + reader/flusher 双线程批处理；spawn_program（程序即 PTY）+ DEBUG_TERMINAL_ID
    │   ├── framing.rs          Content-Length 帧编解码（LSP 与 DAP 共用，原 lsp/transport.rs）
    │   ├── error.rs            统一错误文案
    │   ├── debug/              内置 DAP 调试客户端（Phase 16）
    │   │   ├── mod.rs          适配器 argv 解析（PATH 解析、无默认值）/ initialize 参数 / launch 透传 / program 校验 /
    │   │   │                   runInTerminal 解析
    │   │   ├── session.rs      DebugSession：子进程、请求关联、事件转发、runInTerminal、生命周期（finish/shutdown）
    │   │   └── transport.rs    DAP 报文构造/分类/失败文案/适配器请求应答（非 JSON-RPC）
    │   ├── lsp/                内置 LSP 客户端
    │   │   ├── mod.rs          语言默认命令 / 命令解析 / root 解析 / initialize 能力
    │   │   ├── session.rs      单服务器会话（进程、stdio、请求关联、生命周期、事件）
    │   │   ├── rpc.rs          JSON-RPC 报文构造/分类/服务器请求应答
    │   │   ├── uri.rs          文件路径 ⇄ file:// URI
    │   │   └── cpp.rs          C/C++ 工具链发现（compile_commands.json / MinGW 回退）
    │   └── commands/
    │       ├── fs.rs           11 个文件系统/工作区命令 + 边界/名称/外部只读校验
    │       ├── search.rs       list_workspace_files / search_workspace
    │       ├── terminal.rs     6 个终端命令 + cwd 规范化
    │       ├── tasks.rs        load_tasks（读全局 tasks.json）
    │       ├── config.rs       get/set_user_config + read/write_global_file（白名单 tasks.json）
    │       ├── lsp.rs          4 个 LSP 命令（start/stop/notify/request，按语言路由）
    │       └── debug.rs        3 个调试命令（start/request/stop，全部 spawn_blocking）
    ├── tests/dap_lldb.rs       真实 lldb-dap 的端到端测试（工具缺失时跳过）
    ├── capabilities/default.json  权限声明
    └── tauri.conf.json            窗口与打包配置
```

仓库根另有 `.github/workflows/`：`ci.yml`（前端 `tsc + vite build` 与 Rust `cargo check`）、`release.yml`（`v*` 标签触发多平台 `tauri-action` 发布）。

## 3. 分层与数据流

```
React 组件 ──► Zustand store ──► src/commands/index.ts ──► invoke() ──► Rust #[tauri::command]
     ▲                                                                          │
     └───────── 事件 file-system-changed（string[]）◄── watcher.rs ◄─────────────┘
     ▲                                                                          │
     └───────── 终端输出 Channel<Vec<u8>>（per-session）◄── terminal.rs ◄────────┘
     ▲                                                                          │
     └── 事件 lsp-diagnostics / lsp-exited ◄── lsp/session.rs ◄── 语言服务器 ◄────┘
     ▲                                                                          │
     └── 事件 debug-event / debug-exited + 事件 debug-terminal-opened /
         debug-terminal-output / debug-terminal-exit ◄── debug/session.rs ◄── 调试适配器 ◄─┘
```

- 前端**不直接访问文件系统**，所有能力经 IPC 走 Rust；
- 工作区路径、watcher、终端会话（`HashMap<u64, TerminalSession>`）、语言服务器会话（`HashMap<String, Arc<LspSession>>`，键为语言 id）与**单个调试会话**（`Option<Arc<DebugSession>>`）都保存在 Rust 侧 `AppState`（内存态）；
- 启动顺序：**先加载 `user.json`（`configStore.load()`），再据 `general.restoreLastWorkspace` 决定是否恢复上次工作区**，因此配置可以关闭自动恢复；
- 打开工作区会重置 `editorStore` / `fileTreeStore` / `terminalStore` / `taskStore` / `searchStore` 的运行时状态并重新 `loadRoot`，并把 `debugStore` 的断点映射切到该工作区（**断点按工作区保留在内存**）；Rust 侧 `set_workspace` 停止全部终端、语言服务器与调试会话；任务列表为全局配置，不随工作区切换丢失。

## 4. IPC 命令清单（41 个）

| # | 命令 | 参数 | 返回 | 说明 |
|---|---|---|---|---|
| 1 | `list_dir` | `path` | `Entry[]` | 目录列举，隐藏目录过滤 + 目录优先排序 |
| 2 | `read_file` | `path` | `string` | 工作区内 UTF-8 读取，非 UTF-8 明确报错 |
| 3 | `read_external_file` | `path` | `string` | 工作区外单文件**只读**读取（见 §8） |
| 4 | `write_file` | `path`, `content` | — | 保存文件（工作区内） |
| 5 | `create_file` | `parent`, `name` | `Entry` | 新建文件 |
| 6 | `create_dir` | `parent`, `name` | `Entry` | 新建文件夹 |
| 7 | `rename_entry` | `path`, `newName` | `string` | 重命名，返回新路径 |
| 8 | `delete_entry` | `path` | — | 删除文件或递归删除目录 |
| 9 | `set_workspace` | `path` | `string` | 校验并设置工作区，重启 watcher、清理终端与语言服务器并写入 session |
| 10 | `get_workspace` | — | `string \| null` | 当前工作区 |
| 11 | `get_last_workspace` | — | `string \| null` | 上次工作区（目录不存在时返回 `null`） |
| 12 | `list_workspace_files` | — | `string[]` | 全部文件（工作区相对、`/` 分隔），供 Quick Open |
| 13 | `search_workspace` | `query`, `caseSensitive`, `useRegex` | `SearchMatch[]` | 全工作区内容搜索（上限见 §9.1） |
| 14 | `terminal_spawn` | `id`, `channel` | — | 用配置的 shell 在新 PTY 中启动会话，注册到 `id` |
| 15 | `terminal_write` | `id`, `data` | — | 向 PTY 写入用户输入 |
| 16 | `terminal_resize` | `id`, `cols`, `rows` | — | 同步 PTY 尺寸 |
| 17 | `terminal_kill` | `id` | — | 结束该会话（Windows 清理进程树） |
| 18 | `terminal_kill_all` | — | — | 结束全部会话（切工作区/退出） |
| 19 | `get_shells` | — | `string[]` | 本机可用 shell（按优先级排序） |
| 20 | `load_tasks` | — | `TaskSpec[] \| null` | 读全局 `tasks.json`，缺失返回 `null` |
| 21 | `get_user_config` | — | `UserConfig` | 默认值合并 `user.json` 后的完整配置（含 `lsp`） |
| 22 | `set_user_config` | `config` | — | 钳制/回退后写回 `user.json`（保留 `lsp`） |
| 23 | `read_global_file` | `name` | `string \| null` | 读全局配置（白名单 `tasks.json`） |
| 24 | `write_global_file` | `name`, `content` | — | 写全局配置（白名单 `tasks.json`） |
| 25 | `lsp_start` | `language`, `path?`, `command?` | `LspStartResult` | 懒启动某语言服务器（C/C++ 追加工具链参数） |
| 26 | `lsp_stop` | `language` | — | 停止某语言服务器 |
| 27 | `lsp_notify` | `language`, `method`, `params` | — | 发送通知（服务器未运行则静默） |
| 28 | `lsp_request` | `language`, `method`, `params` | `Value` | 发送请求并等待结果（10s 超时） |
| 29 | `git_detect_repository` | `workspace` | `boolean` | 仓库检测（`git rev-parse --show-toplevel`） |
| 30 | `git_status` | `workspace` | `GitStatus`（分双组） | 状态读取（`git status --short --untracked-files=all` + `git diff --stat`） |
| 31 | `git_stage` | `workspace`, `path` | — | 暂存单文件（`git add -- <path>`） |
| 32 | `git_unstage` | `workspace`, `path` | — | 取消暂存单文件（`git restore --staged -- <path>`） |
| 33 | `git_stage_all` | `workspace` | — | 全部暂存（`git add -A`） |
| 34 | `git_unstage_all` | `workspace` | — | 全部取消暂存（`git restore --staged -- .`） |
| 35 | `git_diff_file` | `workspace`, `path`, `side1`, `side2` | `string\|null` | 单文件 Diff 双侧读取（HEAD/索引/工作区/空 任意两侧，`git show` 回退磁盘） |
| 36 | `git_commit` | `workspace`, `message` | — | 提交（`git commit -m <message>`） |
| 37 | `git_log` | `workspace`, `oldestId?`, `limit` | `GitLogEntry[]` | 提交历史（分页光标 + 每页限制） |
| 38 | `git_commit_details` | `workspace`, `commitId` | `GitCommitDetails` | 提交详情（信息/时间/父提交/文件清单） |
| 39 | `debug_start` | `language`, `adapter?`, `request?`, `launch` | `DebugStartResult` | 启动适配器、`initialize`、写 `launch`/`attach` 后**立即返回**（不等响应，见 §16） |
| 40 | `debug_request` | `command`, `arguments` | `Value` | 发送任意 DAP 请求并返回其 `body`（10s 超时；会话已死则清槽并报错） |
| 41 | `debug_stop` | — | — | `disconnect(terminateDebuggee)` + 关闭 Debug 终端 + 强杀适配器 |

> 39–41 与其他命令一样在 Tauri 的阻塞线程池（`spawn_blocking`）中执行，因为每一次调用都要等适配器往返，不能占用主线程。

## 5. 事件契约

| 事件 | 载荷 | 触发方 | 消费方 |
|---|---|---|---|
| `file-system-changed` | `string[]`（去重并排序的绝对路径） | `watcher.rs`（500ms 防抖后批量 emit） | `AppLayout`：同时驱动 `fileTreeStore.onFileSystemChanged` 与 `editorStore.onExternalChange` |
| `lsp-diagnostics` | `{ language, uri, path, diagnostics }` | `lsp/session.rs`（`textDocument/publishDiagnostics`） | `lsp/client.ts`：按 `language` + `path` 路由到对应 model 的 markers |
| `lsp-exited` | `{ language, message }` | `lsp/session.rs`（进程退出/流中断，且非主动 shutdown） | `lsp/client.ts`：重置该语言状态并 toast |
| `debug-event` | `{ event, body }`（DAP 事件名与 body **原样**转发） | `debug/session.rs`（reader 线程） | `debug/session.ts`：路由 `initialized` / `stopped` / `continued` / `process` / `thread` / `terminated` / `exited` / `output` / `breakpoint` |
| `debug-exited` | `{ message }` | `debug/session.rs`（适配器进程退出或写入失败，且此前仍视为存活） | `debug/session.ts`：状态置 `disconnected` 并显示原因（不自动重启） |
| `debug-terminal-opened` | `{ id }` | `debug/session.rs`（完成 `runInTerminal` 后） | `debug/session.ts` → `terminalStore.ensureDebugTerminal()` |
| `debug-terminal-output` | `{ id, data: Vec<u8> }`（空数据块 = 进程退出） | `debug/session.rs`（被调试进程的 PTY） | `Terminal.tsx`：仅当 `id === DEBUG_TERMINAL_ID` 时写入该 xterm |
| `debug-terminal-exit` | `{ id }` | `debug/session.rs`（`runInTerminal` 的 PTY 读线程遇到空数据块） | `Terminal.tsx` → 终端标签显示「(已退出)」 |

普通终端输出**不走全局事件**：`terminal_spawn` 时前端传入独立的 `Channel<Vec<u8>>`，每个 PTY 会话独占一条通道（空数据块 = 进程退出标记）。**Debug 终端由后端管理 PTY**：带 `program` 的 launch 由后端直接启动进程并 attach 适配器；适配器也可通过 `runInTerminal` 请求启动程序。两种路径均通过 `debug-terminal-*` 事件传输输出。

## 6. 前端状态管理

| 模块 | 职责 |
|---|---|
| `workspaceStore` | 工作区路径、`init`（恢复上次工作区）、`openWorkspace`（设置并重置其余 store） |
| `fileTreeStore` | 树的加载与刷新（`loadRoot`/`toggleDir`/`loadChildren`/`refreshPath`/`revealPath`）、CRUD 包装、`selectedPath`、`version` 竞态令牌 |
| `editorStore` | 打开标签、`activePath`、脏状态、`save`，关闭流程、外部变更、光标信息、`openGlobalFile`（外部标签打开 `tasks.json`）、`openExternalFile`（只读外部文件，见 §7） |
| `configStore` | 用户配置加载/热更新、`settingsOpen`、键位录制落盘（`saveKeybinding` 冲突检测）、shell 列表、`lsp` 配置、`debug` adapter 与 legacy per-language 配置、全局 `launch.json` 的解析/加载/错误状态、`ensureUserConfigFile` |
| `searchStore` | Quick Open 文件索引与开关、左侧主栏当前视图（`activePrimarySidebar`：explorer/sourceControl/tasks/debug/null）、右侧栏开关与当前标签（search/references/outline/problems）、查找引用结果（`references`/`referencesSymbol`/`referencesLoading`） |
| `terminalStore` | 终端记录（id/name/exited/kind：normal/task/debug）、多标签 create/close/select、退出标记、`ensureDebugTerminal`、Debug sessionId owner 与按 session 清空输出 buffer / 请求 xterm reset |
| `debugStore` | 一个 `DebugState`（纯 reducer 产生，每次启动重建）+ `breakpointsByFile` / `breakpointsByWorkspace`（**按工作区保留、内存态**）+ `workspaceKey`；`toggleBreakpoint` / `syncBreakpoints` / `recordBreakpointVerdict` / `syncAllBreakpoints` / `activateWorkspace` / `clearBreakpoints` |
| `taskStore` | 任务列表、任务中心开关、任务终端 id、运行状态、`runTask`（变量解析→排队→任务终端执行） |
| `uiStore` | 全局 Toast 提示 |
| `editor/modelStore` | Monaco `ITextModel` 生命周期、`savedVersion` 脏判定、`rekeyPath`（重命名保留脏状态）、`setModelContent`（静默重载） |

`version` 令牌用于丢弃过期的异步加载结果（切换工作区、重复加载时的竞态保护）。切换工作区时 `searchStore` 通过 `workspaceStore.subscribe` 清空文件索引。

## 7. 编辑器模型、脏状态与外部只读

- 每个打开的文件对应一个 Monaco `ITextModel`（URI 由文件路径规范化而来，反斜杠统一为 `/`）；
- 脏状态 = `model.getVersionId() !== savedVersion`，内容变更时通过回调同步到 `editorStore`；
- 保存成功后把 `savedVersion` 推进到当前版本；
- 外部变更且本地非脏时，用 `suppressChange` 抑制回调再更新内容，避免误标脏；
- 重命名时 `rekeyPath` 把旧模型内容迁移到新路径并保留脏状态；
- 全局配置文件（`tasks.json`）以 `external` 标签打开，保存走 IPC `write_global_file`（命令白名单），不经过普通文件系统路径；
- **只读外部文件**：`openExternalFile` 读取工作区外文件（`read_external_file`），以 `readOnly: true` 标签打开，`onChange` 回调为空（**从不置脏**），`save()` 直接返回 `false`，`onExternalChange` 跳过，关闭时不进入最近关闭历史，切换工作区随 `reset()` 关闭；编辑器参数通过订阅 `configStore` **按字段**热应用到活动 Monaco 实例（仅 `editor.theme` 变化时调用 `setTheme`，其余字段各自 `updateOptions`，不重建 Editor / Model）；`Ctrl/Cmd+滚轮` 缩放字号是**唯一旁路 store 的参数变更**（见 12）。

## 8. 文件系统安全边界

所有文件操作都以当前工作区为根，并经过以下校验：

| 函数 | 作用 |
|---|---|
| `validate_within_workspace` | 词法归一化 `.`/`..` → 从最深存在祖先 `canonicalize` → 校验 `starts_with(workspace)` → 拼回未存在后缀；覆盖绝对路径越界与 symlink 逃逸 |
| `leaf_path_within_workspace` | 建/改/删目标：父目录 canonicalize（防 symlink 逃逸），叶子本身不 canonicalize（操作 symlink 自身而非跟随） |
| `validate_entry_name` | 名称合法性：非空、非 `.`/`..`、不含 `/` 与 `\`、Windows 保留字符 `< > : " \| ? *`、不以 `.` 或空格结尾 |
| 根目录保护 | 禁止删除或重命名工作区根目录 |
| 冲突保护 | 目标已存在时拒绝创建/重命名，避免覆盖 |

**工作区外单文件读取（`read_external_file`）** 是唯一的越界读入口，且只读、无写入对应命令，校验严格：绝对路径 → 拒绝任何 `.`/`..` 组件 → `canonicalize`（symlink 必须解析为存在的文件）→ 必须为普通文件 → UTF-8 读取。它用于语言服务定义跳转打开工作区外文件（如 rustlib / 系统头文件）。

全局配置文件（`read_global_file`/`write_global_file`）不受工作区约束，但路径被硬性白名单 `GLOBAL_CONFIG_FILES = ["tasks.json"]` 锁死，只能访问应用配置目录内的这一个文件。

## 9. 项目导航

### 9.1 Quick Open / 全局搜索（Rust 端）

- `list_workspace_files`：递归 `collect_files`（跳过 `HIDDEN_DIRS`、**包含** `node_modules`、不跟随 symlink 目录），返回工作区相对 `/` 路径并排序。
- `search_workspace`：`Query` 枚举（Plain/Regex），逐文件逐行匹配；上限 `MAX_TOTAL_MATCHES=2000`、`MAX_MATCHES_PER_FILE=200`、`MAX_SCAN_BYTES=4MB`，非 UTF-8 跳过；正则非法返回可读错误。列号按字符（非字节）计算以适配非 ASCII。
- 前端 `QuickOpen` 做子序列模糊评分与排序；`GlobalSearch` 300ms 防抖、`seq` 令牌丢弃过期结果；两者与 Problems/Outline 均通过 `utils/reveal.ts` 的 `openAndReveal` 跳转。

### 9.2 大纲 / 问题

- **Outline** 直接复用 Monaco 的 `documentSymbol` 提供者（即语言服务），通过 `OutlineModel` 构建符号树；C/C++ 在没有 `clangd` 时回退到 `editor/cppOutline.ts` 的正则行扫描（`cppDocumentSymbols`）。
- **Problems** 读取 `monaco.editor.getModelMarkers({})`，经 `pathForModel` 映射到路径并按文件分组。

## 10. 内置 LSP 客户端架构

自建实现，不依赖第三方 LSP 集成；前端只用标准 `monaco.languages` provider API。

### 10.1 后端（`src-tauri/src/lsp/`）

- `crate::framing`（原 `lsp/transport.rs`，现由 LSP 与 DAP 共用）：`Content-Length` 帧编码（`frame_message`/`write_message`）与增量解码（`FrameDecoder`，含 EOF/畸形头/非法 JSON 分类、解码缓冲上限）。
- `rpc.rs`：构造 request/notification/response，`classify_message` 区分服务器响应、通知、服务器→客户端请求；`reply_for_server_request` 对 `workspace/configuration` 等按协议应答，未知方法回 `-32601`。
- `session.rs`：`LspSession`（子进程 + stdin + `PendingRequests` 请求关联 + `running` 标志 + `language`/`label`）。reader 线程解码并分发；请求 10s 超时；`shutdown()` 走 `shutdown`→`exit`→宽限→强杀，先置停止态避免把主动关闭误报为崩溃；`mark_failed` 仅在进程此前仍存活时 emit `lsp-exited`。
- `mod.rs`：`default_command(language)`（rust-analyzer / clangd / typescript-language-server --stdio）、`resolve_command`、`resolve_root`（Rust 找最近 `Cargo.toml`，其余用工作区根）、`initialize_params`（能力含 `publishDiagnostics`——某些服务器不声明就不推送诊断）。
- `cpp.rs`：C/C++ 工具链发现（见 10.3）。
- `commands/lsp.rs` + `state.rs`：四个命令按 `language` 路由到 `HashMap<String, Arc<LspSession>>`；`set_workspace` / 退出调用 `stop_all_lsp`。

### 10.2 前端（`src/lsp/`）

- `languages.ts`：语言描述表（id / Monaco 语言 / 扩展名 / 触发字符 / Outline 回退），并据此派生**单一**的 Monaco 选择器与触发字符集合。`serverCommand` 从 `configStore.lsp` 解析命令。
- `client.ts`：通用客户端。模块态保存 `docs`（URI→model+listener+language）、`changeTimers`（150ms 防抖）、`activeLanguages`、`startGates`、`previewModels`（定义目标预览模型）。职责：
  - **会话**：`ensureServer`（每语言懒启动，失败 toast 并允许重试）、`resetLanguage`/`resetAllLanguages`、`openDocModel`/`closeDocModel`（`didOpen`/`didChange`/`didClose`；仅工作区文件发送给服务器）；关闭某语言最后一个文档时 `lspStop` 并重置。
  - **Provider**：补全/悬停/定义/`documentSymbol` 各注册**一次**，按 `languageForModel` 分发到对应语言的 `lspRequest`。
  - **事件**：`lsp-diagnostics` 按语言+路径写入 markers；`lsp-exited` 重置该语言并 toast。
  - **定义跳转**：`fetchDefinitions`（带单槽缓存，键含 `versionId`）与 `jumpToDefinition`；定义 provider **只返回位置**并预建目标预览模型（避免 Ctrl+hover 触发跳转），真正的跳转由 `editor.onMouseDown` 的 **Ctrl/Cmd+左键**处理器执行，经 `openAndReveal` 分流（工作区内普通打开 / 工作区外只读标签）。
  - **工作区切换**：`queueMicrotask` 订阅 `workspaceStore`，路径变化时 `resetAllLanguages`（规避模块初始化期的 TDZ）。
- `monacoSetup.ts`：配置 worker、**关闭** Monaco 内置 TS/JS worker 中被 LSP 取代的能力（补全/悬停/定义/大纲/诊断），随后 `registerLspClient()`。
- `protocol.ts`：LSP wire 类型与 Monaco 转换（位置/范围/严重级别/符号与补全 kind、路径 ⇄ `file://` URI）。

### 10.3 C/C++ 工具链发现（`lsp/cpp.rs`）

- **数据库优先**：clangd 原生在源文件父目录与 `build/` 搜索 `compile_commands.json`；存在时以其编译命令为准（不追加任何覆盖参数），并移除本工具生成的受管 `.clangd`。
- **无数据库回退**：从 `PATH` 查找 `g++`（其次 `gcc`；Windows 为 `g++.exe`/`gcc.exe`），生成受管 `.clangd`（首行标记 `# Managed by lite-ide`，`CompileFlags.Compiler: <绝对路径（正斜杠）>`），启动参数追加 `--enable-config`（启用 `.clangd`）与 `--query-driver=<该路径>`（允许 clangd 调用它提取 libstdc++ 系统头文件）。
- 安全：项目自带 `.clangd`（文件或旧版目录）**绝不覆盖**；检测到数据库立即删除受管文件；无编译器可回退时清理残留。不硬编码任何 MinGW/MSVC/STL 路径。

### 10.4 语言能力扩展（Phase 12）

- **能力门控**：`lsp_start` 现在把服务器 `initialize` 结果里的 `capabilities` 一并返回；`client.ts` 用 `serverCapabilities: Map<语言, object>` 保存，`serverSupports()` 在请求前判断（未知=尝试一次，失败静默）。Rust 后端 `LspSession` 保存 capabilities 并暴露 getter（`session.rs`）。
- **新增 Provider（仍注册一次、按 model 语言分发）**：`registerReferenceProvider`、`registerRenameProvider`、`registerSignatureHelpProvider`、`registerDocumentFormattingEditProvider`、`registerDocumentRangeFormattingEditProvider`、`registerCodeActionProvider`。
  - 重命名用 Monaco 内建输入框驱动：`resolveRenameLocation` → `textDocument/prepareRename`，`provideRenameEdits` → `textDocument/rename` → `buildMonacoWorkspaceEdit`（会先打开目标文件，资源 URI 取真实 model 的 `uri`）。
  - 代码操作：把 `context.markers` 转为 LSP `Diagnostic` 传入；返回项统一封装成 Monaco 命令 `liteide.applyCodeAction`，执行时 `applyWorkspaceEdit` / `workspace/executeCommand`（`registerCommand` 注册一次）。
  - 格式化 options 取 `configStore.editor.tabSize`，`insertSpaces` 缺省 true。
- **WorkspaceEdit（`lsp/workspaceEdit.ts`）**：解析 `changes` 与 `documentChanges`（`TextDocumentEdit`），资源操作直接拒绝；工作区外目标拒绝并 toast；通过 `useEditorStore.openFile` 打开目标（保留本地未保存内容）后用 `model.pushEditOperations` 应用以保留撤销栈；写入前校验工作区未切换。
- **快捷键**：`F2`/`Shift+F12`/`Ctrl+.`/`Shift+Alt+F` 加入 `keybindings`（后端 `config.rs` 默认下发、前端 `config/keybindings.ts`），在 `AppLayout` 的**捕获阶段**监听（编辑器聚焦时），避免被 Monaco 内建同名按键吞掉；Rename/QuickFix/Format 复用 Monaco 内建 action。
- **引用 UI**：`findReferencesAtCursor` 请求 `textDocument/references` 后写入 `searchStore`，`ReferencesPanel` 在右侧栏「引用」标签分组展示。

## 11. 目录过滤三套规则（实现）

| 常量 | 定义位置 | 消费点 | 语义 |
|---|---|---|---|
| `HIDDEN_DIRS`（5 项） | `commands/fs.rs` | `do_list_dir` → `is_hidden_name` | 不出现在文件树 |
| `IGNORED_DIRS`（6 项，含 `node_modules`） | `commands/fs.rs` | `path_is_ignored` → `watcher.rs` | 丢弃文件系统事件 |
| `AUTO_REVEAL_SKIP`（`node_modules`） | `stores/fileTreeStore.ts` | `revealPath` | 自动定位时不展开 |

- 前两者按「路径组件名字相等」匹配：实现成本低，但不区分位置（任何层级同名目录都会命中）；`HIDDEN_DIRS` 同时用于 `search.rs`（`path_is_hidden`）以确保搜索不进入隐藏目录；
- `watcher.rs` 仅在事件路径位于工作区内且未被忽略时才收集，500ms 后批量 `emit`；
- `revealPath` 先设置高亮，再判断是否需要展开，命中 `AUTO_REVEAL_SKIP` 时直接返回。

## 12. 持久化与配置

配置文件位于 `app_config_dir()`（Windows：`%APPDATA%\com.longanl.lite-ide\`）：

| 文件 | 内容 | 读写入口 | 容错 |
|---|---|---|---|
| `session.json` | `{ "last_workspace": "…" }` | `set_workspace` 写；`get_last_workspace` 读 | 缺失/损坏/目录消失一律降级为 `null`，回退欢迎页 |
| `user.json` | `keybindings` / `editor` / `terminal` / `general` / `files` / `lsp` / `debug`（camelCase） | `config.rs` `load`/`save` | 缺失用默认值；损坏用默认值并 toast；未知键位动作忽略；值越界钳制、`general.theme` 非法回 `dark`、`editor.theme` 非法回 `vs-dark`、空 shell 回 `auto`、非法 `wordWrap` 归 `off`、`lsp` 空白命令/参数回退默认、`debug.adapters` 键名统一小写且空白 `command` 条目丢弃、`debug.launch` 只接受 JSON 对象并原样保留 |
| `tasks.json` | `{ "tasks": [{ "name", "command" }] }` | `load_tasks` 读；`write_global_file` 写（设置内编辑） | 缺失视为空列表；格式错误在任务中心显示「tasks.json 格式错误」 |

工作区内另有一份**受管** `.clangd`（仅 C/C++ 且无 `compile_commands.json` 时生成，见 10.3），首行带标记，出现数据库时自动删除。

生效时机：

| 配置 | 热应用 | 新会话 | 下次启动 | 需手动重启 |
|---|---|---|---|---|
| 编辑器参数（字体/连字/字号/制表符/换行/缩略图/行号/空白/行高亮/参考线/折叠/括号/滚动/光标） | ✅（按字段 `updateOptions`；字号经滚轮缩放时为手势内直传，收尾取整回 store） | | | |
| Monaco 配色主题（`editor.theme`） | ✅（`setTheme`） | | | |
| 主题（`general.theme`：dark/light/system） | ✅（`<html data-theme>`） | | | |
| 自动保存（`files.autoSave`） | ✅ | | | |
| 键盘快捷键 | ✅ | | | |
| 终端默认 shell | | ✅（spawn 时读取） | | |
| `lsp`（命令/参数） | | ✅（语言服务启动时读取） | | |
| `debug`（适配器命令 / 启动参数） | | ✅（每次启动调试时读取，改完重新 F5 即生效） | | |
| 关窗确认 | ✅ | | | |
| 恢复上次文件夹 | | | ✅ | |
| `tasks.json` 任务列表 | | | | ✅ |

**编辑器 `Ctrl/Cmd+滚轮` 缩放（字号）走独立的两段式路径**，其余参数都是「改 store → 订阅者热应用」：

1. **手势期间不碰 store**：每个滚轮事件只按 `deltaY` 比例累加到组件内的 `wheelFontSizeRef`（小数值），`requestAnimationFrame` 闸门保证每帧最多一次 `editor.updateOptions({ fontSize })`（Monaco 在字号缓存未命中时会重新做 41 个节点的字体测量，因此同帧多次变化只保留最后一次）；事件不产生 IPC、不写 `user.json`。
2. **停止 150ms 后提交一次**：`Math.round` 并钳制回 8–40，再走正常 `updateEditor` 写回 store 与 `user.json`（后端 `font_size: u32`，小数不可持久化，故取整是强制的）。因此屏幕上的瞬时值与落盘值最多差 0.5px，且在同一次提交内对齐。

## 13. 任务系统

- **来源**：全局 `tasks.json`（见 §12）；`TaskSpec{ name, command }`，前端不解析，由 Rust `parse_tasks` 校验。
- **任务中心（下拉）**：活动栏「任务」按钮或 `Ctrl+Ctrl` 打开；`↑`/`↓` 选择、`Enter` 运行、`Esc` 关闭。
- **变量展开**：`resolveTaskCommand`（`utils/taskVariables.ts`）支持 8 个占位符：`workspaceFolder`、`workspaceFolderBasename`、`file`、`fileBasename`、`fileBasenameNoExtension`、`fileDirname`、`relativeFile`、`relativeFileDirname`。`relativeFile`/`relativeFileDirname` 按 workspace 前缀剥离并统一正斜杠。
- **Windows 路径归一化**：`normalizeTaskPath` 对绝对路径变量（`workspaceFolder`/`file`/`fileDirname`）剥离 `canonicalize` 产生的 `\\?\`（含 `\\?\UNC\`）前缀，避免 shell 工具（MinGW `g++`）拒绝；工作区内部 canonical 路径与 §8 安全校验不受影响。
- **任务终端**：`taskStore.runTask` 解析命令 → `ensureTaskTerminal()` 复用/创建固定「任务」标签 → 若正在运行先 `terminalWrite(id, "\u0003")` 中断并等待 350ms → `terminalWrite` 写入命令加 `\r`；shell 已退出则先重启、spawn 未完成则排队。
- 需要 `file*` 变量的任务在无活动文件时拒绝运行并 toast 提示；任务列表为全局，不随工作区切换丢失。

## 14. 终端多会话与键盘行为

- **多会话**：Rust `AppState.terminals` 为 `HashMap<u64, TerminalSession>`，按前端分配的 `id` 注册；spawn/写/改/杀均带 `id`，互不干扰。
- **默认 shell**：`terminal_spawn` 时读取 `config.rs::configured_shell`（用户配置存在且文件仍有效时用之，否则 `shell.rs::current_shell` 探测：Windows `pwsh.exe`→`powershell.exe`→`cmd.exe`，Unix `$SHELL`→`/bin/sh`）；只在 spawn 时解析，运行中会话不受之后配置修改影响。
- **cwd 规范化**：`normalize_cwd` 在 spawn 前把 `\\?\…` / `\\?\UNC\…` 还原为 shell 可接受的普通路径（与任务变量归一化同源问题、不同层级处理）。
- **键盘（JetBrains 风格 Ctrl+C）**：xterm 实例经 `attachCustomKeyEventHandler` 拦截；仅对获得焦点的当前实例生效（隐藏实例不接收键盘事件），普通终端与任务终端共用同一 hook：
  - 有选区：`Ctrl+C` → `navigator.clipboard.writeText(selection)`，返回 `false` 吞掉事件（不发 `\x03`、不触发 WebView 默认行为）；
  - 无选区：`Ctrl+C` → 交还 xterm 默认处理，发送 `\x03` 中断；
  - `Ctrl+V`、`Ctrl+Shift+C` 等不受影响。

- **Debug 终端（调试专用）**：`terminal::DEBUG_TERMINAL_ID`（`1000000`，前端同值）是保留 id，PTY 里跑的不是 shell 而是被调试进程（`TerminalSession::spawn_program`，由适配器的 `runInTerminal` 反向请求触发）。它没有前端传入的 `Channel`，输出走 `debug-terminal-output` / `debug-terminal-exit` 事件，输入与尺寸仍复用 `terminal_write` / `terminal_resize`，停止调试时被 `kill_debug_terminal` 关闭。

## 15. Tauri 权限与窗口配置

- 权限（`capabilities/default.json`）：`core:default`、`core:window:allow-destroy`（关窗确认后强制退出）、`core:window:allow-set-title`（标题跟随工作区）、`core:window:allow-minimize` / `allow-toggle-maximize` / `allow-close` / `allow-start-dragging`（自定义标题栏的窗口控制与拖拽）、`dialog:default`（目录选择与「打开文件」）；
- 终端复制使用 WebView 的 `navigator.clipboard`（标准 Web API），无需额外能力声明；事件监听（`listen`、`onCloseRequested`）依赖 `core:event:default` 中的 `allow-listen`；
- 调试不需要新的权限声明：`debug_*` 命令是本应用自己的命令，事件监听同样走 `core:event:allow-listen`；
- 窗口（`tauri.conf.json`）：**`decorations: false`**（去掉系统原生标题栏，由 `TopBar` 自绘 36px 自定义标题栏）、默认 `800×600`，最小 `720×480`，`bundle.icon` 引用 `icons/` 下由项目 Logo 生成的图标，`beforeDevCommand` 为 `pnpm dev`，`frontendDist` 指向 `../dist`。

## 16. 内置 DAP 调试客户端（Phase 16）

```text
lite-ide
├── DAP 控制通路（Content-Length 帧，经 stdio 与适配器通信）
│   └── Debug Adapter（lldb-dap / cdt-gdb-adapter / debugpy / ...）
│       └── GDB / LLDB / Python 调试器 / ...
│           └── 控制 debuggee（launch 或 attach）
│
└── Debug Terminal（程序 I/O 通路）
    └── PTY
        └── debuggee
            ├── stdin
            ├── stdout
            └── stderr
```

两条通路职责分离：DAP 与适配器交换调试控制、断点、线程和栈帧等协议消息；被调试程序的 `stdin` / `stdout` / `stderr` 接入 Debug Terminal 的 PTY，不经过 DAP 输出流。带 `program` 的 launch 由后端先在 PTY 启动 debuggee，再让适配器 attach；适配器请求 `runInTerminal` 时则由后端按请求创建 PTY。

三条设计原则：**只说 DAP**（没有 GDB/MI 客户端，也没有任何调试器特定分支，`debugger` 是用户安装的外部进程）、**语言无关**（语言 id 只作为数据出现在 `debug.adapters.<languageId>` 与启动参数里，新增语言是改配置）、**不问不启动**（打开工作区不会 spawn 任何适配器，也不轮询）。消息层与 LSP 共用同一个帧编解码器（`framing.rs`），但 DAP **不是 JSON-RPC**（三种报文形状、`arguments`/`body` 的命名、`request_seq` 关联都不同），因此 `debug/transport.rs` 与 `lsp/rpc.rs` 是两套独立实现。

### 16.1 后端（`src-tauri/src/debug/`）

- `mod.rs`：`resolve_adapter_argv`（空配置 → `Debug adapter not configured: <language>`；**裸可执行名按 PATH 解析为绝对路径**，带路径参数原样保留）、`initialize_arguments`（DAP 客户端信息与能力声明）、`launch_arguments` / `verify_program`，以及 `debuggee_spec`（从 launch 参数提取程序、参数、cwd、env）；后端可据此先在 Debug PTY 启动程序，再用 adapter 对应的 PID 字段发送 attach。`runInTerminal` 仍作为适配器请求启动程序的另一条路径。
- `transport.rs`：`Incoming` 四态（Response / Request / Event / Invalid）+ `classify`（不认识的消息降级为 `Invalid`，绝不 panic——release 使用 `panic = "abort"`）、`build_request`/`build_response`/`SeqCounter`、`failure_text`（把适配器失败响应的 `message`/`body` 拼成可读文本）、`reply_for_adapter_request`（适配器发来的其它请求显式回失败，让它自行回退）。
- `session.rs`：`DebugSession`（`AppHandle` 可选——生产环境转发事件，集成测试传 `None` 直接驱动协议）：
  - **启动**：spawn 适配器（Windows 加 `CREATE_NO_WINDOW`，不弹控制台）、stdin/stdout 管道、stderr 交给独立线程排空（避免管道写满把适配器卡死）、reader 线程 `StreamReader` 增量解码（缓冲上限 16MB）；随后 `initialize` 并记下 `capabilities`。
  - **请求关联**：`SeqCounter` 分配 `seq`，`PendingRequests`（`mpsc`）把响应的 `request_seq` 关联回调用者；`request` 默认 10s 超时、`launch`/`attach` 用 60s。`send_request` **不登记**待响应项，用于响应可能延迟到首次停止之后的启动请求。
  - **事件**：`initialized` 既唤醒 `await_initialized`（500ms 宽限、25ms 轮询一次、适配器静默也继续配置）也转发给前端；`terminated` 触发 `finish_session`。
  - **Debuggee PTY**：带 `program` 的普通 launch 由 `commands/debug.rs` 直接启动 PTY 子进程并向适配器发送 attach；`runInTerminal` 则是唯一实现的适配器→客户端反向请求，用于适配器要求客户端启动程序的情况。两条路径都通过 `debug-terminal-*` 事件转发程序输出。
  - **结束**：`shutdown()` 发 `disconnect{ restart: false, terminateDebuggee: true }`（2s 宽限）→ 置 `running = false` → 批量失败在途请求 → 300ms 内自然退出则返回，否则 `force_kill`（Windows 连进程树）。`finish_session`（`terminated` 之后）**先清 `running` 再直接 reap**（不用 `shutdown`，否则会在 reader 线程上等自己的响应），并且只在槽位仍持有自己时才 `clear_debug_if_same`——因此适配器进程可以晚于「会话结束」退出，不会挡住下一次 F5，也不会误删接替它的新会话。
- `commands/debug.rs`：三个命令**全部 `spawn_blocking`**（每次调用都要等适配器往返，不能占主线程）：

| 命令 | 行为 |
|---|---|
| `debug_start` | 要求已打开工作区；已有会话且「运行中且未结束」→ 报错，否则清槽 + `shutdown` 旧会话；校验 `request` ∈ {launch, attach}；解析适配器 argv；`launch` 前 `verify_program`；带 `program` 的 launch 在 Debug PTY 启动进程并发送 attach，其余配置直接发送 launch/attach；启动请求不等响应，返回 `{ adapter, capabilities }` |
| `debug_request` | 取「运行中且未结束」的会话发请求并返回其 `body`；若请求后会话已死则按身份校验清槽，前端不会继续对死会话发请求 |
| `debug_stop` | `stop_debug()` + `kill_debug_terminal()`（关闭被调试进程的 PTY） |

### 16.2 前端（`src/debug/`）

- `types.ts`：语言无关领域类型（`DebugStatus` 六态、`FileBreakpoints`、`StackFrame`、`ScopeEntry`、`VariableEntry`、`DebugState`）；`protocol.ts` 是 DAP wire 类型与 `asRecord`/`asNumber`/`asString`/`sourcePath` 窄化辅助——**行号 1-based，与 Monaco 一致**，所以整条调试链路没有任何 ±1 转换（与 LSP 侧正好相反）。
- `stateMachine.ts`：纯 reducer `debugReducer(state, event)`；事件覆盖启动成功/失败、停止、继续、进程、线程、栈、变量、输出、错误、重置；输出保留 200 行、栈保留 100 帧。**状态只由 DAP 事件决定**，按钮点击从不直接写 `running`/`stopped`；`stopped`/`continued`/`terminated`/`exited` 都会丢弃上一次停止点的栈与变量，避免把旧数据当当前值展示。另导出 `mergeBreakpointVerdicts`（适配器没有提到的行保留为「未验证」而不是删除——用户的断点列表才是权威）、`breakpointRequest` 与按钮谓词（`isStartAction`/`isContinueAction`/`isStopped`/`hasSession`）。
- **断点路径不变量**：`setBreakpoints` 的 `Source.path` 必须使用**真实大小写的绝对路径**（Windows 下为原生反斜杠），由 `src/debug/sourcePath.ts` 的 `dapSourcePath()` 生成；适配器（如 GDB）拿它与自身调试信息做**大小写敏感**比较，因此 `fileKey()`（Windows 上会小写化的身份键）绝不用于出网路径——它只用于 Map 键、断点状态比较与装饰层匹配。
- `launchConfig.ts`：支持全局 `launch.json`（多配置解析、校验、adapter type 选择、额外字段透传），并保留 `user.json` 的 per-language fallback；统一执行默认值合并、变量展开与 `launch`/`attach` 请求判断。`request` 不作为 DAP 参数发出，C/C++ 默认程序为 `build/app`（Windows 追加 `.exe`）。
- `session.ts`：**唯一与适配器对话的地方**（编排层）。启动时序 `initialize → setExceptionBreakpoints → launch/attach`（后端完成）→ 等 `initialized` → `syncAllBreakpoints` → `configurationDone` → 全部由事件驱动；`stopped` 后依次拉 `threads` → `stackTrace` → frame 0 的 `scopes` → 各 scope 的 `variables`；`continue`/`pause`/`next`/`stepIn`/`stepOut` 都在发请求前**立即**清当前行标记（一次运行期间不能显示旧行）；新 session 通过 sessionId/owner 隔离旧事件并触发 Debug Terminal 清屏。
- `editorDecorations.ts`：编辑器装饰层。装订线常开（`glyphMargin: true`，会话开始后点击位置不会移动），点击 `GUTTER_GLYPH_MARGIN` 切换断点；已绑定 = 实心圆点、未解析 = 空心圆点；当前执行行整行高亮 + overview ruler 标记并跟随**选中的栈帧**；每轮整体重算（`deltaDecorations` 替换旧 id），不会泄漏装饰对象。
- UI 组装：`DebugPanel`（左侧主栏：启动/附加按钮、状态行、断点、调用堆栈（线程 > 1 才有下拉）、变量（可展开）、输出尾部）、`DebugFloatToolbar`（编辑器区绝对定位浮层：暂停/继续/单步/重启/停止，按 capabilities 门控——仅显式 `false` 才禁用）、`ActivityBar` 的「运行和调试」入口与会话徽标、`Editor.tsx` 订阅 `currentLocation` 做导航、`Terminal.tsx` 的 `DebugTerminalInstance`。
- 状态分层：`stores/debugStore.ts` 把「一次会话的 `DebugState`」与「按工作区的断点映射」分开——前者每次启动重建，后者在切换工作区时只是换一张表（`activateWorkspace`），因此断点不会因为会话结束或切走工作区而消失（内存态，重启 IDE 清空）。`workspaceStore` 在设置新工作区前后 `debugStop` + `reset`，Rust 侧 `set_workspace` / `RunEvent::Exit` 也会 `stop_debug`。

### 16.3 两个协议事实决定了上面的时序

1. **`launch` 响应会被推迟**：真实 `lldb-dap` 直到被调试进程**首次停止**才回 `launch` 响应，因此任何「等响应再继续」的写法都会与尚未发送的 `configurationDone` 互相等待而死锁。所以 `debug_start` 只把请求写出去（`send_request`，不登记待响应项）就返回；这个响应的迟到失败仍会打日志，适配器也常把它作为 `output` 事件报给前端。
2. **`initialized` 之前不能可靠下断点**：此时适配器还没加载目标符号，`setBreakpoints` 会被判为未验证，且程序尚未启动（要等 `configurationDone`）。所以前端等 `initialized` 事件后再逐文件推送断点，然后才发 `configurationDone`——这样「第 5 行的断点」在 `main` 执行前就已就位。

`await_initialized` 的 500ms 宽限正是为了兼容不发 `initialized` 的适配器：规范要求发，但仓库自带的端到端测试所用 `lldb-dap` 构建并不发，静默时继续配置比让整个会话失败更合理。

## 17. 测试覆盖（214 个 Rust 单测，Windows 上运行 213 个）

| 模块 | 数量 | 覆盖点 |
|---|---|---|
| `commands/fs.rs` | 21 | 路径归一化、工作区内/外目标校验、绝对路径与 `..` 逃逸、symlink 逃逸、名称合法性、文件与目录创建、重复创建、重命名与冲突、删除（含递归）、根目录保护、隐藏目录过滤、watcher 忽略判定、外部只读读取（绝对路径/穿越/目录/缺失/正常） |
| `commands/search.rs` | 6 | 文件列举跳过隐藏目录、隐藏目录判定、明文搜索（含 `node_modules`）、大小写敏感、正则（含非法）、空查询拒绝 |
| `commands/terminal.rs` | 5（含 1 个 `#[cfg(not(windows))]`） | Windows 扩展长度路径（`\\?\`）与 UNC 前缀还原、普通路径保持不变 |
| `config.rs` | 31 | 默认键位、键位合并/未知动作忽略、编辑器/终端/通用覆盖解析、缺失分区回退、越界钳制、`general.theme`/`editor.theme` 白名单回退、空 shell 回退、`lsp` 默认/覆盖/空白回退、`debug` 适配器/启动参数解析（键名小写归一、空白命令丢弃、非法 `launch` 忽略、整份配置写回时不丢 `debug` 节）、损坏/空 `user.json` 降级、camelCase 序列化键名 |
| `tasks.rs` | 5 | 任务列表解析、空对象容错、非法 JSON、非对象根、缺 name/command 字段报错 |
| `session.rs` | 4 | session 解析、损坏 JSON、空输入、缺失字段容错 |
| `watcher.rs` | 5 | 防抖判定（无事件不发、新事件被压住、安静批可发、持续写入按最大等待发、更早的首事件不能在安静期前发） |
| `debug/mod.rs` | 11 | 未配置适配器文案带语言 id、空白条目视为未配置、显式路径不被改写、PATH 解析、`runInTerminal` 请求解析（`args[0]` 为程序 / 缺程序报错 / `env` 只保留字符串值）、`initialize` 声明 1-based 与 `pathFormat: path`、`launch` 非对象归一为空对象、`program` 缺失前置校验 |
| `debug/session.rs` | 6 | 请求 id 与响应关联、失败响应带适配器文案、适配器死亡时批量失败、事件与垃圾数据不影响在途请求、`terminated` 标记会话结束且不可复用、`exited` 单独出现不结束会话 |
| `debug/transport.rs` | 16 | 三类报文分类（含未知事件不误判为非法）、畸形消息不 panic、JSON-RPC 形状不会被误认成 DAP、`seq` 单调、请求用 `arguments` 而非 `params`、响应带 `request_seq`、失败响应带 message、`runInTerminal` 被显式拒绝且文案含被丢弃的程序、未知适配器请求被拒绝、失败文案优先取适配器消息 |
| `framing.rs`（原 `lsp/transport.rs`，LSP 与 DAP 共用） | 15 | 帧编解码、跨读分片、多消息、精确 Content-Length、缺失/非数字长度、空消息往返 |
| `lsp/mod.rs` | 5 | 每语言默认命令与解析、root 解析（Rust 项目根 / C·TS 工作区根 / Cargo.toml 上溯 / 回退）、`initialize` 能力（含 `publishDiagnostics`） |
| `lsp/session.rs` | 5 | 请求 id 单调、响应关联、错误转发、退出时批量失败、未知通知无副作用 |
| `lsp/rpc.rs` | 14 | 请求/通知/响应构造、消息分类、服务器请求应答（configuration/progress/registry 等）、畸形消息不崩溃 |
| `lsp/uri.rs` | 16 | Windows/Unix/UNC/verbatim 路径往返、百分号编解码、中文/emoji/空格、非法 scheme/转义 |
| `lsp/cpp.rs` | 6 | PATH 查找顺序、根/`build` 数据库检测、生成受管 `.clangd`、数据库出现时移除、绝不覆盖用户 `.clangd`、`build/` 数据库不再生成回退 |
| `git.rs` | 43 | `rev-parse` 根解析、status 双列解析与状态分类、暂存/取消暂存、Diff 双侧取回与二进制识别、提交、`log` 时间/相对时间/主体解析、commit 详情、路径转义（反引号解码）等 |

前端无测试框架：以「`node` 可直接运行的 `.ts` 纯函数测试」+ `tsc`/`vite build` + 手工清单验证（清单见 `docs/features.md` §17）。现有 7 个 `test:*` 脚本：`gitStatusMapping` / `pathIdentity` / `diffSides` / `gitCommitTree` / `commitDiffSides` / `debug-state`（调试状态机全部迁移与断点裁决合并）/ `debug-launch`（启动配置构建、变量展开、`request` 类型）。

另有 Rust 集成测试 `src-tauri/tests/dap_lldb.rs`：3 个用例，编译一段 C++ 后交给**真实 `lldb-dap`**，覆盖 spawn、`initialize`、下断点、`launch`、停在断点、`stackTrace`/`scopes`/`variables`、调试进程退出后的会话回收与重启、以及 `runInTerminal`（Debug Terminal）路径；`g++`/`clang++`/`lldb-dap` 任一缺失时打印跳过信息而不是失败。

## 18. 验证命令

```bash
cd src-tauri && cargo check     # Rust 类型检查
cd src-tauri && cargo test      # Rust 单测（214 个，Windows 运行 213 个）+ tests/dap_lldb.rs 端到端（工具缺失时跳过）
pnpm build                      # TypeScript 检查 + Vite 构建
pnpm test:debug-state           # 调试状态机纯函数测试（node 直接运行 .ts）
pnpm test:debug-launch          # 调试启动配置纯函数测试
pnpm tauri dev                  # 启动开发环境
```
