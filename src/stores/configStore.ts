import { create } from "zustand";
import { getUserConfig } from "../commands";
import type { KeybindingMap } from "../config/keybindings";
import { DEFAULT_KEYBINDINGS } from "../config/keybindings";
import { useUiStore } from "./uiStore";

interface ConfigStore {
  /** Merged defaults + user.json overrides; defaults apply until loaded. */
  keybindings: KeybindingMap;
  load: () => Promise<void>;
}

export const useConfigStore = create<ConfigStore>((set) => ({
  keybindings: { ...DEFAULT_KEYBINDINGS },

  load: async () => {
    try {
      const config = await getUserConfig();
      // Merge so partial user files never drop the backed-in defaults.
      const keybindings = { ...DEFAULT_KEYBINDINGS, ...config.keybindings };
      set({ keybindings });
      if (config.notice) {
        useUiStore.getState().showToast(config.notice, "error");
      }
    } catch {
      // The backend never fails for a readable config; stay on defaults.
    }
  },
}));