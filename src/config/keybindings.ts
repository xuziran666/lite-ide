/** Every keyboard-rebindable action in the IDE. */
export const KEYBINDING_ACTIONS = [
  "toggleExplorer",
  "toggleTerminal",
  "newTerminal",
  "closeEditorTab",
  "restoreClosedTab",
  "nextEditorTab",
  "previousEditorTab",
  "openTaskCenter",
  "quickOpen",
  "globalSearch",
  "renameSymbol",
  "findReferences",
  "codeActions",
  "formatDocument",
] as const;

export type KeybindingAction = (typeof KEYBINDING_ACTIONS)[number];

export type KeybindingMap = Record<KeybindingAction, string>;

/** Defaults, used until user.json data arrives from the backend. */
export const DEFAULT_KEYBINDINGS: KeybindingMap = {
  toggleExplorer: "Ctrl+B",
  toggleTerminal: "Ctrl+`",
  newTerminal: "Ctrl+Shift+`",
  closeEditorTab: "Ctrl+W",
  restoreClosedTab: "Ctrl+Shift+T",
  nextEditorTab: "Ctrl+Tab",
  previousEditorTab: "Ctrl+Shift+Tab",
  openTaskCenter: "Ctrl+Ctrl",
  quickOpen: "Ctrl+P",
  globalSearch: "Ctrl+Shift+F",
  renameSymbol: "F2",
  findReferences: "Shift+F12",
  codeActions: "Ctrl+.",
  formatDocument: "Shift+Alt+F",
};

/**
 * `openTaskCenter` defaults to the special `Ctrl+Ctrl` chord, which means a
 * quick double press of Ctrl rather than an ordinary chord.
 */
export function isDoubleCtrlChord(chord: string): boolean {
  return chord === "Ctrl+Ctrl";
}

/** A parsed, normalized chord like `Ctrl+Shift+P`. */
export interface KeyChord {
  ctrl: boolean;
  shift: boolean;
  alt: boolean;
  meta: boolean;
  key: string;
}

/**
 * Parse a chord string into its modifiers and key. Returns null for chords
 * that cannot map to a single keyboard event (for example the double-Ctrl
 * marker, malformed entries, or the empty string).
 */
export function parseChord(chord: string): KeyChord | null {
  const parts = chord
    .trim()
    .split(/\s*\+\s*/)
    .filter(Boolean);
  let ctrl = false;
  let shift = false;
  let alt = false;
  let meta = false;
  const keys: string[] = [];
  for (const part of parts) {
    const lower = part.toLowerCase();
    if (lower === "ctrl" || lower === "control") {
      ctrl = true;
    } else if (lower === "shift") {
      shift = true;
    } else if (lower === "alt") {
      alt = true;
    } else if (lower === "meta" || lower === "cmd" || lower === "win") {
      meta = true;
    } else {
      keys.push(part);
    }
  }
  if (keys.length !== 1) return null;
  return { ctrl, shift, alt, meta, key: keys[0] };
}

/** Whether the parsed chord matches a given keyboard event. */
export function chordMatches(chord: KeyChord | null, e: KeyboardEvent): boolean {
  if (!chord) return false;
  if (chord.ctrl !== e.ctrlKey) return false;
  if (chord.shift !== e.shiftKey) return false;
  if (chord.alt !== e.altKey) return false;
  if (chord.meta !== e.metaKey) return false;
  switch (chord.key) {
    case "`":
      return e.code === "Backquote";
    case "Tab":
    case "Enter":
    case "Escape":
    case "Space":
      return e.code === chord.key;
    default:
      return e.key.toLowerCase() === chord.key.toLowerCase();
  }
}

/** Human-friendly display names for the Settings shortcut list. */
export const KEYBINDING_LABELS: Record<KeybindingAction, string> = {
  toggleExplorer: "Toggle Explorer",
  toggleTerminal: "Toggle Terminal",
  newTerminal: "New Terminal",
  closeEditorTab: "Close Editor Tab",
  restoreClosedTab: "Restore Closed Tab",
  nextEditorTab: "Next Editor Tab",
  previousEditorTab: "Previous Editor Tab",
  openTaskCenter: "Open Task Center",
  quickOpen: "Quick Open",
  globalSearch: "Global Search",
  renameSymbol: "Rename Symbol",
  findReferences: "Find References",
  codeActions: "Code Actions",
  formatDocument: "Format Document",
};

/**
 * Build a normalized chord string from a keyboard event. Returns null for pure
 * modifier presses, which are used to detect the double-Ctrl gesture instead.
 */
export function chordFromEvent(e: KeyboardEvent): string | null {
  if (
    e.key === "Control" ||
    e.key === "Shift" ||
    e.key === "Alt" ||
    e.key === "Meta"
  ) {
    return null;
  }

  const parts: string[] = [];
  if (e.ctrlKey) parts.push("Ctrl");
  if (e.shiftKey) parts.push("Shift");
  if (e.altKey) parts.push("Alt");
  if (e.metaKey) parts.push("Meta");

  let key: string | null = null;
  if (e.code.startsWith("Key")) {
    key = e.code.slice(3).toUpperCase();
  } else if (e.code.startsWith("Digit")) {
    key = e.code.slice(5);
  } else if (e.code === "Backquote") {
    key = "`";
  } else {
    switch (e.key) {
      case "Tab":
        key = "Tab";
        break;
      case "Enter":
        key = "Enter";
        break;
      case "Escape":
        key = "Escape";
        break;
      case " ":
        key = "Space";
        break;
      default:
        key = e.key.length === 1 ? e.key : e.code;
    }
  }
  if (!key) return null;
  parts.push(key);
  return parts.join("+");
}

/**
 * Whether a chord is acceptable as a user-recorded shortcut. Ordinary chords
 * must include Ctrl or Meta and must not include Alt; the special `Ctrl+Ctrl`
 * double-press is allowed so `openTaskCenter` keeps its default behavior.
 */
export function isUsableShortcut(chord: string): boolean {
  if (isDoubleCtrlChord(chord)) return true;
  const parsed = parseChord(chord);
  if (!parsed) return false;
  return (parsed.ctrl || parsed.meta) && !parsed.alt;
}