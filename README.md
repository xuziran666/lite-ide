# lite-ide

基于 Tauri v2 的轻量级跨平台代码编辑器，核心功能为：文件树、代码编辑器（Monaco）、内置终端（xterm.js + portable-pty）、任务与设置系统，以及项目导航（Quick Open / 全局搜索 / 大纲 / 问题）与内置 LSP 客户端（Rust / C / C++ / TypeScript / JavaScript）。

## 环境要求

- Node.js 20+ / pnpm
- Rust stable（含 MSVC 工具链，Windows）
- Tauri v2 CLI（随 pnpm 安装）
- 可选语言服务器（从 PATH 查找，缺少时对应语言保持 disconnected 并提示）：
  - Rust：`rust-analyzer`
  - C/C++：`clangd`
  - TypeScript/JavaScript：`typescript-language-server --stdio`

## 开发

```bash
pnpm install
pnpm tauri dev
```

## 构建

```bash
pnpm tauri build
```

## 检查

```bash
cargo check        # Rust 检查
cargo test         # Rust 测试
pnpm build         # TypeScript 检查 + Vite 构建
```

## 当前进度

- 阶段 1：项目初始化 —— 基础三栏布局、工作区选择、Rust `list_dir` 后端、目录内容展示。
- 阶段 2：Monaco 编辑器 —— 点击文件树打开文件、多标签页、dirty 状态、Ctrl/Cmd+S 保存、查找/替换（Monaco 内置）、关闭未保存文件时的保存/不保存/取消确认、Rust `read_file`/`write_file` 与工作区边界校验。
- 阶段 3：文件树增强 —— 递归懒加载树（展开/折叠）、右键菜单（新建文件/文件夹、重命名、删除）、文件系统监听（`notify`，500ms 防抖）自动刷新受影响的目录、外部修改时保留脏标签并提示、重命名同步已打开标签、隐藏目录（`.git`、`target`、`dist`、`build`、`.cache`，`node_modules` 可见）、`.git`/`node_modules`/`target` 等仍从文件系统事件中过滤以避免构建期事件风暴、自动定位时不强展开 `node_modules`、Rust `create_file`/`create_dir`/`rename_entry`/`delete_entry` 及名称与工作区边界校验。
- 阶段 4：内置终端 —— xterm.js + `portable-pty`，Rust 端 `terminal_spawn`/`terminal_write`/`terminal_resize`/`terminal_kill` 四个命令、`Channel<Vec<u8>>` 输出通道（4KB/16ms 批量 + 退出标记）、双线程 reader/flusher、终端以工作区为起始目录、重开工作区/重启自动结束旧会话、窗口尺寸变化自动适配、`exit` 后不自动重启并显示「进程已退出」、进程树清理（Windows `taskkill /T`）。
- 阶段 5：体验优化 —— 标签溢出修复与横向滚动、窗口最小尺寸（720x480）、全局快捷键（Ctrl/Cmd+B 文件树、Ctrl/Cmd+` 终端、Ctrl/Cmd+W 关闭标签、Ctrl+Tab / Ctrl+Shift+Tab 切换标签）、底部状态栏（行列、选区字符数、语言、编码、未保存标记）、关闭窗口未保存保护（保存并退出/不保存/取消）、记住上次工作区（`session.json`，文件夹失效时静默回退欢迎页）、窗口标题跟随工作区、文件树右键复制路径与相对路径、文件树跟随当前编辑文件（自动展开并高亮）、折叠文件树时编辑器贴到窗口最左侧。
- 阶段 6：多终端与 IDE 外壳 —— 终端多标签（`+` 新建、标签切换、退出标记与重启按钮）、活动栏（资源管理器 / 任务 / 设置入口）、顶部栏。
- 阶段 7：任务系统 —— 全局 `tasks.json`（与应用配置 `user.json` 同目录）、任务中心下拉（`Ctrl+Ctrl` 快速两次 Ctrl 打开，`↑`/`↓` 选择、`Enter` 运行）、8 种变量占位符（`${workspaceFolder}`、`${file}`、`${fileDirname}`、`${relativeFile}` 等）与 Windows 扩展长度路径（`\\?\`）归一化（修复 MinGW `g++` 拒绝路径）、专用「任务」终端（运行前 `^C` 中断 → 350ms 后写入解析命令；shell 退出自动重启）。
- 阶段 8：设置系统 —— 活动栏 ⚙ 打开覆盖式设置页（通用 / 编辑器 / 终端 / 任务 / 键盘快捷键 5 分区）、`user.json` 读写（camelCase，后端钳制/空值回退）、编辑器参数（字号/制表符/换行/缩略图）与快捷键热应用、默认 shell 仅对新建终端生效、可关闭「恢复上次文件夹」「关窗确认」、键位录制（含 `Ctrl+Ctrl` 双击与冲突检测）。
- 阶段 9：体验修复 —— 终端 `Ctrl+C` 按 JetBrains 语义（有选区复制 / 无选区 `^C` 中断）、`user.json` camelCase 序列化修复。
- 阶段 10：项目导航 —— Quick Open（`Ctrl/Cmd+P`，子序列模糊匹配，最多 50 条）、右侧栏（搜索 / 大纲 / 问题 三标签）、全局内容搜索（`Ctrl/Cmd+Shift+F`，大小写与正则开关，防抖 300ms）、Problems（聚合 Monaco markers）、Outline（`documentSymbol` 提供者，C/C++ 无语言服务时用正则扫描回退）；Rust 端 `list_workspace_files`/`search_workspace`。
- 阶段 11：内置 LSP 客户端（Rust） —— 自建 stdio / JSON-RPC 传输（Content-Length 帧、请求-响应关联、未知消息不崩溃）、rust-analyzer 懒启动（首个 `.rs` 打开时）、诊断 / 补全 / 悬停 / 定义 / `documentSymbol`、Ctrl/Cmd+左键定义跳转（Ctrl+hover 仅显示可点击态不跳转）、workspace 外文件以只读单文件标签打开、按工作区/退出/最后文件关闭的生命周期与崩溃后不自动重启。
- 阶段 11.2：多语言 LSP —— 同一通用客户端支持 clangd（C/C++）与 `typescript-language-server --stdio`（TS/JS）；单套 Monaco provider 按 model 语言分发，语言层仅描述 id / Monaco 语言 / 扩展名 / 命令 / 参数；`lsp` 用户配置节；关闭 Monaco TS/JS worker 中被 LSP 取代的重复能力。
- 阶段 11.3：C/C++ 工具链发现 —— `compile_commands.json` 优先（clangd 原生发现 workspace 根与 `build/`，不覆盖其中的编译器/头文件/参数）；无数据库时用 PATH 中的 `g++`/`gcc` 作为 fallback（生成受管 `.clangd` + `--enable-config --query-driver`），不硬编码工具链/STL 路径，出现数据库时自动移除回退。

> 详细功能与架构说明见 [docs/features.md](docs/features.md)、[docs/architecture.md](docs/architecture.md)。
