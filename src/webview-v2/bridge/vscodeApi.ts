declare function acquireVsCodeApi(): {
  postMessage(msg: unknown): void;
  getState(): unknown;
  setState(state: unknown): void;
};

let cached: ReturnType<typeof acquireVsCodeApi> | undefined;

export function getVsCodeApi() {
  if (!cached) cached = acquireVsCodeApi();
  return cached;
}
