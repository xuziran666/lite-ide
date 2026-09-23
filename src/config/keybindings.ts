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