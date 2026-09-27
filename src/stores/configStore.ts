import { create } from "zustand";
import {
  getShells,
  getUserConfig,
  readGlobalFile,
  setUserConfig,
} from "../commands";
import type {
  AutoSaveSettings,
  DebugAdapterConfig,
  DebugConfig,
  EditorSettings,
  FilesSettings,
  GeneralSettings,
  LspConfig,
  TerminalSettings,
  UserConfig,
  UserConfigPatch,
} from "../commands";
import type {
  KeybindingAction,
  KeybindingMap,
} from "../config/keybindings";
import {
  DEFAULT_KEYBINDINGS,
  isDoubleCtrlChord,
} from "../config/keybindings";
import { useUiStore } from "./uiStore";

const DEFAULT_EDITOR: EditorSettings = {
  fontFamily: "Consolas, 'Courier New', monospace",
  fontSize: 14,
  fontLigatures: false,
  tabSize: 2,
  wordWrap: "off",
  minimap: false,
  lineNumbers: "on",
  renderWhitespace: "selection",
  renderLineHighlight: "line",
  guides: { indentation: true },
  folding: true,
  matchBrackets: "near",
  smoothScrolling: false,
  cursorStyle: "line",
  cursorBlinking: "blink",
  formatOnPaste: false,
  formatOnType: false,
  autoClosingBrackets: "languageDefined",
  autoClosingQuotes: "languageDefined",
  autoSurround: "languageDefined",
  trimAutoWhitespace: true,
  dragAndDrop: true,
  copyWithSyntaxHighlighting: true,
  bracketPairColorization: { enabled: true },
  mouseWheelZoom: false,
  theme: "vs-dark",
};

/**
 * Deep-clone the editor config so persisted patches never share the nested
 * `guides` / `bracketPairColorization` objects.
 */
function cloneEditor(editor: EditorSettings): EditorSettings {
  return {
    ...editor,
    guides: { ...editor.guides },
    bracketPairColorization: { ...editor.bracketPairColorization },
  };
}

const DEFAULT_TERMINAL: TerminalSettings = {
  defaultShell: "auto",
  fontFamily: "Cascadia Mono, Consolas, \"Courier New\", monospace",
  fontSize: 14,
};

const DEFAULT_GENERAL: GeneralSettings = {
  restoreLastWorkspace: true,
  confirmBeforeClose: true,
  theme: "dark",
};

const DEFAULT_FILES: FilesSettings = {
  autoSave: {
    afterDelay: false,
    onFocusChange: false,
    onWindowChange: false,
    delay: 1000,
  },
};

/** Deep-clone the files config so persisted patches never share nested objects. */
function cloneFiles(files: FilesSettings): FilesSettings {
  return { autoSave: { ...files.autoSave } };
}

const DEFAULT_LSP: LspConfig = {
  rust: { command: "rust-analyzer", args: [] },
  cpp: { command: "clangd", args: [] },
  typescript: { command: "typescript-language-server", args: ["--stdio"] },
};

/** Deep-clone the LSP config so persisted patches never share nested objects. */
function cloneLsp(lsp: LspConfig): LspConfig {
  return {
    rust: { command: lsp.rust.command, args: [...lsp.rust.args] },
    cpp: { command: lsp.cpp.command, args: [...lsp.cpp.args] },
    typescript: {
      command: lsp.typescript.command,
      args: [...lsp.typescript.args],
    },
  };
}

const DEFAULT_DEBUG: DebugConfig = { adapters: {}, launch: {} };

/**
 * Deep-clone the debug config. `launch.<language>` is arbitrary user JSON that
 * reaches the adapter untouched, so it is cloned structurally rather than
 * shallow-copied: a shared nested object in a saved patch would let a later
 * mutation rewrite what is on disk.
 */
function cloneDebug(debug: DebugConfig): DebugConfig {
  const launch: Record<string, Record<string, unknown>> = {};
  for (const [language, args] of Object.entries(debug.launch ?? {})) {
    launch[language] = JSON.parse(JSON.stringify(args)) as Record<string, unknown>;
  }
  const adapters: Record<string, DebugAdapterConfig> = {};
  for (const [language, entry] of Object.entries(debug.adapters ?? {})) {
    adapters[language] = { command: entry.command, args: [...entry.args] };
  }
  return { adapters, launch };
}

interface ConfigStore {
  loaded: boolean;
  keybindings: KeybindingMap;
  editor: EditorSettings;
  terminal: TerminalSettings;
  general: GeneralSettings;
  lsp: LspConfig;
  debug: DebugConfig;
  files: FilesSettings;
  shells: string[];
  configDir: string;
  settingsOpen: boolean;
  notice: string | null;

  load: () => Promise<void>;
  openSettings: () => void;
  closeSettings: () => void;
  updateEditor: (patch: Partial<EditorSettings>) => Promise<void>;
  updateTerminal: (patch: Partial<TerminalSettings>) => Promise<void>;
  updateGeneral: (patch: Partial<GeneralSettings>) => Promise<void>;
  updateAutoSave: (patch: Partial<AutoSaveSettings>) => Promise<void>;
  /**
   * Persist a single keybinding, running duplicate detection across the other
   * actions. Resolves false when another action already owns the chord.
   */
  saveKeybinding: (
    action: KeybindingAction,
    chord: string,
  ) => Promise<{ ok: boolean; conflict?: KeybindingAction }>;
}

/**
 * Build the patch to persist: every section is taken from the live store except
 * the one just changed.
 *
 * The backend replaces `user.json` wholesale, so a save that forgets a section
 * does not "leave it alone" — it *erases* it. That is why this is one function
 * instead of a block repeated per setter: adding a config section must never
 * mean remembering to add it here too, and `debug` (user-authored, unrecoverable
 * once deleted) is exactly the section that must not be lost when the user
 * changes, say, the font size.
 */
function fullConfig(
  state: ConfigStore,
  patch: Partial<UserConfigPatch> = {},
): UserConfigPatch {
  return {
    keybindings: { ...state.keybindings },
    editor: cloneEditor(state.editor),
    terminal: { ...state.terminal },
    general: { ...state.general },
    lsp: cloneLsp(state.lsp),
    debug: cloneDebug(state.debug),
    files: cloneFiles(state.files),
    ...patch,
  };
}

export const useConfigStore = create<ConfigStore>((set, get) => ({
  loaded: false,
  keybindings: { ...DEFAULT_KEYBINDINGS },
  editor: cloneEditor(DEFAULT_EDITOR),
  terminal: { ...DEFAULT_TERMINAL },
  general: { ...DEFAULT_GENERAL },
  lsp: cloneLsp(DEFAULT_LSP),
  debug: cloneDebug(DEFAULT_DEBUG),
  files: cloneFiles(DEFAULT_FILES),
  shells: [],
  configDir: "",
  settingsOpen: false,
  notice: null,

  load: async () => {
    try {
      const config: UserConfig = await getUserConfig();
      set({
        loaded: true,
        keybindings: { ...DEFAULT_KEYBINDINGS, ...config.keybindings },
        editor: cloneEditor({ ...DEFAULT_EDITOR, ...config.editor }),
        terminal: { ...DEFAULT_TERMINAL, ...config.terminal },
        general: { ...DEFAULT_GENERAL, ...config.general },
        lsp: {
          rust: { ...DEFAULT_LSP.rust, ...config.lsp?.rust },
          cpp: { ...DEFAULT_LSP.cpp, ...config.lsp?.cpp },
          typescript: { ...DEFAULT_LSP.typescript, ...config.lsp?.typescript },
        },
        // The user's own adapter/launch entries win as-is: there is nothing to
        // merge with, since an empty table is the intended state for a
        // language that has not been set up yet.
        debug: cloneDebug({
          adapters: config.debug?.adapters ?? {},
          launch: config.debug?.launch ?? {},
        }),
        files: {
          autoSave: { ...DEFAULT_FILES.autoSave, ...config.files?.autoSave },
        },
        configDir: config.configDir,
        notice: config.notice,
      });
      if (config.notice) {
        useUiStore.getState().showToast(config.notice, "error");
      }
    } catch (err) {
      // The backend never fails for a readable config; keep defaults.
      useUiStore.getState().showToast(`加载配置失败: ${String(err)}`, "error");
    }
  },

  openSettings: () => set({ settingsOpen: true }),
  closeSettings: () => set({ settingsOpen: false }),

  updateEditor: async (patch) => {
    const editor = cloneEditor({ ...get().editor, ...patch });
    set({ editor });
    try {
      await setUserConfig(fullConfig(get(), { editor: cloneEditor(editor) }));
    } catch (err) {
      useUiStore.getState().showToast(`保存配置失败: ${String(err)}`, "error");
    }
  },

  updateTerminal: async (patch) => {
    const terminal = { ...get().terminal, ...patch };
    set({ terminal });
    try {
      await setUserConfig(fullConfig(get(), { terminal: { ...terminal } }));
    } catch (err) {
      useUiStore.getState().showToast(`保存配置失败: ${String(err)}`, "error");
    }
  },

  updateGeneral: async (patch) => {
    const general = { ...get().general, ...patch };
    set({ general });
    try {
      await setUserConfig(fullConfig(get(), { general: { ...general } }));
    } catch (err) {
      useUiStore.getState().showToast(`保存配置失败: ${String(err)}`, "error");
    }
  },

  updateAutoSave: async (patch) => {
    const current = get().files;
    const files: FilesSettings = {
      autoSave: { ...current.autoSave, ...patch },
    };
    set({ files });
    try {
      await setUserConfig(fullConfig(get(), { files: cloneFiles(files) }));
    } catch (err) {
      useUiStore.getState().showToast(`保存配置失败: ${String(err)}`, "error");
    }
  },

  saveKeybinding: async (action, chord) => {
    const current = { ...get().keybindings };
    if (isDoubleCtrlChord(chord)) {
      // Ctrl+Ctrl cannot be recorded for anything but openTaskCenter.
      if (action !== "openTaskCenter") {
        return { ok: false, conflict: action };
      }
    } else {
      const owner = Object.entries(current).find(
        ([otherAction, other]) =>
          otherAction !== action && other === chord,
      );
      if (owner) {
        return { ok: false, conflict: owner[0] as KeybindingAction };
      }
    }
    const keybindings = { ...current, [action]: chord };
    set({ keybindings });
    try {
      await setUserConfig(
        fullConfig(get(), { keybindings: { ...keybindings } }),
      );
      return { ok: true };
    } catch (err) {
      useUiStore.getState().showToast(`保存快捷键失败: ${String(err)}`, "error");
      return { ok: false };
    }
  },
}));

/**
 * Load the available shells once from the backend so the Default Shell
 * dropdown reflects what is actually installed on the machine.
 */
export async function loadShells(force = false): Promise<void> {
  const { shells } = useConfigStore.getState();
  if (!force && shells.length > 0) return;
  try {
    const detected = await getShells();
    useConfigStore.setState({ shells: detected });
  } catch (err) {
    useUiStore.getState().showToast(`检测外壳失败: ${String(err)}`, "error");
  }
}

/**
 * The configured server argv for a language id, read from the live config.
 * Returns undefined for unknown languages (no override, backend default wins).
 */
export function lspCommandFor(language: string): string[] | undefined {
  const { lsp } = useConfigStore.getState();
  const entry =
    language === "rust"
      ? lsp.rust
      : language === "cpp"
        ? lsp.cpp
        : language === "typescript"
          ? lsp.typescript
          : undefined;
  if (!entry || !entry.command) return undefined;
  return [entry.command, ...entry.args];
}
/**
 * The configured adapter argv for a language id, read from the live config.
 *
 * Unlike `lspCommandFor` there is deliberately **no** fallback: which debugger
 * drives which program is not a decision the app may make on the user's behalf,
 * so an unconfigured language yields `undefined` and the user gets told which
 * config key to add instead of a confusing "adapter not found".
 */
export function debugAdapterFor(language: string): string[] | undefined {
  const entry = useConfigStore.getState().debug.adapters[language];
  if (!entry || !entry.command) return undefined;
  return [entry.command, ...entry.args];
}

/** The user's launch arguments for a language, verbatim from `user.json`. */
export function debugLaunchFor(
  language: string,
): Record<string, unknown> | undefined {
  return useConfigStore.getState().debug.launch[language];
}

/**
 * Make sure the global `user.json` exists, creating it from the current
 * resolved configuration when it is missing.
 *
 * This is the "initialize it, then open it" half of the settings sections that
 * edit the global config: the file is written through the same `setUserConfig`
 * path the Settings page already uses, so what the editor opens is exactly what
 * the app reads on the next launch — not a workspace-local copy and not a
 * hand-rolled schema that could drift from `config.rs`.
 *
 * An existing file is left untouched (byte-for-byte), so a user who formatted
 * their own `user.json` never has it rewritten just because they opened it.
 */
export async function ensureUserConfigFile(): Promise<void> {
  const state = useConfigStore.getState();
  if (!state.configDir) return;
  try {
    if ((await readGlobalFile("user.json")) !== null) return;
  } catch {
    // An unreadable file counts as absent; the save below recreates it.
  }
  await setUserConfig(fullConfig(state));
}
