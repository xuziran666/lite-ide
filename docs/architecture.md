# lite-ide 架构说明

> 版本 0.1.0 · 代码基线 `main@ee62006`

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
├── src/                        前端（27 个文件）
│   ├── commands/index.ts       全部 IPC 调用的唯一出口（14 个命令封装）
│   ├── components/
│   │   ├── Layout/             AppLayout（三栏骨架/快捷键/关窗保护）、WorkspacePicker、
│   │   │                       StatusBar、CloseConfirmDialog
│   │   ├── FileTree/           FileTree、TreeNode、ContextMenu、NameInputDialog、
│   │   │                       ConfirmDialog、FileIcon、FolderIcon
│   │   ├── Editor/             Editor（Monaco 实例）、Tabs（含未保存确认）
│   │   ├── Terminal/           Terminal（xterm 实例、工具栏）
│   │   └── Splitter.tsx        可拖拽分隔条
│   ├── editor/                 monacoSetup（worker 环境）、modelStore（模型生命周期）
│   ├── stores/                 workspaceStore、fileTreeStore、editorStore
│   ├── types/index.ts          DirEntry / TreeNode / Tab / CursorInfo
│   ├── utils/language.ts       basename / dirname / joinPath / 语言映射
│   └── App.css                 全部样式（676 行）
└── src-tauri/                  后端（10 个 Rust 文件 + 配置）
    ├── src/
    │   ├── lib.rs              插件与命令注册（14 个命令）
    │   ├── state.rs            AppState：workspace / watcher / terminal 三把 Mutex
    │   ├── session.rs          session.json 读写（容错降级）
    │   ├── watcher.rs          notify 递归监听 + 500ms 防抖 + 事件下发
    │   ├── terminal.rs         PTY 会话 + reader/flusher 双线程批处理
    │   ├── error.rs            统一错误文案
    │   └── commands/
    │       ├── fs.rs           8 个文件系统命令 + 边界/名称校验（501 行）
    │       └── terminal.rs     4 个终端命令 + shell 探测/cwd 规范化
    ├── capabilities/default.json  权限声明
    └── tauri.conf.json            窗口与打包配置
```

## 3. 分层与数据流

```
React 组件 ──► Zustand store ──► src/commands/index.ts ──► invoke() ──► Rust #[tauri::command]
     ▲                                                                          │
     └───────────── 事件 file-system-changed（string[]）◄── watcher.rs ◄─────────┘
```

- 前端**不直接访问文件系统**，所有能力经 IPC 走 Rust；
- 工作区路径、watcher、终端会话三者都保存在 Rust 侧 `AppState`（内存态）；
- 打开工作区会重置两个 store（`editorStore.reset` / `fileTreeStore.reset`）并重新 `loadRoot`。

## 4. IPC 命令清单（14 个）

| # | 命令 | 参数 | 返回 | 说明 |
|---|---|---|---|---|
| 1 | `list_dir` | `path` | `Entry[]` | 目录列举，隐藏目录过滤 + 目录优先排序 |
| 2 | `read_file` | `path` | `string` | UTF-8 读取，非 UTF-8 明确报错 |
| 3 | `write_file` | `path`, `content` | — | 保存文件 |
| 4 | `create_file` | `parent`, `name` | `Entry` | 新建文件 |
| 5 | `create_dir` | `parent`, `name` | `Entry` | 新建文件夹 |
| 6 | `rename_entry` | `path`, `newName` | `string` | 重命名，返回新路径 |
| 7 | `delete_entry` | `path` | — | 删除文件或递归删除目录 |
| 8 | `set_workspace` | `path` | `string` | 校验并设置工作区，重启 watcher 并写入 session |
| 9 | `get_workspace` | — | `string \| null` | 当前工作区 |
| 10 | `get_last_workspace` | — | `string \| null` | 上次工作区（目录不存在时返回 `null`） |
| 11 | `terminal_spawn` | `channel` | — | 先结束旧会话，再在新 PTY 中启动 shell |
| 12 | `terminal_write` | `data` | — | 向 PTY 写入用户输入 |
| 13 | `terminal_resize` | `cols`, `rows` | — | 同步 PTY 尺寸 |
| 14 | `terminal_kill` | — | — | 结束会话（Windows 清理进程树） |

## 5. 事件契约

| 事件 | 载荷 | 触发方 | 消费方 |
|---|---|---|---|
| `file-system-changed` | `string[]`（去重并排序的绝对路径） | `watcher.rs`（500ms 防抖后批量 emit） | `AppLayout`：同时驱动 `fileTreeStore.onFileSystemChanged` 与 `editorStore.onExternalChange` |

## 6. 前端状态管理

| 模块 | 职责 |
|---|---|
| `workspaceStore` | 工作区路径、`init`（恢复上次工作区）、`openWorkspace`（设置并重置其余 store） |
| `fileTreeStore` | 树的加载与刷新（`loadRoot`/`toggleDir`/`loadChildren`/`refreshPath`/`revealPath`）、CRUD 包装、`selectedPath`、`version` 竞态令牌 |
| `editorStore` | 打开标签、`activePath`、脏状态、`save`/`saveAll`、关闭流程（`requestCloseTab`/`confirmCloseTab`）、外部变更、光标信息 |
| `editor/modelStore` | Monaco `ITextModel` 生命周期、`savedVersion` 脏判定、`rekeyPath`（重命名保留脏状态）、`setModelContent`（静默重载） |

`version` 令牌用于丢弃过期的异步加载结果（切换工作区、重复加载时的竞态保护）。

## 7. 编辑器模型与脏状态

- 每个打开的文件对应一个 Monaco `ITextModel`（URI 由文件路径规范化而来，反斜杠统一为 `/`）；
- 脏状态 = `model.getVersionId() !== savedVersion`，内容变更时通过回调同步到 `editorStore`；
- 保存成功后把 `savedVersion` 推进到当前版本；
- 外部变更且本地非脏时，用 `suppressChange` 抑制回调再更新内容，避免误标脏；
- 重命名时 `rekeyPath` 把旧模型内容迁移到新路径并保留脏状态。

## 8. 文件系统安全边界

所有文件操作都以当前工作区为根，并经过以下校验：

| 函数 | 作用 |
|---|---|
| `validate_within_workspace` | 词法归一化 `.`/`..` → 从最深存在祖先 `canonicalize` → 校验 `starts_with(workspace)` → 拼回未存在后缀；覆盖绝对路径越界与 symlink 逃逸 |
| `leaf_path_within_workspace` | 建/改/删目标：父目录 canonicalize（防 symlink 逃逸），叶子本身不 canonicalize（操作 symlink 自身而非跟随） |
| `validate_entry_name` | 名称合法性：非空、非 `.`/`..`、不含 `/` 与 `\`、Windows 保留字符 `< > : " \| ? *`、不以 `.` 或空格结尾 |
| 根目录保护 | 禁止删除或重命名工作区根目录 |
| 冲突保护 | 目标已存在时拒绝创建/重命名，避免覆盖 |

## 9. 目录过滤三套规则（实现）

| 常量 | 定义位置 | 消费点 | 语义 |
|---|---|---|---|
| `HIDDEN_DIRS`（5 项） | `commands/fs.rs` | `do_list_dir` → `is_hidden_name` | 不出现在文件树 |
| `IGNORED_DIRS`（6 项，含 `node_modules`） | `commands/fs.rs` | `path_is_ignored` → `watcher.rs` | 丢弃文件系统事件 |
| `AUTO_REVEAL_SKIP`（`node_modules`） | `stores/fileTreeStore.ts` | `revealPath` | 自动定位时不展开 |

- 前两者按「路径组件名字相等」匹配：实现成本低，但不区分位置（任何层级同名目录都会命中）；
- `watcher.rs` 仅在事件路径位于工作区内且未被忽略时才收集，500ms 后批量 `emit`；
- `revealPath` 先设置高亮，再判断是否需要展开，命中 `AUTO_REVEAL_SKIP` 时直接返回。

## 10. 会话持久化

- 文件：`app_config_dir()/session.json`（Windows：`%APPDATA%\com.longanl.lite-ide\session.json`）；
- 内容：`{ "last_workspace": "…" }`，字段均可选；
- 写入：`set_workspace` 成功后落盘，失败仅打印日志，不影响工作区打开；
- 读取：解析失败、文件缺失、目录不存在三种情况统一降级为 `null`，由前端回退欢迎页。

## 11. Tauri 权限与窗口配置

- 权限（`capabilities/default.json`）：`core:default`、`core:window:allow-destroy`（关窗确认后强制退出）、`core:window:allow-set-title`（标题跟随工作区）、`dialog:default`（目录选择）；
- 事件监听（`listen`、`onCloseRequested`）依赖 `core:event:default` 中的 `allow-listen`，无需额外声明；
- 窗口（`tauri.conf.json`）：默认 `800×600`，最小 `720×480`，`beforeDevCommand` 为 `pnpm dev`，`frontendDist` 指向 `../dist`。

## 12. 测试覆盖（25 个 Rust 单测）

| 模块 | 覆盖点 |
|---|---|
| `commands/fs.rs` | 路径归一化、工作区内/外目标校验、绝对路径与 `..` 逃逸、symlink 逃逸、名称合法性、文件与目录创建、重复创建、重命名与冲突、删除（含递归）、根目录保护、隐藏目录过滤、watcher 忽略判定 |
| `commands/terminal.rs` | Windows 扩展长度路径（`\\?\`）与 UNC 前缀还原、普通路径保持不变 |
| `session.rs` | session 解析、损坏 JSON、空输入、缺失字段容错 |

## 13. 验证命令

```bash
cd src-tauri && cargo check     # Rust 类型检查
cd src-tauri && cargo test      # Rust 单测（25 个）
pnpm build                      # TypeScript 检查 + Vite 构建
pnpm tauri dev                  # 启动开发环境
```
