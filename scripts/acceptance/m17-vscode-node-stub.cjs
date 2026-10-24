"use strict";
/**
 * Minimal VS Code API stub for unit tests.
 * All Config getters fall through to their DEFAULTS when no override is set.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.env = exports.commands = exports.TreeItem = exports.TreeItemCollapsibleState = exports.ExtensionContext = exports.EventEmitter = exports.Uri = exports.ConfigurationTarget = exports.ProgressLocation = exports.window = exports.MockOutputChannel = exports.MockCancellationToken = exports.workspace = void 0;
exports._setConfig = _setConfig;
exports._setConfigForResource = _setConfigForResource;
exports._resetConfig = _resetConfig;
exports._setInputBoxValue = _setInputBoxValue;
exports._requestProgressCancellation = _requestProgressCancellation;
exports._cancelActiveProgress = _cancelActiveProgress;
exports._hasActiveProgress = _hasActiveProgress;
exports._resetWindowState = _resetWindowState;
exports._lastQuickPickItems = _lastQuickPickItems;
exports._setQuickPickSelection = _setQuickPickSelection;
exports._setWarningMessageSelection = _setWarningMessageSelection;
exports._configUpdates = _configUpdates;
exports._resetNotifications = _resetNotifications;
exports._registeredCommand = _registeredCommand;
exports._resetCommands = _resetCommands;
exports._outputChannels = _outputChannels;
exports._lastWarningMessage = _lastWarningMessage;
exports._lastInformationMessage = _lastInformationMessage;
exports._lastErrorMessage = _lastErrorMessage;
const overrides = new Map();
const resourceOverrides = new Map();
const registeredCommands = new Map();
const outputChannels = [];
let nextInputBoxValue;
let progressCancellationRequested = false;
let activeProgressToken;
let lastWarningMessage;
let lastInformationMessage;
let lastErrorMessage;
let nextQuickPickItems;
let nextQuickPickSelection;
let nextWarningMessageSelection;
const configUpdates = [];
function _setConfig(key, value) {
    overrides.set(key, value);
}
function _setConfigForResource(resourcePath, key, value) {
    const existing = resourceOverrides.get(resourcePath) ?? new Map();
    existing.set(key, value);
    resourceOverrides.set(resourcePath, existing);
}
function _resetConfig() {
    overrides.clear();
    resourceOverrides.clear();
    configUpdates.length = 0;
}
function _setInputBoxValue(value) {
    nextInputBoxValue = value;
}
function _requestProgressCancellation() {
    progressCancellationRequested = true;
}
function _cancelActiveProgress() {
    activeProgressToken?.cancel();
}
function _hasActiveProgress() {
    return activeProgressToken !== undefined;
}
function _resetWindowState() {
    nextInputBoxValue = undefined;
    progressCancellationRequested = false;
    lastWarningMessage = undefined;
    lastInformationMessage = undefined;
    lastErrorMessage = undefined;
    nextQuickPickItems = undefined;
    nextQuickPickSelection = undefined;
    nextWarningMessageSelection = undefined;
    activeProgressToken = undefined;
    outputChannels.length = 0;
}
function _lastQuickPickItems() {
    return nextQuickPickItems;
}
function _setQuickPickSelection(value) {
    nextQuickPickSelection = value;
}
function _setWarningMessageSelection(value) {
    nextWarningMessageSelection = value;
}
function _configUpdates() {
    return configUpdates;
}
function _resetNotifications() {
    lastWarningMessage = undefined;
    lastInformationMessage = undefined;
    lastErrorMessage = undefined;
}
function _registeredCommand(id) {
    return registeredCommands.get(id);
}
function _resetCommands() {
    registeredCommands.clear();
}
function _outputChannels() {
    return outputChannels;
}
function _lastWarningMessage() {
    return lastWarningMessage;
}
function _lastInformationMessage() {
    return lastInformationMessage;
}
function _lastErrorMessage() {
    return lastErrorMessage;
}
exports.workspace = {
    getConfiguration: (section, resource) => ({
        get: (key, defaultValue) => {
            const full = `${section}.${key}`;
            const resourceValue = resource?.fsPath ? resourceOverrides.get(resource.fsPath)?.get(full) : undefined;
            if (resourceValue !== undefined)
                return resourceValue;
            return overrides.has(full) ? overrides.get(full) : defaultValue;
        },
        has: (key) => overrides.has(`${section}.${key}`),
        inspect: (key) => {
            const full = `${section}.${key}`;
            return overrides.has(full)
                ? { key: full, globalValue: overrides.get(full) }
                : { key: full };
        },
        update: async (key, value, target) => {
            overrides.set(`${section}.${key}`, value);
            configUpdates.push({ key: `${section}.${key}`, value, target });
        },
    }),
    workspaceFolders: undefined,
    onDidChangeConfiguration: () => ({ dispose: () => { } }),
};
class MockCancellationToken {
    constructor() {
        this.emitter = new EventEmitter();
        this.isCancellationRequested = false;
        this.onCancellationRequested = this.emitter.event;
    }
    cancel() {
        this.isCancellationRequested = true;
        this.emitter.fire(undefined);
    }
}
exports.MockCancellationToken = MockCancellationToken;
class MockOutputChannel {
    constructor(name) {
        this.name = name;
        this.lines = [];
        this.disposed = false;
        this.shown = false;
    }
    appendLine(line) {
        this.lines.push(line);
    }
    append(text) {
        this.lines.push(text);
    }
    show() {
        this.shown = true;
    }
    hide() { }
    dispose() {
        this.disposed = true;
    }
    clear() {
        this.lines.length = 0;
    }
    content() {
        return this.lines.join('\n');
    }
}
exports.MockOutputChannel = MockOutputChannel;
exports.window = {
    showErrorMessage: (msg) => {
        lastErrorMessage = msg;
        return Promise.resolve(undefined);
    },
    showInformationMessage: (msg) => {
        lastInformationMessage = msg;
        return Promise.resolve(undefined);
    },
    showWarningMessage: (msg) => {
        lastWarningMessage = msg;
        return Promise.resolve(nextWarningMessageSelection);
    },
    showQuickPick: (items) => {
        nextQuickPickItems = items;
        return Promise.resolve(nextQuickPickSelection);
    },
    showInputBox: () => Promise.resolve(nextInputBoxValue),
    withProgress: async (_options, task) => {
        const token = new MockCancellationToken();
        activeProgressToken = token;
        const result = task({ report: () => { } }, token);
        if (progressCancellationRequested) {
            await Promise.resolve();
            token.cancel();
        }
        try {
            return await result;
        }
        finally {
            if (activeProgressToken === token) {
                activeProgressToken = undefined;
            }
        }
    },
    createOutputChannel: (name) => {
        const channel = new MockOutputChannel(name);
        outputChannels.push(channel);
        return channel;
    },
};
exports.ProgressLocation = {
    SourceControl: 1,
    Window: 10,
    Notification: 15,
};
exports.ConfigurationTarget = {
    Global: 1,
    Workspace: 2,
    WorkspaceFolder: 3,
};
exports.Uri = {
    file: (p) => ({ fsPath: p, path: p, toString: () => p }),
    parse: (s) => ({ fsPath: s, path: s, toString: () => s }),
    joinPath: (base, ...segments) => {
        const joined = [base.fsPath, ...segments].join('/');
        return { fsPath: joined, path: joined, toString: () => joined };
    },
};
class EventEmitter {
    constructor() {
        this.listeners = [];
        this.event = (listener) => {
            this.listeners.push(listener);
            return { dispose: () => { } };
        };
    }
    fire(data) {
        this.listeners.forEach((l) => l(data));
    }
    dispose() { }
}
exports.EventEmitter = EventEmitter;
exports.ExtensionContext = {};
var TreeItemCollapsibleState;
(function (TreeItemCollapsibleState) {
    TreeItemCollapsibleState[TreeItemCollapsibleState["None"] = 0] = "None";
    TreeItemCollapsibleState[TreeItemCollapsibleState["Collapsed"] = 1] = "Collapsed";
    TreeItemCollapsibleState[TreeItemCollapsibleState["Expanded"] = 2] = "Expanded";
})(TreeItemCollapsibleState || (exports.TreeItemCollapsibleState = TreeItemCollapsibleState = {}));
class TreeItem {
    constructor(label, collapsibleState) {
        this.label = label;
        this.collapsibleState = collapsibleState;
    }
}
exports.TreeItem = TreeItem;
exports.commands = {
    registerCommand: (id, cb) => {
        registeredCommands.set(id, cb);
        return { dispose: () => { registeredCommands.delete(id); } };
    },
    executeCommand: async (_id, ..._args) => undefined,
};
exports.env = {
    clipboard: { writeText: async (_s) => { } },
};
