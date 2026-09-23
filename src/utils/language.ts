export function basename(path: string): string {
  const parts = path.split(/[\\/]/);
  return parts[parts.length - 1] || path;
}

export function dirname(path: string): string {
  const parts = path.split(/[\\/]/);
  parts.pop();
  const sep = path.includes("\\") ? "\\" : "/";
  const out = parts.join(sep);
  return out || path;
}

const extensionLanguageMap: Record<string, string> = {
  js: "javascript",
  jsx: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  ts: "typescript",
  tsx: "typescript",
  mts: "typescript",
  cts: "typescript",
  html: "html",
  htm: "html",
  css: "css",
  scss: "scss",
  json: "json",
  md: "markdown",
  markdown: "markdown",
  rs: "rust",
  c: "c",
  h: "c",
  cc: "cpp",
  cpp: "cpp",
  cxx: "cpp",
  hpp: "cpp",
  hxx: "cpp",
  hh: "cpp",
  py: "python",
  pyw: "python",
  java: "java",
  kt: "kotlin",
  kts: "kotlin",
  go: "go",
  cs: "csharp",
  php: "php",
  rb: "ruby",
  sh: "shell",
  bash: "shell",
  zsh: "shell",
  fish: "shell",
  ps1: "powershell",
  psm1: "powershell",
  psd1: "powershell",
  sql: "sql",
  yaml: "yaml",
  yml: "yaml",
  xml: "xml",
  toml: "ini",
  ini: "ini",
};

function filenameLanguage(name: string): string | undefined {
  const lower = name.toLowerCase();
  if (lower === "dockerfile" || lower.startsWith("dockerfile.")) {
    return "dockerfile";
  }
  return undefined;
}

export function languageForPath(path: string): string {
  const name = basename(path);
  const byFilename = filenameLanguage(name);
  if (byFilename) {
    return byFilename;
  }
  const dot = name.lastIndexOf(".");
  if (dot < 0) return "plaintext";
  const ext = name.slice(dot + 1).toLowerCase();
  return extensionLanguageMap[ext] ?? "plaintext";
}
