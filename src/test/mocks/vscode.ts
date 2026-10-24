/**
 * Minimal VS Code API stub for unit tests.
 * All Config getters fall through to their DEFAULTS when no override is set.
 */

const overrides = new Map<string, unknown>();
/** Workspace-scope values; VS Code resolves these above user (Global) values. */
const workspaceOverrides = new Map<string, unknown>();
const resourceOverrides = new Map<string, Map<string, unknown>>();
const registeredCommands = new Map<string, (...args: unknown[]) => unknown>();
const outputChannels: MockOutputChannel[] = [];
let nextInputBoxValue: string | undefined;
let progressCancellationRequested = false;
let activeProgressToken: MockCancellationToken | undefined;
let lastProgressOptions: { title?: string } | undefined;
let lastWarningMessage: string | undefined;
let lastInformationMessage: string | undefined;
let lastErrorMessage: string | undefined;
let nextQuickPickItems: unknown[] | undefined;
let nextQuickPickSelection: unknown | undefined;
let nextWarningMessageSelection: string | undefined;
const configUpdates: Array<{ key: string; value: unknown; target: unknown }> = [];

export function _setConfig(key: string, value: unknown): void {
  overrides.set(key, value);
}

export function _setWorkspaceConfig(key: string, value: unknown): void {
  workspaceOverrides.set(key, value);
}

export function _setConfigForResource(resourcePath: string, key: string, value: unknown): void {
  const existing = resourceOverrides.get(resourcePath) ?? new Map<string, unknown>();
  existing.set(key, value);
  resourceOverrides.set(resourcePath, existing);
}

export function _resetConfig(): void {
  overrides.clear();
  workspaceOverrides.clear();
  resourceOverrides.clear();
  configUpdates.length = 0;
}

export function _setInputBoxValue(value: string | undefined): void {
  nextInputBoxValue = value;
}

export function _requestProgressCancellation(): void {
  progressCancellationRequested = true;
}

export function _cancelActiveProgress(): void {
  activeProgressToken?.cancel();
}

export function _hasActiveProgress(): boolean {
  return activeProgressToken !== undefined;
}

export function _resetWindowState(): void {
  nextInputBoxValue = undefined;
  progressCancellationRequested = false;
  lastWarningMessage = undefined;
  lastInformationMessage = undefined;
  lastErrorMessage = undefined;
  nextQuickPickItems = undefined;
  nextQuickPickSelection = undefined;
  nextWarningMessageSelection = undefined;
  activeProgressToken = undefined;
  lastProgressOptions = undefined;
  outputChannels.length = 0;
}

export function _lastQuickPickItems(): unknown[] | undefined {
  return nextQuickPickItems;
}

export function _setQuickPickSelection(value: unknown | undefined): void {
  nextQuickPickSelection = value;
}

export function _setWarningMessageSelection(value: string | undefined): void {
  nextWarningMessageSelection = value;
}

export function _configUpdates(): readonly { key: string; value: unknown; target: unknown }[] {
  return configUpdates;
}

export function _resetNotifications(): void {
  lastWarningMessage = undefined;
  lastInformationMessage = undefined;
  lastErrorMessage = undefined;
}

export function _registeredCommand(id: string): ((...args: unknown[]) => unknown) | undefined {
  return registeredCommands.get(id);
}

export function _resetCommands(): void {
  registeredCommands.clear();
}

export function _outputChannels(): readonly MockOutputChannel[] {
  return outputChannels;
}

export function _lastWarningMessage(): string | undefined {
  return lastWarningMessage;
}

export function _lastInformationMessage(): string | undefined {
  return lastInformationMessage;
}

export function _lastErrorMessage(): string | undefined {
  return lastErrorMessage;
}

export function _lastProgressOptions(): { title?: string } | undefined {
  return lastProgressOptions;
}

export const workspace = {
  getConfiguration: (section: string, resource?: { fsPath?: string }) => ({
    get: <T>(key: string, defaultValue: T): T => {
      const full = `${section}.${key}`;
      const resourceValue = resource?.fsPath ? resourceOverrides.get(resource.fsPath)?.get(full) : undefined;
      if (resourceValue !== undefined) return resourceValue as T;
      if (workspaceOverrides.has(full)) return workspaceOverrides.get(full) as T;
      return overrides.has(full) ? (overrides.get(full) as T) : defaultValue;
    },
    has: (key: string) => overrides.has(`${section}.${key}`) || workspaceOverrides.has(`${section}.${key}`),
    inspect: (key: string) => {
      const full = `${section}.${key}`;
      return {
        key: full,
        ...(overrides.has(full) ? { globalValue: overrides.get(full) } : {}),
        ...(workspaceOverrides.has(full) ? { workspaceValue: workspaceOverrides.get(full) } : {}),
      };
    },
    update: async (key: string, value: unknown, target: unknown) => {
      // Real VS Code removes the setting (back to its default) when it is updated to undefined.
      const store = target === ConfigurationTarget.Workspace ? workspaceOverrides : overrides;
      if (value === undefined) store.delete(`${section}.${key}`);
      else store.set(`${section}.${key}`, value);
      configUpdates.push({ key: `${section}.${key}`, value, target });
    },
  }),
  workspaceFolders: undefined as undefined,
  onDidChangeConfiguration: () => ({ dispose: () => {} }),
};

export class MockCancellationToken {
  private readonly emitter = new EventEmitter<void>();
  isCancellationRequested = false;
  onCancellationRequested = this.emitter.event;

  cancel(): void {
    this.isCancellationRequested = true;
    this.emitter.fire(undefined);
  }
}

export class MockOutputChannel {
  readonly lines: string[] = [];
  disposed = false;
  shown = false;

  constructor(readonly name: string) {}

  appendLine(line: string): void {
    this.lines.push(line);
  }

  append(text: string): void {
    this.lines.push(text);
  }

  show(): void {
    this.shown = true;
  }

  hide(): void {}

  dispose(): void {
    this.disposed = true;
  }

  clear(): void {
    this.lines.length = 0;
  }

  content(): string {
    return this.lines.join('\n');
  }
}

export const window = {
  showErrorMessage: (msg: string) => {
    lastErrorMessage = msg;
    return Promise.resolve(undefined);
  },
  showInformationMessage: (msg: string) => {
    lastInformationMessage = msg;
    return Promise.resolve(undefined);
  },
  showWarningMessage: (msg: string) => {
    lastWarningMessage = msg;
    return Promise.resolve(nextWarningMessageSelection);
  },
  showQuickPick: (items: unknown[]) => {
    nextQuickPickItems = items;
    return Promise.resolve(nextQuickPickSelection);
  },
  showInputBox: () => Promise.resolve(nextInputBoxValue),
  withProgress: async (
    options: { title?: string },
    task: (_progress: unknown, token: MockCancellationToken) => Promise<unknown>,
  ) => {
    lastProgressOptions = options;
    const token = new MockCancellationToken();
    activeProgressToken = token;
    const result = task({ report: () => {} }, token);
    if (progressCancellationRequested) {
      await Promise.resolve();
      token.cancel();
    }
    try {
      return await result;
    } finally {
      if (activeProgressToken === token) {
        activeProgressToken = undefined;
      }
    }
  },
  createOutputChannel: (name: string) => {
    const channel = new MockOutputChannel(name);
    outputChannels.push(channel);
    return channel;
  },
  createWebviewPanel: (_viewType: string, title: string) => new MockWebviewPanel(title),
};

/**
 * Minimal stand-in for `vscode.WebviewPanel`, enough for panels that render by
 * assigning `webview.html` and listen for `onDidDispose` /
 * `onDidReceiveMessage`. `html` is captured so tests can assert on what was
 * actually rendered, and `renders` keeps the full ordered history so tests can
 * assert on render *sequence* (e.g. a stale state must never render after a
 * newer one).
 */
export class MockWebviewPanel {
  readonly renders: string[] = [];
  private readonly disposeEmitter = new EventEmitter<void>();
  private readonly messageEmitter = new EventEmitter<unknown>();
  readonly onDidDispose = this.disposeEmitter.event;
  readonly webview = {
    cspSource: 'vscode-test',
    html: '',
    onDidReceiveMessage: this.messageEmitter.event,
    postMessage: (_message: unknown) => Promise.resolve(true),
    asWebviewUri: (uri: { toString(): string }) => uri,
  };

  constructor(readonly title: string) {
    const renders = this.renders;
    let current = '';
    Object.defineProperty(this.webview, 'html', {
      get: () => current,
      set: (value: string) => {
        current = value;
        renders.push(value);
      },
    });
  }

  reveal(): void {}
  dispose(): void {
    this.disposeEmitter.fire();
  }
}

export const ViewColumn = {
  Active: -1,
  Beside: -2,
  One: 1,
  Two: 2,
};

export const ProgressLocation = {
  SourceControl: 1,
  Window: 10,
  Notification: 15,
};

export const ConfigurationTarget = {
  Global: 1,
  Workspace: 2,
  WorkspaceFolder: 3,
};

export const Uri = {
  file: (p: string) => ({ fsPath: p, path: p, toString: () => p }),
  parse: (s: string) => ({ fsPath: s, path: s, toString: () => s }),
  joinPath: (base: { fsPath: string }, ...segments: string[]) => {
    const joined = [base.fsPath, ...segments].join('/');
    return { fsPath: joined, path: joined, toString: () => joined };
  },
};

export class EventEmitter<T> {
  private listeners: Array<(e: T) => void> = [];
  event = (listener: (e: T) => void) => {
    this.listeners.push(listener);
    return { dispose: () => {} };
  };
  fire(data: T) {
    this.listeners.forEach((l) => l(data));
  }
  dispose() {}
}

export const ExtensionContext = {};

export enum TreeItemCollapsibleState {
  None = 0,
  Collapsed = 1,
  Expanded = 2,
}

export class TreeItem {
  constructor(public label: string, public collapsibleState?: TreeItemCollapsibleState) {}
}

export const commands = {
  registerCommand: (id: string, cb: (...args: unknown[]) => unknown) => {
    registeredCommands.set(id, cb);
    return { dispose: () => { registeredCommands.delete(id); } };
  },
  executeCommand: async (id: string, ...args: unknown[]) => {
    executedCommands.push({ id, args });
    const handler = commandHandlers.get(id);
    if (handler) return handler(...args);
    return undefined;
  },
};

const executedCommands: Array<{ id: string; args: unknown[] }> = [];
const commandHandlers = new Map<string, (...args: unknown[]) => unknown>();
let clipboardText = '';
let clipboardReads = 0;
const openedExternal: string[] = [];
let openExternalResult = true;

export function _executedCommands(): readonly { id: string; args: unknown[] }[] { return executedCommands; }
/** Makes `commands.executeCommand(id)` run `handler`, e.g. to simulate a missing/throwing built-in command. */
export function _setCommandHandler(id: string, handler: ((...args: unknown[]) => unknown) | undefined): void {
  if (handler) commandHandlers.set(id, handler); else commandHandlers.delete(id);
}
export function _resetEnv(): void {
  executedCommands.length = 0;
  commandHandlers.clear();
  clipboardText = '';
  clipboardReads = 0;
  openedExternal.length = 0;
  openExternalResult = true;
}
export function _setClipboardText(text: string): void { clipboardText = text; }
export function _clipboardReadCount(): number { return clipboardReads; }
export function _openedExternal(): readonly string[] { return openedExternal; }
export function _setOpenExternalResult(value: boolean): void { openExternalResult = value; }

export const env = {
  clipboard: {
    writeText: async (text: string) => { clipboardText = text; },
    readText: async () => { clipboardReads += 1; return clipboardText; },
  },
  openExternal: async (uri: { toString(): string }) => {
    openedExternal.push(uri.toString());
    return openExternalResult;
  },
};

export class MockSecretStorage {
  // Named distinctly from the `store(...)` method below — a same-named class
  // field would be assigned in the constructor and silently shadow the
  // prototype method with a Map instance, breaking every `secrets.store(...)`
  // call at runtime despite type-checking clean (test files sit outside the
  // main tsc project).
  private values = new Map<string, string>();
  private emitter = new EventEmitter<{ key: string }>();
  onDidChange = this.emitter.event;

  async get(key: string): Promise<string | undefined> {
    return this.values.get(key);
  }
  async store(key: string, value: string): Promise<void> {
    this.values.set(key, value);
    this.emitter.fire({ key });
  }
  async delete(key: string): Promise<void> {
    this.values.delete(key);
    this.emitter.fire({ key });
  }
}

export class MockMemento {
  private store = new Map<string, unknown>();
  get<T>(key: string, defaultValue?: T): T | undefined {
    return this.store.has(key) ? (this.store.get(key) as T) : defaultValue;
  }
  async update(key: string, value: unknown): Promise<void> {
    if (value === undefined) {
      this.store.delete(key);
    } else {
      this.store.set(key, value);
    }
  }
  keys(): readonly string[] {
    return [...this.store.keys()];
  }
}

export function createMockExtensionContext(): {
  secrets: MockSecretStorage;
  globalState: MockMemento;
  workspaceState: MockMemento;
  subscriptions: { dispose(): void }[];
  globalStorageUri: { fsPath: string };
  storageUri: { fsPath: string };
  extensionUri: { fsPath: string };
  extension: { packageJSON: { version: string } };
} {
  return {
    secrets: new MockSecretStorage(),
    globalState: new MockMemento(),
    workspaceState: new MockMemento(),
    subscriptions: [],
    globalStorageUri: Uri.file('/mock-global-storage'),
    storageUri: Uri.file('/mock-storage'),
    extensionUri: Uri.file('/mock-extension'),
    extension: { packageJSON: { version: '0.1.0' } },
  };
}
