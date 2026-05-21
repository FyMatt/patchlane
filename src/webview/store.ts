import { create } from "zustand";
import { ChatMode, ExtensionState } from "./types";

interface UiState {
  extensionState: ExtensionState;
  activeMode: ChatMode;
  activePanel: "chat" | "changes" | "settings";
  draft: string;
  setExtensionState(state: ExtensionState): void;
  setActiveMode(mode: ChatMode): void;
  setActivePanel(panel: UiState["activePanel"]): void;
  setDraft(value: string): void;
}

export const emptyExtensionState: ExtensionState = {
  view: "sessions",
  models: [],
  sessions: [],
  transcript: [],
  session: undefined,
  patch: {
    repairCount: 0
  },
  context: {
    hasFile: false,
    hasSelection: false
  },
  workspaceFiles: [],
  mcpServers: [],
  mcpCatalog: [],
  capabilityDiagnostics: [],
  webSearch: {
    enabled: false,
    provider: "custom",
    baseUrl: "",
    maxResults: 6,
    allowedDomains: [],
    blockedDomains: [],
    requireApproval: true
  },
  busy: false
};

export const useCodeAgentStore = create<UiState>((set) => ({
  extensionState: emptyExtensionState,
  activeMode: "chat",
  activePanel: "chat",
  draft: "",
  setExtensionState: (state) => set({ extensionState: state }),
  setActiveMode: (mode) => set({ activeMode: mode }),
  setActivePanel: (panel) => set({ activePanel: panel }),
  setDraft: (draft) => set({ draft })
}));
