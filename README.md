# lite-ide

基于 Tauri v2 的轻量级跨平台代码编辑器，核心功能为：文件树、代码编辑器（Monaco）、内置终端（xterm.js + portable-pty）。

## 环境要求

- Node.js 20+ / pnpm
- Rust stable（含 MSVC 工具链，Windows）
- Tauri v2 CLI（随 pnpm 安装）

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

> 详细功能与架构说明见 [docs/features.md](docs/features.md)、[docs/architecture.md](docs/architecture.md)。
