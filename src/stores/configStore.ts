import { create } from "zustand";
import {
  getShells,
  getUserConfig,
  setUserConfig,
} from "../commands";
import type {
  EditorSettings,
  GeneralSettings,
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
  fontSize: 14,
  tabSize: 2,
  wordWrap: "off",
  minimap: false,
};

const DEFAULT_TERMINAL: TerminalSettings = { defaultShell: "auto" };

const DEFAULT_GENERAL: GeneralSettings = {
  restoreLastWorkspace: true,
  confirmBeforeClose: true,
};

interface ConfigStore {
  loaded: boolean;
  keybindings: KeybindingMap;
  editor: EditorSettings;
  terminal: TerminalSettings;
  general: GeneralSettings;
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
  /**
   * Persist a single keybinding, running duplicate detection across the other
   * actions. Resolves false when another action already owns the chord.
   */
  saveKeybinding: (
    action: KeybindingAction,
    chord: string,
  ) => Promise<{ ok: boolean; conflict?: KeybindingAction }>;
}

/** The defaults as a patch, used to persist partial updates cleanly. */
const baseConfig = (): UserConfigPatch => ({
  keybindings: { ...DEFAULT_KEYBINDINGS },
  editor: { ...DEFAULT_EDITOR },
  terminal: { ...DEFAULT_TERMINAL },
  general: { ...DEFAULT_GENERAL },
});

export const useConfigStore = create<ConfigStore>((set, get) => ({
  loaded: false,
  keybindings: { ...DEFAULT_KEYBINDINGS },
  editor: { ...DEFAULT_EDITOR },
  terminal: { ...DEFAULT_TERMINAL },
  general: { ...DEFAULT_GENERAL },
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
        editor: { ...DEFAULT_EDITOR, ...config.editor },
        terminal: { ...DEFAULT_TERMINAL, ...config.terminal },
        general: { ...DEFAULT_GENERAL, ...config.general },
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
    const editor = { ...get().editor, ...patch };
    set({ editor });
    const state = get();
    const full = baseConfig();
    full.keybindings = { ...state.keybindings };
    full.editor = { ...editor };
    full.terminal = { ...state.terminal };
    full.general = { ...state.general };
    try {
      await setUserConfig(full);
    } catch (err) {
      useUiStore.getState().showToast(`保存配置失败: ${String(err)}`, "error");
    }
  },

  updateTerminal: async (patch) => {
    const terminal = { ...get().terminal, ...patch };
    set({ terminal });
    const state = get();
    const full = baseConfig();
    full.keybindings = { ...state.keybindings };
    full.editor = { ...state.editor };
    full.terminal = { ...terminal };
    full.general = { ...state.general };
    try {
      await setUserConfig(full);
    } catch (err) {
      useUiStore.getState().showToast(`保存配置失败: ${String(err)}`, "error");
    }
  },

  updateGeneral: async (patch) => {
    const general = { ...get().general, ...patch };
    set({ general });
    const state = get();
    const full = baseConfig();
    full.keybindings = { ...state.keybindings };
    full.editor = { ...state.editor };
    full.terminal = { ...state.terminal };
    full.general = { ...general };
    try {
      await setUserConfig(full);
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
    const state = get();
    const full = baseConfig();
    full.keybindings = { ...keybindings };
    full.editor = { ...state.editor };
    full.terminal = { ...state.terminal };
    full.general = { ...state.general };
    try {
      await setUserConfig(full);
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