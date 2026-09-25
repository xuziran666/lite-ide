# lite-ide 架构说明

> 版本 0.2.0 · 代码基线 `main@f027013`

## 1. 技术栈与版本

- 应用外壳：Tauri 2（本地 2.11.6），后端 Rust edition 2021
- 前端：React 19.1 + TypeScript 6.0（`strict`、`noUnusedLocals`/`noUnusedParameters` 均已开启）+ Vite 8.0
- 状态管理：Zustand 5.0.3
- 编辑器：monaco-editor 0.56
- 终端：@xterm/xterm 6 + addon-fit 0.11 + addon-webgl 0.19
- 其他：notify 8.2（文件监听）、portable-pty 0.9（伪终端）、tauri-plugin-dialog 2（目录选择）、regex 1（全局搜索）
- 语言服务器（外部进程，从 PATH 查找）：rust-analyzer / clangd / typescript-language-server

## 2. 目录结构

```
lite-ide/
├── src/                        前端（75 个 ts/tsx，含类型声明与样式）
│   ├── commands/index.ts       全部 IPC 调用的唯一出口（38 个命令封装）
│   ├── config/keybindings.ts   键位动作定义 / 解析 / 录制校验 / 双击 Ctrl 标记
│   ├── components/
│   │   ├── Layout/             AppLayout（骨架/快捷键/关窗保护/设置覆盖区/右侧栏）、ActivityBar、
│   │   │                       TopBar（自定义标题栏：Logo + 品牌 + 工作区名 + 三个布局切换按钮（左主栏 / 终端 / 右栏）
│   │   │                       + 任务中心 + 最小化/最大化(还原)/关闭 + 拖拽区）、StatusBar、
│   │   │                       RightSidebar、WorkspacePicker、CloseConfirmDialog
│   │   ├── FileTree/           FileTree、TreeNode、ContextMenu、NameInputDialog、
│   │   │                       ConfirmDialog、FileIcon、FolderIcon
│   │   ├── Editor/             Editor（Monaco 实例）、Tabs（含未保存确认）
│   │   ├── Terminal/           Terminal（xterm 多标签实例、工具栏、任务终端）
│   │   ├── Tasks/              TaskCenter（任务中心下拉）
│   │   ├── Search/             QuickOpen（覆盖式）、GlobalSearch（右侧栏）
│   │   ├── References/         ReferencesPanel（查找引用结果）
│   │   ├── Outline/            OutlinePanel（documentSymbol）
│   │   ├── Problems/           ProblemsPanel（Monaco markers 聚合）
│   │   ├── Settings/           SettingsView + General / Editor / Files / Terminal / Tasks / Keyboard 六分区
│   │   ├── Toast/              ToastStack（全局 Toast 栈）
│   │   └── Splitter.tsx        可拖拽分隔条
│   ├── editor/                 monacoSetup（worker 环境 + 关闭被 LSP 取代的 TS/JS worker 能力）、
│   │                           modelStore（模型生命周期）、cppOutline（C/C++ Outline 回退扫描器）
│   ├── lsp/                    protocol（wire 类型与转换）、languages（语言描述表）、
│   │                           client（通用 LSP 客户端：session/事件/provider/定义跳转/引用/重命名/签名/代码操作/格式化）、
│   │                           workspaceEdit（WorkspaceEdit 解析与安全应用）
│   ├── stores/                 workspaceStore、fileTreeStore、editorStore、configStore、gitStore、diffStore、
│   │                           terminalStore、taskStore、searchStore、uiStore
│   ├── types/                  index.ts（DirEntry/TreeNode/Tab/CursorInfo）、monaco-internals.d.ts
│   ├── utils/                  language.ts（basename/dirname/joinPath/语言映射）、
│   │                           reveal.ts（openAndReveal：工作区内/外分流）、
│   │                           pathIdentity.ts（canonicalPath/fileKey/sameFile/isPathInsideWorkspace，
│   │                           路径同一性 + 工作区内判定，编辑器打开入口与「打开文件」共用）、
│   │                           autoSave.ts（自动保存调度：延迟/失焦触发）、
│   │                           taskVariables.ts（任务变量展开 + Windows 路径归一化）
│   └── App.css                 全部样式（2325 行，含 Phase 13.1 `--vo-*` 设计 Token 层）
└── src-tauri/                  后端（25 个 Rust 文件 + 配置）
    ├── src/
    │   ├── lib.rs              插件与命令注册（38 个命令 + 10 个 Git 命令）
    │   ├── state.rs            AppState：workspace / watcher / terminals(HashMap) / lsp(HashMap<语言, session>)
    │   ├── session.rs          session.json 读写（容错降级）
    │   ├── config.rs           user.json 解析/钳制/写回（含 lsp 节）、configured_shell、app_config_dir
    │   ├── shell.rs            shell 探测：Windows pwsh→powershell→cmd，Unix $SHELL→/bin/sh
    │   ├── tasks.rs            tasks.json 解析（TaskSpec，格式错误返回可读文案）
    │   ├── watcher.rs          notify 递归监听 + 500ms 防抖 + 事件下发
    │   ├── terminal.rs         PTY 会话 + reader/flusher 双线程批处理
    │   ├── error.rs            统一错误文案
    │   ├── lsp/                内置 LSP 客户端
    │   │   ├── mod.rs          语言默认命令 / 命令解析 / root 解析 / initialize 能力
    │   │   ├── session.rs      单服务器会话（进程、stdio、请求关联、生命周期、事件）
    │   │   ├── transport.rs    Content-Length 帧编解码
    │   │   ├── rpc.rs          JSON-RPC 报文构造/分类/服务器请求应答
    │   │   ├── uri.rs          文件路径 ⇄ file:// URI
    │   │   └── cpp.rs          C/C++ 工具链发现（compile_commands.json / MinGW 回退）
    │   └── commands/
    │       ├── fs.rs           11 个文件系统/工作区命令 + 边界/名称/外部只读校验
    │       ├── search.rs       list_workspace_files / search_workspace
    │       ├── terminal.rs     6 个终端命令 + cwd 规范化
    │       ├── tasks.rs        load_tasks（读全局 tasks.json）
    │       ├── config.rs       get/set_user_config + read/write_global_file（白名单 tasks.json）
    │       └── lsp.rs          4 个 LSP 命令（start/stop/notify/request，按语言路由）
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
```

- 前端**不直接访问文件系统**，所有能力经 IPC 走 Rust；
- 工作区路径、watcher、终端会话（`HashMap<u64, TerminalSession>`）与语言服务器会话（`HashMap<String, Arc<LspSession>>`，键为语言 id）都保存在 Rust 侧 `AppState`（内存态）；
- 启动顺序：**先加载 `user.json`（`configStore.load()`），再据 `general.restoreLastWorkspace` 决定是否恢复上次工作区**，因此配置可以关闭自动恢复；
- 打开工作区会重置 `editorStore` / `fileTreeStore` / `terminalStore` / `taskStore` / `searchStore` 的运行时状态并重新 `loadRoot`；Rust 侧 `set_workspace` 停止全部终端与语言服务器；任务列表为全局配置，不随工作区切换丢失。

## 4. IPC 命令清单（38 个）

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

## 5. 事件契约

| 事件 | 载荷 | 触发方 | 消费方 |
|---|---|---|---|
| `file-system-changed` | `string[]`（去重并排序的绝对路径） | `watcher.rs`（500ms 防抖后批量 emit） | `AppLayout`：同时驱动 `fileTreeStore.onFileSystemChanged` 与 `editorStore.onExternalChange` |
| `lsp-diagnostics` | `{ language, uri, path, diagnostics }` | `lsp/session.rs`（`textDocument/publishDiagnostics`） | `lsp/client.ts`：按 `language` + `path` 路由到对应 model 的 markers |
| `lsp-exited` | `{ language, message }` | `lsp/session.rs`（进程退出/流中断，且非主动 shutdown） | `lsp/client.ts`：重置该语言状态并 toast |

终端输出**不走全局事件**：`terminal_spawn` 时前端传入独立的 `Channel<Vec<u8>>`，每个 PTY 会话独占一条通道（空数据块 = 进程退出标记）。

## 6. 前端状态管理

| 模块 | 职责 |
|---|---|
| `workspaceStore` | 工作区路径、`init`（恢复上次工作区）、`openWorkspace`（设置并重置其余 store） |
| `fileTreeStore` | 树的加载与刷新（`loadRoot`/`toggleDir`/`loadChildren`/`refreshPath`/`revealPath`）、CRUD 包装、`selectedPath`、`version` 竞态令牌 |
| `editorStore` | 打开标签、`activePath`、脏状态、`save`，关闭流程、外部变更、光标信息、`openGlobalFile`（外部标签打开 `tasks.json`）、`openExternalFile`（只读外部文件，见 §7） |
| `configStore` | 用户配置加载/热更新、`settingsOpen`、键位录制落盘（`saveKeybinding` 冲突检测）、shell 列表、`lsp` 配置（`cloneLsp` 深拷贝回写） |
| `searchStore` | Quick Open 文件索引与开关、右侧栏开关与当前标签（search/references/outline/problems）、查找引用结果（`references`/`referencesSymbol`/`referencesLoading`） |
| `terminalStore` | 终端记录（id/name/exited/kind）、多标签 create/close/select、退出标记 |
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
- **只读外部文件**：`openExternalFile` 读取工作区外文件（`read_external_file`），以 `readOnly: true` 标签打开，`onChange` 回调为空（**从不置脏**），`save()` 直接返回 `false`，`onExternalChange` 跳过，关闭时不进入最近关闭历史，切换工作区随 `reset()` 关闭；编辑器参数通过订阅 `configStore` **按字段**热应用到活动 Monaco 实例（仅 `editor.theme` 变化时调用 `setTheme`，其余字段各自 `updateOptions`，不重建 Editor / Model）。

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

- `transport.rs`：`Content-Length` 帧编码（`frame_message`/`write_message`）与增量解码（`FrameDecoder`，含 EOF/畸形头/非法 JSON 分类）。
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
| `user.json` | `keybindings` / `editor` / `terminal` / `general` / `files` / `lsp`（camelCase） | `config.rs` `load`/`save` | 缺失用默认值；损坏用默认值并 toast；未知键位动作忽略；值越界钳制、`general.theme` 非法回 `dark`、`editor.theme` 非法回 `vs-dark`、空 shell 回 `auto`、非法 `wordWrap` 归 `off`、`lsp` 空白命令/参数回退默认 |
| `tasks.json` | `{ "tasks": [{ "name", "command" }] }` | `load_tasks` 读；`write_global_file` 写（设置内编辑） | 缺失视为空列表；格式错误在任务中心显示「tasks.json 格式错误」 |

工作区内另有一份**受管** `.clangd`（仅 C/C++ 且无 `compile_commands.json` 时生成，见 10.3），首行带标记，出现数据库时自动删除。

生效时机：

| 配置 | 热应用 | 新会话 | 下次启动 | 需手动重启 |
|---|---|---|---|---|
| 编辑器参数（字体/连字/字号/制表符/换行/缩略图/行号/空白/行高亮/参考线/折叠/括号/滚动/光标） | ✅（按字段 `updateOptions`） | | | |
| Monaco 配色主题（`editor.theme`） | ✅（`setTheme`） | | | |
| 主题（`general.theme`：dark/light/system） | ✅（`<html data-theme>`） | | | |
| 自动保存（`files.autoSave`） | ✅ | | | |
| 键盘快捷键 | ✅ | | | |
| 终端默认 shell | | ✅（spawn 时读取） | | |
| `lsp`（命令/参数） | | ✅（语言服务启动时读取） | | |
| 关窗确认 | ✅ | | | |
| 恢复上次文件夹 | | | ✅ | |
| `tasks.json` 任务列表 | | | | ✅ |

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

## 15. Tauri 权限与窗口配置

- 权限（`capabilities/default.json`）：`core:default`、`core:window:allow-destroy`（关窗确认后强制退出）、`core:window:allow-set-title`（标题跟随工作区）、`core:window:allow-minimize` / `allow-toggle-maximize` / `allow-close` / `allow-start-dragging`（自定义标题栏的窗口控制与拖拽）、`dialog:default`（目录选择与「打开文件」）；
- 终端复制使用 WebView 的 `navigator.clipboard`（标准 Web API），无需额外能力声明；事件监听（`listen`、`onCloseRequested`）依赖 `core:event:default` 中的 `allow-listen`；
- 窗口（`tauri.conf.json`）：**`decorations: false`**（去掉系统原生标题栏，由 `TopBar` 自绘 36px 自定义标题栏）、默认 `800×600`，最小 `720×480`，`bundle.icon` 引用 `icons/` 下由项目 Logo 生成的图标，`beforeDevCommand` 为 `pnpm dev`，`frontendDist` 指向 `../dist`。

## 16. 测试覆盖（167 个 Rust 单测，Windows 上运行 166 个）

| 模块 | 数量 | 覆盖点 |
|---|---|---|
| `commands/fs.rs` | 21 | 路径归一化、工作区内/外目标校验、绝对路径与 `..` 逃逸、symlink 逃逸、名称合法性、文件与目录创建、重复创建、重命名与冲突、删除（含递归）、根目录保护、隐藏目录过滤、watcher 忽略判定、外部只读读取（绝对路径/穿越/目录/缺失/正常） |
| `commands/search.rs` | 6 | 文件列举跳过隐藏目录、隐藏目录判定、明文搜索（含 `node_modules`）、大小写敏感、正则（含非法）、空查询拒绝 |
| `commands/terminal.rs` | 5（含 1 个 `#[cfg(not(windows))]`） | Windows 扩展长度路径（`\\?\`）与 UNC 前缀还原、普通路径保持不变 |
| `config.rs` | 25 | 默认键位、键位合并/未知动作忽略、编辑器/终端/通用覆盖解析、缺失分区回退、越界钳制、`general.theme`/`editor.theme` 白名单回退、空 shell 回退、`lsp` 默认/覆盖/空白回退、损坏/空 `user.json` 降级、camelCase 序列化键名 |
| `tasks.rs` | 5 | 任务列表解析、空对象容错、非法 JSON、非对象根、缺 name/command 字段报错 |
| `session.rs` | 4 | session 解析、损坏 JSON、空输入、缺失字段容错 |
| `lsp/mod.rs` | 5 | 每语言默认命令与解析、root 解析（Rust 项目根 / C·TS 工作区根 / Cargo.toml 上溯 / 回退）、`initialize` 能力（含 `publishDiagnostics`） |
| `lsp/session.rs` | 5 | 请求 id 单调、响应关联、错误转发、退出时批量失败、未知通知无副作用 |
| `lsp/rpc.rs` | 14 | 请求/通知/响应构造、消息分类、服务器请求应答（configuration/progress/registry 等）、畸形消息不崩溃 |
| `lsp/transport.rs` | 12 | 帧编解码、跨读分片、多消息、精确 Content-Length、缺失/非数字长度、空消息往返 |
| `lsp/uri.rs` | 16 | Windows/Unix/UNC/verbatim 路径往返、百分号编解码、中文/emoji/空格、非法 scheme/转义 |
| `lsp/cpp.rs` | 6 | PATH 查找顺序、根/`build` 数据库检测、生成受管 `.clangd`、数据库出现时移除、绝不覆盖用户 `.clangd`、`build/` 数据库不再生成回退 |
| `git.rs` | 43 | `rev-parse` 根解析、status 双列解析与状态分类、暂存/取消暂存、Diff 双侧取回与二进制识别、提交、`log` 时间/相对时间/主体解析、commit 详情、路径转义（反引号解码）等 |

前端无测试框架，以 `tsc`/`vite build` 与手工清单验证（见 `docs/features.md` §15）。

## 17. 验证命令

```bash
cd src-tauri && cargo check     # Rust 类型检查
cd src-tauri && cargo test      # Rust 单测（167 个，Windows 运行 166 个）
pnpm build                      # TypeScript 检查 + Vite 构建
pnpm tauri dev                  # 启动开发环境
```
