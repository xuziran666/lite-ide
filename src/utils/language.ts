export function basename(path: string): string {
  const parts = path.split(/[\\/]/);
  return parts[parts.length - 1] || path;
}

export function dirname(path: string): string {
  const parts = path.split(/[\\/]/);
  parts.pop();
  const out = parts.join("/");
  return out || path;
}

export function languageForPath(path: string): string {
  const dot = path.lastIndexOf(".");
  if (dot < 0) return "plaintext";
  const ext = path.slice(dot + 1).toLowerCase();
  switch (ext) {
    case "js":
    case "jsx":
    case "mjs":
    case "cjs":
      return "javascript";
    case "ts":
    case "tsx":
    case "mts":
    case "cts":
      return "typescript";
    case "html":
    case "htm":
      return "html";
    case "css":
      return "css";
    case "scss":
      return "scss";
    case "json":
      return "json";
    case "md":
    case "markdown":
      return "markdown";
    case "rs":
      return "rust";
    default:
      return "plaintext";
  }
}