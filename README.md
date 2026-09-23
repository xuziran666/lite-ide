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