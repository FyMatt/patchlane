export interface VsCodeApi {
  postMessage(message: unknown): void;
  getState(): unknown;
  setState(state: unknown): void;
}

declare global {
  interface Window {
    acquireVsCodeApi?: () => VsCodeApi;
  }
}

let api: VsCodeApi | undefined;

export function getVsCodeApi(): VsCodeApi {
  if (!api) {
    if (!window.acquireVsCodeApi) {
      throw new Error("VS Code API is not available.");
    }
    api = window.acquireVsCodeApi();
  }
  return api;
}
