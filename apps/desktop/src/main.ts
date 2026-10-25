import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import Module from 'node:module';
import {
  app,
  BrowserWindow,
  clipboard,
  dialog,
  ipcMain,
  Notification,
  powerMonitor,
  screen,
  shell,
} from 'electron';
import { DesktopSession } from './host/desktopSession';
import {
  formatDiagnosticsReport,
  resolveBuildIdentity,
  type DesktopBuildIdentity,
} from './host/desktopBuildIdentity';
import { readHostPreferences, writeHostPreferences } from './host/desktopHostPreferences';
import { DESKTOP_CHANNELS, type DesktopAppMetadata } from './ipc';
import { JarvisTrayController } from './host/jarvisTray';
import { createAppIcon } from './host/appIcon';
import { normalizeSafeExternalUrl, normalizeSafeBrowserUrl } from './host/desktopSafeOpen';
import { MobileServer } from './host/mobileServer';

/**
 * Dev: repo root. Portable / installed: directory that contains `app/` + `runtime/core.js`
 * (Launch-Jarvis.cmd may set KARKEDIKHA_DESKTOP_PRODUCT_ROOT; installed shortcuts need not).
 */
function resolveProductRoot(): string {
  if (process.env.KARKEDIKHA_DESKTOP_PRODUCT_ROOT?.trim()) {
    return path.resolve(process.env.KARKEDIKHA_DESKTOP_PRODUCT_ROOT);
  }
  const appRoot = path.resolve(__dirname, '..');
  const portableRoot = path.resolve(appRoot, '..');
  if (fs.existsSync(path.join(portableRoot, 'runtime', 'core.js'))) return portableRoot;
  return path.resolve(__dirname, '..', '..', '..');
}

/** Match DesktopSession defaultLocalAppData layout (no secrets in the install tree). */
function defaultDesktopDataDir(): string {
  if (process.platform === 'win32') {
    const localAppData = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
    return path.join(localAppData, 'KarkeDikha', 'desktop');
  }
  const xdg = process.env.XDG_DATA_HOME;
  if (xdg && xdg.trim()) return path.join(xdg, 'karkedikha', 'desktop');
  return path.join(os.homedir(), '.local', 'share', 'karkedikha', 'desktop');
}

/**
 * When launched from the portable/installed tree without a .cmd wrapper, wire Core + Node
 * and keep Ollama/local-only as the default routing policy.
 */
function applyPackagedHostDefaults(productRoot: string): void {
  const coreJs = path.join(productRoot, 'runtime', 'core.js');
  const nodeExe = path.join(productRoot, 'runtime', 'node.exe');
  if (!fs.existsSync(coreJs)) return;
  if (!process.env.KARKEDIKHA_DESKTOP_PRODUCT_ROOT?.trim()) {
    process.env.KARKEDIKHA_DESKTOP_PRODUCT_ROOT = productRoot;
  }
  if (!process.env.KARKEDIKHA_DESKTOP_CORE_PATH?.trim()) {
    process.env.KARKEDIKHA_DESKTOP_CORE_PATH = coreJs;
  }
  if (!process.env.KARKEDIKHA_DESKTOP_NODE?.trim()) {
    process.env.KARKEDIKHA_DESKTOP_NODE = fs.existsSync(nodeExe) ? nodeExe : 'node';
  }
  if (!process.env.KARKEDIKHA_MODEL_ROUTING_POLICY?.trim()) {
    process.env.KARKEDIKHA_MODEL_ROUTING_POLICY = 'local-only';
  }
  if (!process.env.KARKEDIKHA_DESKTOP_DATA_DIR?.trim()) {
    process.env.KARKEDIKHA_DESKTOP_DATA_DIR = defaultDesktopDataDir();
  }
}

const productRoot = resolveProductRoot();
applyPackagedHostDefaults(productRoot);

function prependNodeModulePath(dir: string): void {
  if (!fs.existsSync(dir)) return;
  const sep = path.delimiter;
  const existing = process.env.NODE_PATH ?? '';
  if (existing.split(sep).includes(dir)) return;
  process.env.NODE_PATH = existing ? `${dir}${sep}${existing}` : dir;
  (Module as typeof Module & { _initPaths: () => void })._initPaths();
}

prependNodeModulePath(path.join(productRoot, 'runtime-assets', 'node_modules'));
prependNodeModulePath(path.join(productRoot, 'node_modules'));

const dataDir = process.env.KARKEDIKHA_DESKTOP_DATA_DIR?.trim() || defaultDesktopDataDir();
const evidenceLogPath = process.env.KARKEDIKHA_DESKTOP_EVIDENCE
  ?? path.join(dataDir, 'desktop-slice-evidence.jsonl');
const hostLogPath = process.env.KARKEDIKHA_DESKTOP_HOST_LOG
  ?? path.join(dataDir, 'desktop-host.log');

function hostLog(message: string): void {
  const line = `[desktop ${new Date().toISOString()}] ${message}\n`;
  try {
    fs.mkdirSync(path.dirname(hostLogPath), { recursive: true });
    fs.appendFileSync(hostLogPath, line, 'utf8');
  } catch {
    // ignore
  }
  console.log(message);
}

/**
 * The build identity of the running app, read from the identity embedded in
 * the packaged tree. It never needs Git on the user's machine.
 */
function currentBuildIdentity(): DesktopBuildIdentity {
  const productRoot = resolveProductRoot();
  return resolveBuildIdentity(productRoot, String(app.getVersion?.() || '').trim());
}

/** The version the LIVE Core reports (its own discovery record), not a guess. */
function liveCoreVersion(): string | null {
  try {
    const record = JSON.parse(fs.readFileSync(path.join(dataDir, 'core.json'), 'utf8')) as { coreVersion?: string };
    const version = String(record.coreVersion ?? '').trim();
    return version || null;
  } catch {
    return null;
  }
}

function appMetadata(): DesktopAppMetadata {
  const productName = (app.getName && app.getName()) || 'Pandesh';
  const identity = currentBuildIdentity();
  const coreVersion = liveCoreVersion();
  return {
    productName,
    version: identity.version || String(app.getVersion?.() || '').trim(),
    buildNumber: identity.buildNumber,
    buildKind: identity.buildKind,
    releaseChannel: identity.releaseChannel,
    commit: identity.commit,
    builtAt: identity.builtAt,
    installerVersion: identity.installerVersion,
    coreVersion,
    coreVersionMismatch: Boolean(coreVersion) && coreVersion !== identity.version,
  };
}

/**
 * The block a user copies into a bug report: the build, the platform and the
 * runtime state. It contains no credentials, no user paths and no content.
 */
function diagnosticsReport(): string {
  const identity = currentBuildIdentity();
  return formatDiagnosticsReport({
    identity,
    productName: (app.getName && app.getName()) || 'Pandesh',
    coreVersion: liveCoreVersion(),
    coreConnected: session?.snapshot()?.coreState === 'connected',
    platform: process.platform,
    arch: process.arch,
    electronVersion: process.versions.electron ?? null,
    nodeVersion: process.versions.node ?? null,
  });
}

const cdpPort = process.env.KARKEDIKHA_DESKTOP_CDP_PORT?.trim();
const packageSmokeMode = process.env.KARKEDIKHA_DESKTOP_SMOKE_MODE === '1';
if (cdpPort) {
  app.commandLine.appendSwitch('remote-debugging-port', cdpPort);
}
if (process.env.KARKEDIKHA_DESKTOP_DISABLE_GPU === '1' || packageSmokeMode) {
  // Package smoke runs headless/hidden on machines where Electron's GPU
  // process can fail before the renderer file is loaded. Keep this opt-in so
  // normal user launches keep hardware acceleration.
  app.disableHardwareAcceleration();
  app.commandLine.appendSwitch('disable-gpu');
  app.commandLine.appendSwitch('disable-gpu-compositing');
  app.commandLine.appendSwitch('disable-gpu-sandbox');
  app.commandLine.appendSwitch('in-process-gpu');
  app.commandLine.appendSwitch('disable-software-rasterizer');
  if (packageSmokeMode) app.commandLine.appendSwitch('no-sandbox');
}
const desktopUserData = path.join(dataDir, 'electron-profile');
fs.mkdirSync(desktopUserData, { recursive: true });
app.setPath('userData', desktopUserData);

function resolveBundledCoreVersion(root: string): string {
  try {
    const pkg = path.join(root, 'package.json');
    if (fs.existsSync(pkg)) {
      const raw = JSON.parse(fs.readFileSync(pkg, 'utf8'));
      if (raw.version && typeof raw.version === 'string' && raw.version.trim()) {
        return raw.version.trim();
      }
    }
  } catch {}
  return '0.1.1';
}

/** Single-instance: second launches focus the existing tray/window, or request shutdown. */
const isShutdownRequested = process.argv.some(
  (arg) => arg === '--shutdown' || arg === '--shutdown-for-upgrade' || arg === '--quit',
);
const gotSingleInstanceLock = app.requestSingleInstanceLock();
if (!gotSingleInstanceLock) {
  hostLog('another Pandesh instance holds the lock; exiting immediately');
  app.quit();
  process.exit(0);
}
if (isShutdownRequested) {
  hostLog('shutdown requested via CLI but no running instance was holding lock; exiting immediately');
  app.quit();
  process.exit(0);
}

let session: DesktopSession | undefined;
let mobileServer: MobileServer | undefined;
let window: BrowserWindow | undefined;
let popoutWindow: BrowserWindow | undefined;
let tray: JarvisTrayController | undefined;
let isQuitting = false;
let isShuttingDown = false;
let windowHidden = false;
let prefs = readHostPreferences(dataDir);

function writeWindowState(state: {
  visible: boolean;
  minimized: boolean;
  focused: boolean;
  hiddenToTray?: boolean;
}): void {
  try {
    const b = window && !window.isDestroyed() ? window.getBounds() : undefined;
    const payload = {
      mainPid: process.pid,
      visible: state.visible,
      minimized: state.minimized,
      focused: state.focused,
      hiddenToTray: state.hiddenToTray !== undefined ? Boolean(state.hiddenToTray) : windowHidden,
      bounds: b,
      updatedAt: new Date().toISOString(),
    };
    const primaryFile = path.join(dataDir, 'window-state.json');
    fs.writeFileSync(primaryFile, JSON.stringify(payload, null, 2), 'utf8');
    if (!app.isPackaged) {
      const tmpFile = path.join(productRoot, '.tmp', 'desktop-window-state.json');
      try {
        fs.mkdirSync(path.dirname(tmpFile), { recursive: true });
        fs.writeFileSync(tmpFile, JSON.stringify(payload, null, 2), 'utf8');
      } catch {}
    }
  } catch {
    // ignore
  }
}

function sendToRenderer(channel: string, payload: unknown): void {
  if (window && !window.isDestroyed()) {
    window.webContents.send(channel, payload);
  }
  if (popoutWindow && !popoutWindow.isDestroyed()) {
    popoutWindow.webContents.send(channel, payload);
  }
}

function syncTrayFromSession(): void {
  if (!tray || !session) return;
  const snap = session.snapshot();
  let mobileStatus = 'Stopped';
  if (mobileServer && mobileServer.isRunning()) {
    const info = mobileServer.getPairingInfo();
    mobileStatus = `Running (${info.ip}:${info.port} · ${info.connectedClients} connected)`;
  }
  tray.update({
    wakeEnabled: Boolean(snap.wakeWord?.enabled),
    wakeMuted: Boolean(snap.wakeWord?.muted),
    speaking: Boolean(snap.speaking),
    openAtLogin: prefs.openAtLogin,
    windowHidden,
    mobileServerStatus: mobileStatus,
  });
}

function applyOpenAtLogin(enabled: boolean): void {
  prefs = writeHostPreferences(dataDir, { openAtLogin: enabled });
  try {
    app.setLoginItemSettings({
      openAtLogin: enabled,
      openAsHidden: true,
      path: process.execPath,
      args: process.defaultApp ? [path.resolve(process.argv[1] || '')] : [],
    });
  } catch (err) {
    hostLog(`setLoginItemSettings failed: ${(err as Error).message}`);
  }
  syncTrayFromSession();
}

function showJarvisWindow(): void {
  if (!window || window.isDestroyed()) {
    void ensureMainWindow().then(() => showJarvisWindow());
    return;
  }
  windowHidden = false;
  try {
    const bounds = window.getBounds();
    const displays = screen.getAllDisplays();
    const isVisibleOnAnyDisplay = displays.some((d) => {
      const wa = d.workArea;
      const intersectX = Math.max(0, Math.min(bounds.x + bounds.width, wa.x + wa.width) - Math.max(bounds.x, wa.x));
      const intersectY = Math.max(0, Math.min(bounds.y + bounds.height, wa.y + wa.height) - Math.max(bounds.y, wa.y));
      return intersectX >= 100 && intersectY >= 100;
    });
    if (!isVisibleOnAnyDisplay) {
      const primary = screen.getPrimaryDisplay().workArea;
      const width = Math.min(bounds.width || 1100, primary.width);
      const height = Math.min(bounds.height || 820, primary.height);
      window.setBounds({
        x: Math.round(primary.x + (primary.width - width) / 2),
        y: Math.round(primary.y + (primary.height - height) / 2),
        width,
        height,
      });
    }
  } catch (err) {
    hostLog(`screen bounds check error: ${(err as Error).message}`);
  }

  if (window.isMinimized()) window.restore();
  if (!window.isVisible()) window.show();
  window.show();
  window.restore();
  window.focus();
  window.moveTop();
  try {
    window.setAlwaysOnTop(true);
    window.focus();
    setTimeout(() => {
      if (window && !window.isDestroyed()) {
        window.setAlwaysOnTop(false);
      }
    }, 300);
  } catch {
    // ignore
  }
  writeWindowState({ visible: true, minimized: false, focused: true });
  syncTrayFromSession();
  sendSnapshot();
  // Recovery audit finding #4: reopening a tray-hidden window previously only
  // pushed the cached in-memory snapshot. restoreActiveTask() is the same
  // idempotent rehydration used at boot (a no-op when something is already
  // actively tracked), so this catches state Core changed while hidden.
  void session?.restoreActiveTask().then(() => sendSnapshot()).catch((err) => {
    hostLog(`restoreActiveTask on show failed: ${(err as Error).message}`);
  });
}

function hideJarvisToTray(): void {
  if (!window || window.isDestroyed()) return;
  windowHidden = true;
  window.hide();
  writeWindowState({ visible: false, minimized: false, focused: false, hiddenToTray: true });
  syncTrayFromSession();
  hostLog('window hidden to tray (reminders and wake continue while running)');
}

async function explainFirstCloseIfNeeded(): Promise<void> {
  if (prefs.firstCloseExplained || !window || window.isDestroyed() || packageSmokeMode || process.env.KARKEDIKHA_DESKTOP_SMOKE_MODE === '1') return;
  try {
    await dialog.showMessageBox(window, {
      type: 'info',
      title: 'Pandesh keeps running',
      message: 'Pandesh will stay in the system tray.',
      detail: [
        'Reminders, the daily brief and desktop alerts continue while Pandesh is running in the background.',
        'Wake listening continues if it is enabled (and not muted).',
        '',
        'Quit Pandesh from the tray menu when you want reminders and wake to stop.',
        'Alerts do not fire after Quit, while the computer is asleep, or while it is off.',
      ].join('\n'),
      buttons: ['OK'],
      defaultId: 0,
    });
  } catch {
    // ignore
  }
  prefs = writeHostPreferences(dataDir, { firstCloseExplained: true });
}

async function shutdownAndQuit(): Promise<void> {
  if (isShuttingDown) return;
  isShuttingDown = true;
  isQuitting = true;
  hostLog('Quit JARVIS requested — initiating full shutdown');

  // 1. Stop mobile server on 3030 and close SSE clients
  try {
    if (mobileServer) {
      mobileServer.stop();
      mobileServer = undefined;
      hostLog('Mobile server stopped and port 3030 released');
    }
  } catch (err) {
    hostLog(`Error stopping mobile server: ${(err as Error).message}`);
  }

  // 2. Dispose tray
  try {
    if (tray) {
      tray.dispose();
      tray = undefined;
      hostLog('Tray disposed');
    }
  } catch (err) {
    hostLog(`Error disposing tray: ${(err as Error).message}`);
  }

  // 3. Gracefully stop active session and child Core process
  try {
    if (session) {
      await session.shutdown({ timeoutMs: 5000 });
      session = undefined;
      hostLog('Session and child Core process shut down');
    }
  } catch (err) {
    hostLog(`Error shutting down session: ${(err as Error).message}`);
  }

  // 4. Dispose IPC listeners
  try {
    for (const channel of Object.values(DESKTOP_CHANNELS)) {
      try {
        ipcMain.removeHandler(channel);
      } catch {}
    }
    ipcMain.removeAllListeners();
    hostLog('IPC listeners disposed');
  } catch (err) {
    hostLog(`Error removing IPC handlers: ${(err as Error).message}`);
  }

  // 5. Close all BrowserWindows
  try {
    if (popoutWindow && !popoutWindow.isDestroyed()) {
      popoutWindow.removeAllListeners();
      popoutWindow.destroy();
      popoutWindow = undefined;
    }
  } catch {}
  try {
    if (window && !window.isDestroyed()) {
      window.removeAllListeners();
      window.destroy();
      window = undefined;
    }
  } catch {}
  try {
    const allWindows = BrowserWindow.getAllWindows();
    for (const w of allWindows) {
      if (!w.isDestroyed()) {
        w.removeAllListeners();
        w.destroy();
      }
    }
    hostLog('All BrowserWindows closed');
  } catch (err) {
    hostLog(`Error destroying windows: ${(err as Error).message}`);
  }

  // Update window state file indicating process has quit
  try {
    writeWindowState({ visible: false, minimized: false, focused: false, hiddenToTray: false });
  } catch {}

  // 6. Terminate Electron main process cleanly
  hostLog('Terminating Electron main process');
  try {
    app.quit();
  } catch {}

  setTimeout(() => {
    try {
      app.exit(0);
    } catch {}
    try {
      process.exit(0);
    } catch {}
  }, 250).unref();
}

function showReminderFromNotification(reminderId: string): void {
  showJarvisWindow();
  session?.openReminderFromNotification(reminderId);
  sendToRenderer(DESKTOP_CHANNELS.event, {
    kind: 'status',
    at: new Date().toISOString(),
    summary: 'Open reminder from notification',
    eventType: 'everyday_reminder_open',
    text: reminderId,
  });
}

function showQueueConfirmFromNotification(commandId: string): void {
  showJarvisWindow();
  session?.openQueueConfirmFromNotification(commandId);
  sendToRenderer(DESKTOP_CHANNELS.event, {
    kind: 'status',
    at: new Date().toISOString(),
    summary: 'Open queue confirmation from notification',
    eventType: 'command_queue_open',
    text: commandId,
  });
}

function showDesktopReminderNotification(input: { id: string; title: string; body: string }): void {
  if (!Notification.isSupported()) {
    hostLog(`desktop notification unsupported; reminder body=${input.body}`);
    return;
  }
  const notification = new Notification({
    title: input.title,
    body: input.body,
    silent: false,
  });
  notification.on('click', () => showReminderFromNotification(input.id));
  notification.show();
}

/**
 * Pandesh's daily brief landed. One notification per occurrence — Core's
 * delivery ledger refuses a second delivery of the same occurrence, so this
 * can only fire once.
 */
function showDesktopDailyBriefNotification(input: { title: string; body: string }): void {
  if (!Notification.isSupported()) {
    hostLog(`desktop notification unsupported; daily brief body=${input.body}`);
    return;
  }
  const notification = new Notification({
    title: input.title,
    body: input.body,
    silent: false,
  });
  notification.on('click', () => showJarvisWindow());
  notification.show();
}

function showDesktopQueueConfirmNotification(input: {  id: string;
  title: string;
  instruction: string;
}): void {
  if (!Notification.isSupported()) {
    hostLog(`desktop notification unsupported; queue confirm=${input.title}`);
    return;
  }
  const notification = new Notification({
    title: 'Confirm queued command',
    body: `${input.title}\nOpen KarkeDikha to Run, Edit, Skip, or Postpone. Silence leaves it waiting.`,
    silent: false,
  });
  notification.on('click', () => showQueueConfirmFromNotification(input.id));
  notification.show();
}

function showImageGenerationNotification(title: string, body: string): void {
  if (!Notification.isSupported()) return;
  const notification = new Notification({ title, body, silent: false });
  notification.on('click', () => showJarvisWindow());
  notification.show();
}

function showBackgroundTaskNotification(title: string, body: string): void {
  if (!Notification.isSupported()) return;
  const notification = new Notification({ title, body, silent: false });
  notification.on('click', () => showJarvisWindow());
  notification.show();
}

async function ensureMainWindow(): Promise<BrowserWindow> {
  if (window && !window.isDestroyed()) return window;
  window = new BrowserWindow({
    width: 1100,
    height: 820,
    title: 'Pandesh',
    backgroundColor: '#090d15',
    icon: createAppIcon(),
    show: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: !packageSmokeMode,
      spellcheck: false,
      backgroundThrottling: false,
    },
  });
  window.webContents.setBackgroundThrottling(false);
  // A link in a conversation opens in the system browser, never in a second
  // Electron window. The URL is validated first: only credential-free http and
  // https targets are ever handed to the OS.
  window.webContents.setWindowOpenHandler(({ url }) => {
    try {
      void shell.openExternal(normalizeSafeBrowserUrl(url));
    } catch {
      // A link the app refuses to open is simply not opened.
    }
    return { action: 'deny' };
  });
  window.webContents.on('will-navigate', (event, url) => {
    if (url === window.webContents.getURL()) return;
    event.preventDefault();
    try {
      void shell.openExternal(normalizeSafeBrowserUrl(url));
    } catch {
      // Refused: the app window never navigates away.
    }
  });

  window.on('close', (event) => {
    if (isQuitting || isShuttingDown) return;
    if (!tray || !tray.isAvailable()) {
      hostLog('Tray mode unavailable — window close terminates the app');
      event.preventDefault();
      void shutdownAndQuit();
      return;
    }
    event.preventDefault();
    void (async () => {
      await explainFirstCloseIfNeeded();
      hideJarvisToTray();
    })();
  });

  window.on('show', () => writeWindowState({ visible: true, minimized: window?.isMinimized() ?? false, focused: window?.isFocused() ?? false }));
  window.on('hide', () => writeWindowState({ visible: false, minimized: false, focused: false, hiddenToTray: true }));
  window.on('minimize', () => writeWindowState({ visible: false, minimized: true, focused: false }));
  window.on('restore', () => writeWindowState({ visible: true, minimized: false, focused: true }));
  window.on('focus', () => writeWindowState({ visible: true, minimized: false, focused: true }));
  window.on('blur', () => writeWindowState({ visible: window?.isVisible() ?? true, minimized: window?.isMinimized() ?? false, focused: false }));

  // Explicit push-to-talk / wake: allow media when the renderer requests it.
  window.webContents.session.setPermissionRequestHandler((_wc, permission, callback) => {
    callback(permission === 'media');
  });
  window.webContents.session.setPermissionCheckHandler((_wc, permission) => permission === 'media');
  await window.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  return window;
}

async function createWindow(): Promise<void> {
  tray = new JarvisTrayController({
    openJarvis: () => showJarvisWindow(),
    setWakeEnabled: async (enabled) => {
      if (!session) return;
      await session.setWakeWordEnabled(enabled);
      prefs = writeHostPreferences(dataDir, { wakeEnabled: enabled });
      sendSnapshot();
      syncTrayFromSession();
    },
    setWakeMuted: (muted) => {
      if (!session) return;
      session.setWakeWordMuted(muted);
      prefs = writeHostPreferences(dataDir, { wakeMuted: muted });
      sendSnapshot();
      syncTrayFromSession();
    },
    stopSpeaking: () => {
      if (!session) return;
      session.stopSpeaking('button');
      sendSnapshot();
      syncTrayFromSession();
    },
    setOpenAtLogin: (enabled) => applyOpenAtLogin(enabled),
    quitJarvis: () => { void shutdownAndQuit(); },
    openMobileUrl: () => {
      if (mobileServer) {
        const info = mobileServer.getPairingInfo();
        void shell.openExternal(info.url);
      }
    },
  }, hostLog);
  const trayInstance = tray.ensure();
  if (!trayInstance) {
    hostLog('Tray initialization failed; window close will terminate the app');
  }

  session = new DesktopSession({
    productRoot,
    dataDir,
    corePath: process.env.KARKEDIKHA_DESKTOP_CORE_PATH,
    bundledCoreVersion: resolveBundledCoreVersion(productRoot),
    evidenceLogPath,
    log: (message) => hostLog(message),
    notifyReminder: async (input) => showDesktopReminderNotification(input),
    onReminderNotificationClick: (id) => showReminderFromNotification(id),
    notifyQueueConfirm: async (input) => showDesktopQueueConfirmNotification(input),
    onQueueConfirmNotificationClick: (id) => showQueueConfirmFromNotification(id),
  });
  session.onEvent((event) => {
    sendToRenderer(DESKTOP_CHANNELS.event, event);
    if (event.eventType === 'image_generation_needs_input') {
      showImageGenerationNotification('Image needs approval', event.summary);
    } else if (event.eventType === 'image_generation_completed') {
      showImageGenerationNotification('Image ready', event.summary);
    } else if (event.eventType === 'image_generation_failed') {
      showImageGenerationNotification('Image generation failed', event.summary);
    } else if (event.eventType === 'daily_brief_delivered') {
      showDesktopDailyBriefNotification({
        title: event.summary || 'Your daily brief is ready',
        body: event.text || 'Open KarkeDikha to read it.',
      });
    } else if (event.eventType === 'background_task_completed') {
      showBackgroundTaskNotification(
        String((event as any).title || event.summary || 'Gmail Contract Extraction Completed'),
        String((event as any).text || 'Contract inventory table generated and delivered to conversation.'),
      );
    }
    if (
      event.kind === 'status'
      || event.eventType === 'everyday_reminder_alert'
      || event.eventType === 'command_queue_confirm'
    ) {
      syncTrayFromSession();
    }
  });
  session.onVoiceEvent((event) => {
    sendToRenderer(DESKTOP_CHANNELS.voiceEvent, event);
    syncTrayFromSession();
  });

  await ensureMainWindow();
  await session.start();

  try {
    mobileServer = new MobileServer({
      dataDir,
      session,
      // Overrides exist so an isolated test instance can run beside the live app (loopback, another port).
      port: Number(process.env.KARKEDIKHA_MOBILE_PORT) || 3030,
      ...(process.env.KARKEDIKHA_MOBILE_HOST ? { host: process.env.KARKEDIKHA_MOBILE_HOST } : {}),
      log: (message) => hostLog(message),
      onClientsChanged: (count) => {
        sendSnapshot();
        sendToRenderer(DESKTOP_CHANNELS.event, {
          kind: 'status',
          at: new Date().toISOString(),
          summary: `mobile_clients:${count}`,
        });
      },
    });
    await mobileServer.start();
    const info = mobileServer.getPairingInfo();
    hostLog(`KarkeDikha Mobile server running at ${info.url} (PIN: ${info.code})`);
  } catch (err) {
    hostLog(`mobile server start failed: ${(err as Error).message}`);
  }

  // Restore wake preference from last session (tray background continuity).
  if (prefs.wakeEnabled) {
    try {
      await session.setWakeWordEnabled(true);
      if (prefs.wakeMuted) session.setWakeWordMuted(true);
    } catch (err) {
      hostLog(`restore wake preference failed: ${(err as Error).message}`);
    }
  }
  applyOpenAtLogin(prefs.openAtLogin);

  void session.refreshHostTelemetry().then(() => sendSnapshot()).catch(() => undefined);
  sendToRenderer(DESKTOP_CHANNELS.event, {
    kind: 'status',
    at: new Date().toISOString(),
    summary: 'Host ready',
  });
  sendToRenderer(DESKTOP_CHANNELS.event, {
    kind: 'status',
    at: new Date().toISOString(),
    summary: JSON.stringify(session.snapshot()),
  });

  const presetFolder = process.env.KARKEDIKHA_DESKTOP_REPO?.trim();
  if (presetFolder) {
    session.setFolder(presetFolder);
  } else {
    session.restoreLastFolder();
  }
  try {
    await session.restoreActiveTask();
  } catch (err) {
    hostLog(`restore failed: ${(err as Error).message}`);
  }
  sendSnapshot();
  syncTrayFromSession();
  showJarvisWindow();
}

function sendSnapshot(): void {
  if (!session) return;
  sendToRenderer(DESKTOP_CHANNELS.event, {
    kind: 'status',
    at: new Date().toISOString(),
    summary: 'snapshot',
    text: JSON.stringify(session.snapshot()),
  });
  syncTrayFromSession();
}

function registerIpc(): void {
  ipcMain.handle(DESKTOP_CHANNELS.getSnapshot, () => session?.snapshot() ?? null);
  ipcMain.handle(DESKTOP_CHANNELS.getAppMetadata, () => appMetadata());
  ipcMain.handle(DESKTOP_CHANNELS.getDiagnosticsReport, () => diagnosticsReport());
  ipcMain.handle(DESKTOP_CHANNELS.pickFolder, async () => {
    if (!window || !session) return null;
    const result = await dialog.showOpenDialog(window, {
      title: 'Select a repository',
      properties: ['openDirectory'],
    });
    if (result.canceled || result.filePaths.length === 0) return session.snapshot();
    return session.setFolder(result.filePaths[0]);
  });
  ipcMain.handle(DESKTOP_CHANNELS.setFolder, async (_event, folder: string) => {
    if (!session) return null;
    const snap = session.setFolder(String(folder ?? ''));
    sendSnapshot();
    return snap;
  });
  ipcMain.handle(DESKTOP_CHANNELS.clearFolder, async () => {
    if (!session) return null;
    const snap = session.clearFolder();
    sendSnapshot();
    return snap;
  });
  ipcMain.handle(DESKTOP_CHANNELS.submitTask, async (_event, goal: string, worker?: string, voiceTurnId?: string, cloudApproved?: boolean) => {
    if (!session) throw new Error('desktop session is not started');
    // Work is running: the composer stays usable. Stop wording acts now; anything else is persisted and queued.
    if (session.isBusy()) {
      const routed = await session.sendWhileRunning(String(goal ?? ''));
      sendSnapshot();
      return routed;
    }
    // The renderer showed the exact two messages; this records the operator's approval of that text.
    if (cloudApproved === true) session.approveCloudPublicText(String(goal ?? ''));
    const result = await session.submitTask(
      String(goal ?? ''),
      worker ? String(worker) : undefined,
      voiceTurnId ? String(voiceTurnId) : undefined,
      'desktop',
    );
    sendSnapshot();
    return result;
  });
  ipcMain.handle(DESKTOP_CHANNELS.selectWorker, async (_event, worker: string) => {
    if (!session) throw new Error('desktop session is not started');
    const snapshot = session.selectWorker(String(worker ?? ''));
    sendSnapshot();
    return snapshot;
  });
  ipcMain.handle(DESKTOP_CHANNELS.selectProvider, async (_event, provider: string) => {
    if (!session) throw new Error('desktop session is not started');
    const normalized = String(provider ?? '').trim();
    if (normalized !== 'ollama' && normalized !== 'openrouter') {
      throw new Error(`unsupported inference provider '${normalized}'`);
    }
    const snapshot = session.selectProvider(normalized);
    sendSnapshot();
    return snapshot;
  });
  ipcMain.handle(DESKTOP_CHANNELS.listModels, async () => {
    if (!session) throw new Error('desktop session is not started');
    const models = await session.refreshInstalledModels();
    sendSnapshot();
    return models;
  });
  ipcMain.handle(DESKTOP_CHANNELS.selectModel, async (_event, model: string) => {
    if (!session) throw new Error('desktop session is not started');
    const snapshot = await session.selectModel(String(model ?? ''));
    sendSnapshot();
    return snapshot;
  });
  ipcMain.handle(DESKTOP_CHANNELS.refreshCloudCatalog, async () => {
    if (!session) throw new Error('desktop session is not started');
    const state = await session.refreshCloudCatalog();
    sendSnapshot();
    return state;
  });
  ipcMain.handle(DESKTOP_CHANNELS.setCloudProviderKey, async (_event, providerId: string, apiKey: string, baseUrl?: string) => {
    if (!session) throw new Error('desktop session is not started');
    const state = await session.saveCloudProviderKey(String(providerId ?? ''), String(apiKey ?? ''), baseUrl ? String(baseUrl) : undefined);
    sendSnapshot();
    return state;
  });
  ipcMain.handle(DESKTOP_CHANNELS.clearCloudProviderKey, async (_event, providerId: string) => {
    if (!session) throw new Error('desktop session is not started');
    const state = await session.clearCloudProviderKey(String(providerId ?? ''));
    sendSnapshot();
    return state;
  });
  ipcMain.handle(DESKTOP_CHANNELS.setCloudProviderEnabled, async (_event, providerId: string, enabled: boolean) => {
    if (!session) throw new Error('desktop session is not started');
    const state = await session.setCloudProviderEnabled(String(providerId ?? ''), Boolean(enabled));
    sendSnapshot();
    return state;
  });
  ipcMain.handle(DESKTOP_CHANNELS.discoverCloudModels, async (_event, providerId: string) => {
    if (!session) throw new Error('desktop session is not started');
    const state = await session.discoverCloudModels(String(providerId ?? ''));
    sendSnapshot();
    return state;
  });
  ipcMain.handle(DESKTOP_CHANNELS.testCloudProvider, async (_event, providerId: string, model: string) => {
    if (!session) throw new Error('desktop session is not started');
    const state = await session.testCloudProvider(String(providerId ?? ''), String(model ?? ''));
    sendSnapshot();
    return state;
  });
  ipcMain.handle(DESKTOP_CHANNELS.selectCloudModel, async (_event, encoded: string | null) => {
    if (!session) throw new Error('desktop session is not started');
    const snapshot = session.selectCloudModel(encoded === null ? null : String(encoded));
    sendSnapshot();
    return snapshot;
  });
  ipcMain.handle(DESKTOP_CHANNELS.setCloudLocalFallback, (_event, enabled: boolean) => {
    if (!session) throw new Error('desktop session is not started');
    const snapshot = session.setCloudLocalFallback(Boolean(enabled));
    sendSnapshot();
    return snapshot;
  });
  ipcMain.handle(DESKTOP_CHANNELS.previewCloudPublicText, (_event, text: string) => {
    if (!session) throw new Error('desktop session is not started');
    return session.previewCloudPublicText(String(text ?? ''));
  });
  ipcMain.handle(DESKTOP_CHANNELS.continueTask, async (_event, predecessorAttemptId: string, guidance: string) => {
    if (!session) throw new Error('desktop session is not started');
    const result = await session.continueFailedTask(String(predecessorAttemptId ?? ''), String(guidance ?? ''));
    sendSnapshot();
    return result;
  });
  ipcMain.handle(DESKTOP_CHANNELS.cancel, async () => {
    if (!session) throw new Error('desktop session is not started');
    await session.cancel();
    sendSnapshot();
  });
  ipcMain.handle(DESKTOP_CHANNELS.resolveApproval, async (_event, approvalId: string, resolution: 'approved' | 'rejected') => {
    if (!session) throw new Error('desktop session is not started');
    await session.resolvePending(String(approvalId ?? ''), resolution === 'rejected' ? 'rejected' : 'approved');
    sendSnapshot();
  });
  ipcMain.handle(DESKTOP_CHANNELS.setOpenRouterApiKey, (_event, apiKey: string) => {
    if (!session) throw new Error('desktop session is not started');
    const result = session.setOpenRouterApiKey(String(apiKey ?? ''));
    sendSnapshot();
    return result;
  });
  ipcMain.handle(DESKTOP_CHANNELS.clearOpenRouterApiKey, () => {
    if (!session) throw new Error('desktop session is not started');
    const result = session.clearOpenRouterApiKey();
    sendSnapshot();
    return result;
  });
  ipcMain.handle(DESKTOP_CHANNELS.connectGmail, async () => {
    if (!session) throw new Error('desktop session is not started');
    const result = await session.connectGmail();
    sendSnapshot();
    return result;
  });
  ipcMain.handle(DESKTOP_CHANNELS.disconnectGmail, async () => {
    if (!session) throw new Error('desktop session is not started');
    const result = await session.disconnectGmail();
    sendSnapshot();
    return result;
  });
  ipcMain.handle(DESKTOP_CHANNELS.dispatchGmailAction, async (_event, toolName: string, args: Record<string, unknown>) => {
    if (!session) throw new Error('desktop session is not started');
    const result = await session.dispatchGmailAction(String(toolName ?? ''), (args ?? {}) as Record<string, unknown>);
    sendSnapshot();
    return result;
  });
  ipcMain.handle(DESKTOP_CHANNELS.resolveGmailApproval, async (_event, approvalId: string, resolution: 'approved' | 'rejected') => {
    if (!session) throw new Error('desktop session is not started');
    const result = await session.resolveGmailApproval(String(approvalId ?? ''), resolution === 'rejected' ? 'rejected' : 'approved');
    sendSnapshot();
    return result;
  });
  ipcMain.handle(DESKTOP_CHANNELS.summarizeGmailThread, async (_event, messages: Array<{ from: string; subject: string; date: string; bodyText: string }>) => {
    if (!session) throw new Error('desktop session is not started');
    return session.summarizeGmailThread(Array.isArray(messages) ? messages : []);
  });
  ipcMain.handle(DESKTOP_CHANNELS.retryGmailProbe, async () => {
    if (!session) throw new Error('desktop session is not started');
    const result = await session.retryGmailProbe();
    sendSnapshot();
    return result;
  });
  ipcMain.handle(DESKTOP_CHANNELS.allowInboxOrganization, async () => {
    if (!session) throw new Error('desktop session is not started');
    const result = await session.allowInboxOrganization();
    sendSnapshot();
    return result;
  });
  ipcMain.handle(DESKTOP_CHANNELS.saveGoogleOAuthClient, async (_event, clientId: string, clientSecret: string) => {
    if (!session) throw new Error('desktop session is not started');
    const result = session.saveGoogleOAuthClient(String(clientId ?? ''), String(clientSecret ?? ''));
    sendSnapshot();
    return result;
  });
  ipcMain.handle(DESKTOP_CHANNELS.importGoogleOAuthClientFile, async (event) => {
    if (!session) throw new Error('desktop session is not started');
    const owner = BrowserWindow.fromWebContents(event.sender) ?? undefined;
    const options: Electron.OpenDialogOptions = {
      title: 'Choose the OAuth client JSON you downloaded from Google Cloud',
      properties: ['openFile'],
      filters: [{ name: 'Google OAuth client (JSON)', extensions: ['json'] }],
    };
    const picked = owner ? await dialog.showOpenDialog(owner, options) : await dialog.showOpenDialog(options);
    if (picked.canceled || picked.filePaths.length === 0) return { cancelled: true };
    const stat = fs.statSync(picked.filePaths[0]);
    if (!stat.isFile() || stat.size > 64 * 1024) throw new Error('That file is too large to be a Google OAuth client file.');
    const status = session.importGoogleOAuthClientJson(fs.readFileSync(picked.filePaths[0], 'utf8'));
    sendSnapshot();
    return { cancelled: false, status };
  });
  ipcMain.handle(DESKTOP_CHANNELS.pickAttachments, async (event) => {
    if (!session) throw new Error('desktop session is not started');
    const owner = BrowserWindow.fromWebContents(event.sender) ?? undefined;
    const options: Electron.OpenDialogOptions = {
      title: 'Attach files',
      properties: ['openFile', 'multiSelections'],
      filters: [
        { name: 'Images, documents, audio and text', extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'pdf', 'docx', 'wav', 'mp3', 'ogg', 'flac', 'txt', 'md', 'json', 'csv', 'log', 'js', 'ts', 'tsx', 'py', 'html', 'css', 'yml', 'yaml', 'xml', 'sql'] },
        { name: 'All files', extensions: ['*'] },
      ],
    };
    const picked = owner ? await dialog.showOpenDialog(owner, options) : await dialog.showOpenDialog(options);
    if (picked.canceled || picked.filePaths.length === 0) return { cancelled: true, errors: [] };
    const errors: string[] = [];
    for (const filePath of picked.filePaths) {
      try {
        session.stageAttachmentFile(filePath);
      } catch (err) {
        errors.push(err instanceof Error ? err.message : String(err));
      }
    }
    sendSnapshot();
    return { cancelled: false, errors };
  });
  ipcMain.handle(DESKTOP_CHANNELS.stageAttachmentBytes, async (_event, name: string, bytes: Uint8Array) => {
    if (!session) throw new Error('desktop session is not started');
    try {
      session.stageAttachmentBytes(String(name ?? 'attachment'), bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes as ArrayLike<number>));
      sendSnapshot();
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  });
  ipcMain.handle(DESKTOP_CHANNELS.removeAttachment, async (_event, id: string) => {
    if (!session) throw new Error('desktop session is not started');
    session.removeStagedAttachment(String(id ?? ''));
    sendSnapshot();
  });
  ipcMain.handle(DESKTOP_CHANNELS.cancelGoogleConnect, async () => {
    if (!session) throw new Error('desktop session is not started');
    return session.cancelGoogleConnect();
  });
  ipcMain.handle(DESKTOP_CHANNELS.clearGoogleOAuthClient, async () => {
    if (!session) throw new Error('desktop session is not started');
    const result = await session.clearGoogleOAuthClient();
    sendSnapshot();
    return result;
  });
  ipcMain.handle(DESKTOP_CHANNELS.transcribeUtterance, async (_event, wavBase64: string, voiceTurnId?: string) => {
    if (!session) throw new Error('desktop session is not started');
    return session.transcribeUtteranceWavBase64(String(wavBase64 ?? ''), voiceTurnId ? String(voiceTurnId) : undefined);
  });
  ipcMain.handle(DESKTOP_CHANNELS.getHostTelemetry, async () => {
    if (!session) throw new Error('desktop session is not started');
    const telemetry = await session.refreshHostTelemetry();
    sendSnapshot();
    return telemetry;
  });
  ipcMain.handle(DESKTOP_CHANNELS.setWakeWordEnabled, async (_event, enabled: boolean) => {
    if (!session) throw new Error('desktop session is not started');
    const snapshot = await session.setWakeWordEnabled(Boolean(enabled));
    prefs = writeHostPreferences(dataDir, { wakeEnabled: Boolean(enabled) });
    sendSnapshot();
    return snapshot;
  });
  ipcMain.handle(DESKTOP_CHANNELS.setWakeWordMuted, (_event, muted: boolean) => {
    if (!session) throw new Error('desktop session is not started');
    const snapshot = session.setWakeWordMuted(Boolean(muted));
    prefs = writeHostPreferences(dataDir, { wakeMuted: Boolean(muted) });
    sendSnapshot();
    return snapshot;
  });
  ipcMain.handle(DESKTOP_CHANNELS.reportWakeCapture, (_event, meta: Record<string, unknown>) => {
    if (!session) throw new Error('desktop session is not started');
    const snapshot = session.reportWakeCapture(meta ?? {});
    sendSnapshot();
    return snapshot;
  });
  ipcMain.handle(DESKTOP_CHANNELS.pushWakeAudio, async (_event, pcmBase64: string, meta?: Record<string, unknown>) => {
    if (!session) throw new Error('desktop session is not started');
    return session.pushWakeAudioBase64(String(pcmBase64 ?? ''), meta);
  });
  ipcMain.handle(DESKTOP_CHANNELS.setVoiceMode, (_event, enabled: boolean) => {
    if (!session) throw new Error('desktop session is not started');
    const snapshot = session.setVoiceMode(Boolean(enabled));
    sendSnapshot();
    return snapshot;
  });
  ipcMain.handle(DESKTOP_CHANNELS.speakText, async (_event, text: string) => {
    if (!session) throw new Error('desktop session is not started');
    const result = await session.speakText(String(text ?? ''));
    sendSnapshot();
    return result;
  });
  ipcMain.handle(DESKTOP_CHANNELS.stopSpeaking, () => {
    if (!session) throw new Error('desktop session is not started');
    const snapshot = session.stopSpeaking('button');
    sendSnapshot();
    return snapshot;
  });
  ipcMain.handle(DESKTOP_CHANNELS.markPlaybackFinished, () => {
    if (!session) throw new Error('desktop session is not started');
    const snapshot = session.markPlaybackFinished();
    sendSnapshot();
    return snapshot;
  });
  ipcMain.handle(DESKTOP_CHANNELS.refreshEverydayTools, async () => {
    if (!session) throw new Error('desktop session is not started');
    await session.refreshEverydayTools();
    const snapshot = session.snapshot();
    sendSnapshot();
    return snapshot;
  });
  ipcMain.handle(DESKTOP_CHANNELS.createNote, async (_event, input: { title?: string; body: string }) => {
    if (!session) throw new Error('desktop session is not started');
    const snapshot = await session.createNote(input ?? { body: '' });
    sendSnapshot();
    return snapshot;
  });
  ipcMain.handle(DESKTOP_CHANNELS.updateNote, async (_event, id: string, input: { title?: string; body?: string }) => {
    if (!session) throw new Error('desktop session is not started');
    const snapshot = await session.updateNote(String(id ?? ''), input ?? {});
    sendSnapshot();
    return snapshot;
  });
  ipcMain.handle(DESKTOP_CHANNELS.deleteNote, async (_event, id: string) => {
    if (!session) throw new Error('desktop session is not started');
    const snapshot = await session.deleteNote(String(id ?? ''));
    sendSnapshot();
    return snapshot;
  });
  ipcMain.handle(DESKTOP_CHANNELS.createReminder, async (_event, input: { title: string; body?: string; dueAt: string; timezone?: string }) => {
    if (!session) throw new Error('desktop session is not started');
    const snapshot = await session.createReminder(input);
    sendSnapshot();
    return snapshot;
  });
  ipcMain.handle(DESKTOP_CHANNELS.completeReminder, async (_event, id: string) => {
    if (!session) throw new Error('desktop session is not started');
    const snapshot = await session.completeReminder(String(id ?? ''));
    sendSnapshot();
    return snapshot;
  });
  ipcMain.handle(DESKTOP_CHANNELS.cancelReminder, async (_event, id: string) => {
    if (!session) throw new Error('desktop session is not started');
    const snapshot = await session.cancelReminder(String(id ?? ''));
    sendSnapshot();
    return snapshot;
  });
  ipcMain.handle(DESKTOP_CHANNELS.listConversations, async (_event, includeArchived?: boolean) => {
    if (!session) throw new Error('desktop session is not started');
    return session.listConversations(Boolean(includeArchived));
  });
  ipcMain.handle(DESKTOP_CHANNELS.openConversation, async (_event, conversationId: string, select?: boolean) => {
    if (!session) throw new Error('desktop session is not started');
    const result = await session.openConversation(String(conversationId ?? ''), select !== false);
    sendSnapshot();
    return result;
  });
  ipcMain.handle(DESKTOP_CHANNELS.newConversation, async () => {
    if (!session) throw new Error('desktop session is not started');
    await session.newConversation();
    sendSnapshot();
  });
  ipcMain.handle(DESKTOP_CHANNELS.renameConversation, async (_event, conversationId: string, title: string) => {
    if (!session) throw new Error('desktop session is not started');
    return session.renameConversation(String(conversationId ?? ''), String(title ?? ''));
  });
  ipcMain.handle(DESKTOP_CHANNELS.pinConversation, async (_event, conversationId: string) => {
    if (!session) throw new Error('desktop session is not started');
    return session.pinConversation(String(conversationId ?? ''));
  });
  ipcMain.handle(DESKTOP_CHANNELS.unpinConversation, async (_event, conversationId: string) => {
    if (!session) throw new Error('desktop session is not started');
    return session.unpinConversation(String(conversationId ?? ''));
  });
  ipcMain.handle(DESKTOP_CHANNELS.archiveConversation, async (_event, conversationId: string) => {
    if (!session) throw new Error('desktop session is not started');
    return session.archiveConversation(String(conversationId ?? ''));
  });
  ipcMain.handle(DESKTOP_CHANNELS.unarchiveConversation, async (_event, conversationId: string) => {
    if (!session) throw new Error('desktop session is not started');
    return session.unarchiveConversation(String(conversationId ?? ''));
  });
  ipcMain.handle(DESKTOP_CHANNELS.searchConversations, async (_event, query: string) => {
    if (!session) throw new Error('desktop session is not started');
    return session.searchConversations(String(query ?? ''));
  });
  ipcMain.handle(DESKTOP_CHANNELS.exportConversation, async (_event, conversationId: string) => {
    if (!session) throw new Error('desktop session is not started');
    if (!window) throw new Error('desktop window is not available');
    const exported = await session.exportConversationMarkdown(String(conversationId ?? ''));
    const safeTitle = exported.title.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '-').slice(0, 80) || 'Jarvis conversation';
    const choice = await dialog.showSaveDialog(window, {
      title: 'Export Jarvis conversation',
      defaultPath: `${safeTitle}.md`,
      filters: [{ name: 'Markdown', extensions: ['md'] }],
    });
    if (choice.canceled || !choice.filePath) return { saved: false, path: null };
    fs.writeFileSync(choice.filePath, exported.content, 'utf8');
    return { saved: true, path: choice.filePath };
  });
  ipcMain.handle(DESKTOP_CHANNELS.startWebResearch, async (_event, query: string) => {
    if (!session) throw new Error('desktop session is not started');
    return session.startWebResearch(String(query ?? ''));
  });
  ipcMain.handle(DESKTOP_CHANNELS.resolveWebResearch, async (_event, approval: import('./ipc').DesktopResearchApprovalView, resolution: 'approved' | 'rejected') => {
    if (!session) throw new Error('desktop session is not started');
    return session.resolveWebResearch(approval, resolution === 'rejected' ? 'rejected' : 'approved');
  });
  ipcMain.handle(DESKTOP_CHANNELS.getWebResearch, async (_event, researchId: string) => {
    if (!session) throw new Error('desktop session is not started');
    return session.getWebResearch(String(researchId ?? ''));
  });
  ipcMain.handle(DESKTOP_CHANNELS.openExternalUrl, async (_event, value: string) => {
    const url = normalizeSafeBrowserUrl(String(value ?? ''));
    await shell.openExternal(url);
    return { opened: true };
  });
  ipcMain.handle(DESKTOP_CHANNELS.copyToClipboard, async (_event, text: string) => {
    clipboard.writeText(String(text ?? ''));
    return { copied: true };
  });
  ipcMain.handle(DESKTOP_CHANNELS.openWorkspaceFolder, async () => {
    if (!session) throw new Error('desktop session is not started');
    const folder = session.snapshot().folder;
    if (!folder) throw new Error('Select a workspace first');
    const result = await shell.openPath(folder);
    if (result) throw new Error(result);
    return { opened: true };
  });
  ipcMain.handle(DESKTOP_CHANNELS.openWorkspaceFile, async (_event, relativePath: string) => {
    if (!session) throw new Error('desktop session is not started');
    const folder = session.snapshot().folder;
    if (!folder) throw new Error('Select a workspace first');
    const resolved = path.resolve(folder, String(relativePath ?? ''));
    const normalizedFolder = path.resolve(folder);
    if (!resolved.startsWith(normalizedFolder) || !fs.existsSync(resolved)) {
      throw new Error('File not found in workspace');
    }
    const result = await shell.openPath(resolved);
    if (result) throw new Error(result);
    return { opened: true };
  });
  ipcMain.handle(DESKTOP_CHANNELS.listArtifacts, async (_event, conversationId?: string) => {
    if (!session) throw new Error('desktop session is not started');
    return session.listArtifacts(conversationId ? String(conversationId) : undefined);
  });
  ipcMain.handle(DESKTOP_CHANNELS.getTaskOverview, async () => {
    if (!session) throw new Error('desktop session is not started');
    return session.getTaskOverview();
  });
  ipcMain.handle(DESKTOP_CHANNELS.cancelTask, async (_event, attemptId: string) => {
    if (!session) throw new Error('desktop session is not started');
    const result = await session.cancelTask(String(attemptId ?? ''));
    sendSnapshot();
    return result;
  });
  ipcMain.handle(DESKTOP_CHANNELS.getAssistantBrief, async (_event, options?: { external?: boolean }) => {
    if (!session) throw new Error('desktop session is not started');
    return session.getAssistantBrief({ external: options?.external === true });
  });
  ipcMain.handle(DESKTOP_CHANNELS.getDailyBriefRoutine, async () => {
    if (!session) throw new Error('desktop session is not started');
    return session.getDailyBriefRoutine();
  });
  ipcMain.handle(DESKTOP_CHANNELS.configureDailyBriefRoutine, async (_event, input: { dailyTime: string; timezone?: string; enabled?: boolean }) => {
    if (!session) throw new Error('desktop session is not started');
    return session.configureDailyBriefRoutine({
      dailyTime: String(input?.dailyTime ?? ''),
      timezone: typeof input?.timezone === 'string' ? input.timezone : undefined,
      enabled: input?.enabled === false ? false : true,
    });
  });
  ipcMain.handle(DESKTOP_CHANNELS.resolveAssistantApproval, async (_event, approvalId: string, resolution: 'approved' | 'rejected') => {
    if (!session) throw new Error('desktop session is not started');
    const result = await session.resolveAssistantApproval(String(approvalId ?? ''), resolution === 'rejected' ? 'rejected' : 'approved');
    sendSnapshot();
    return result;
  });
  ipcMain.handle(DESKTOP_CHANNELS.resumeTask, async (_event, attemptId: string) => {
    if (!session) throw new Error('desktop session is not started');
    const result = await session.resumeTask(String(attemptId ?? ''));
    sendSnapshot();
    return result;
  });
  ipcMain.handle(DESKTOP_CHANNELS.retryCoreConnection, async () => {
    if (!session) throw new Error('desktop session is not started');
    const snapshot = await session.retryCoreConnection();
    sendSnapshot();
    return snapshot;
  });
  ipcMain.handle(DESKTOP_CHANNELS.getDevStories, async () => {
    if (!session) throw new Error('desktop session is not started');
    return session.getDevStories();
  });
  ipcMain.handle(DESKTOP_CHANNELS.decideDevStoryPermission, async (_event, storyId: string, pendingId: string, allow: boolean) => {
    if (!session) throw new Error('desktop session is not started');
    return session.decideDevStoryPermission(String(storyId ?? ''), String(pendingId ?? ''), allow === true);
  });
  ipcMain.handle(DESKTOP_CHANNELS.stopAllDevStories, async () => {
    if (!session) throw new Error('desktop session is not started');
    return session.stopAllDevStories();
  });
  ipcMain.handle(DESKTOP_CHANNELS.retryDevStory, async (_event, storyId: string) => {
    if (!session) throw new Error('desktop session is not started');
    return session.retryDevStory(String(storyId ?? ''));
  });
  ipcMain.handle(DESKTOP_CHANNELS.verifyExistingDevStory, async (_event, storyId: string) => {
    if (!session) throw new Error('desktop session is not started');
    return session.verifyExistingDevStory(String(storyId ?? ''));
  });
  ipcMain.handle(DESKTOP_CHANNELS.approveDevStoryReview, async (_event, storyId: string) => {
    if (!session) throw new Error('desktop session is not started');
    return session.approveDevStoryReview(String(storyId ?? ''));
  });
  ipcMain.handle(DESKTOP_CHANNELS.confirmDeviceVerification, async (_event, storyId: string, ok: boolean, note?: string) => {
    if (!session) throw new Error('desktop session is not started');
    return session.confirmDeviceVerification(String(storyId ?? ''), ok === true, typeof note === 'string' ? note : undefined);
  });
  ipcMain.handle(DESKTOP_CHANNELS.loadArtifactPreview, async (_event, artifactId: string) => {
    if (!session) throw new Error('desktop session is not started');
    return session.loadArtifactPreview(String(artifactId ?? ''));
  });
  ipcMain.handle(DESKTOP_CHANNELS.openArtifactFolder, async (_event, artifactId: string) => {
    if (!session) throw new Error('desktop session is not started');
    shell.showItemInFolder(await session.artifactPath(String(artifactId ?? '')));
    return { opened: true };
  });
  ipcMain.handle(DESKTOP_CHANNELS.openArtifactFile, async (_event, artifactId: string) => {
    if (!session) throw new Error('desktop session is not started');
    await shell.openPath(await session.artifactPath(String(artifactId ?? '')));
    return { opened: true };
  });
  ipcMain.handle(DESKTOP_CHANNELS.saveArtifactCopy, async (_event, artifactId: string) => {
    if (!session || !window) throw new Error('desktop session is not started');
    const source = await session.artifactPath(String(artifactId ?? ''));
    const choice = await dialog.showSaveDialog(window, { title: 'Save artifact copy', defaultPath: path.basename(source) });
    if (choice.canceled || !choice.filePath) return { saved: false, path: null };
    await session.saveArtifactCopy(String(artifactId ?? ''), choice.filePath);
    return { saved: true, path: choice.filePath };
  });
  ipcMain.handle(DESKTOP_CHANNELS.openArtifactInStudio, async (_event, artifactId: string) => {
    if (!session) throw new Error('desktop session is not started');
    await shell.openExternal(await session.imageStudioAppUrlForPrompt(String(artifactId ?? '')));
    return { opened: true };
  });
  ipcMain.handle(DESKTOP_CHANNELS.useArtifactAsReference, async (_event, artifactId: string) => {
    if (!session) throw new Error('desktop session is not started');
    await shell.openExternal(await session.imageStudioAppUrlForReference(String(artifactId ?? '')));
    return { opened: true };
  });
  ipcMain.handle(DESKTOP_CHANNELS.probeImageStudio, async () => {
    if (!session) throw new Error('desktop session is not started');
    return session.probeImageStudio();
  });
  ipcMain.handle(DESKTOP_CHANNELS.generateImage, async (_event, input: Record<string, unknown>) => {
    if (!session) throw new Error('desktop session is not started');
    return session.generateImage(input ?? {});
  });
  ipcMain.handle(DESKTOP_CHANNELS.resolveImageApproval, async (_event, approvalId: string, resolution: 'approved' | 'rejected') => {
    if (!session) throw new Error('desktop session is not started');
    return session.resolveImageApproval(String(approvalId ?? ''), resolution === 'rejected' ? 'rejected' : 'approved');
  });
  ipcMain.handle(DESKTOP_CHANNELS.cancelImageGeneration, async () => {
    if (!session) throw new Error('desktop session is not started');
    await session.cancelImageGeneration();
  });
  ipcMain.handle(DESKTOP_CHANNELS.resolveWeatherApproval, async (_event, approvalId: string, resolution: 'approved' | 'rejected') => {
    if (!session) throw new Error('desktop session is not started');
    return session.resolveWeatherApproval(String(approvalId ?? ''), resolution === 'rejected' ? 'rejected' : 'approved');
  });
  ipcMain.handle(DESKTOP_CHANNELS.cancelWeatherLookup, async () => {
    if (!session) throw new Error('desktop session is not started');
    await session.cancelWeatherLookup();
  });
  ipcMain.handle(DESKTOP_CHANNELS.refreshCommandQueue, async () => {
    if (!session) throw new Error('desktop session is not started');
    await session.refreshCommandQueue();
    const snapshot = session.snapshot();
    sendSnapshot();
    return snapshot;
  });
  ipcMain.handle(DESKTOP_CHANNELS.enqueueCommand, async (_event, instruction: string) => {
    if (!session) throw new Error('desktop session is not started');
    const snapshot = await session.enqueueUserCommand(String(instruction ?? ''), 'ui');
    sendSnapshot();
    return snapshot;
  });
  ipcMain.handle(DESKTOP_CHANNELS.offerNextCommand, async () => {
    if (!session) throw new Error('desktop session is not started');
    const snapshot = await session.offerNextQueuedCommand();
    sendSnapshot();
    return snapshot;
  });
  ipcMain.handle(DESKTOP_CHANNELS.confirmCommandRun, async (_event, id: string, token: string, revision: number) => {
    if (!session) throw new Error('desktop session is not started');
    const snapshot = await session.confirmQueuedCommandRun(
      String(id ?? ''),
      String(token ?? ''),
      Number(revision),
    );
    sendSnapshot();
    return snapshot;
  });
  ipcMain.handle(DESKTOP_CHANNELS.skipCommand, async (_event, id: string) => {
    if (!session) throw new Error('desktop session is not started');
    const snapshot = await session.skipQueuedCommand(String(id ?? ''));
    sendSnapshot();
    return snapshot;
  });
  ipcMain.handle(DESKTOP_CHANNELS.postponeCommand, async (_event, id: string, untilIso: string) => {
    if (!session) throw new Error('desktop session is not started');
    const snapshot = await session.postponeQueuedCommand(String(id ?? ''), String(untilIso ?? ''));
    sendSnapshot();
    return snapshot;
  });
  ipcMain.handle(DESKTOP_CHANNELS.editQueuedCommand, async (_event, id: string, instruction: string) => {
    if (!session) throw new Error('desktop session is not started');
    const snapshot = await session.editQueuedCommand(String(id ?? ''), String(instruction ?? ''));
    sendSnapshot();
    return snapshot;
  });
  ipcMain.handle(DESKTOP_CHANNELS.removeQueuedCommand, async (_event, id: string) => {
    if (!session) throw new Error('desktop session is not started');
    const snapshot = await session.removeQueuedCommand(String(id ?? ''));
    sendSnapshot();
    return snapshot;
  });
  ipcMain.handle(DESKTOP_CHANNELS.reorderQueuedCommand, async (_event, id: string, ordinal: number) => {
    if (!session) throw new Error('desktop session is not started');
    const snapshot = await session.reorderQueuedCommand(String(id ?? ''), Number(ordinal));
    sendSnapshot();
    return snapshot;
  });
  ipcMain.handle(DESKTOP_CHANNELS.getMobilePairing, () => {
    const info = mobileServer?.getPairingInfo();
    return info ?? {
      code: '----',
      token: '',
      port: 3030,
      ip: '127.0.0.1',
      url: 'http://127.0.0.1:3030/',
      pairedCount: 0,
      connectedClients: 0,
    };
  });
  ipcMain.handle(DESKTOP_CHANNELS.minimizeWindow, () => {
    if (window && !window.isDestroyed()) window.minimize();
  });
  ipcMain.handle(DESKTOP_CHANNELS.maximizeWindow, () => {
    if (!window || window.isDestroyed()) return;
    if (window.isMaximized()) window.unmaximize();
    else window.maximize();
  });
  ipcMain.handle(DESKTOP_CHANNELS.closeWindow, () => {
    if (!tray || !tray.isAvailable()) {
      hostLog('Tray mode unavailable — closeWindow IPC terminates the app');
      void shutdownAndQuit();
    } else {
      hideJarvisToTray();
    }
  });
  ipcMain.handle(DESKTOP_CHANNELS.popoutWorkbench, async () => {
    if (popoutWindow && !popoutWindow.isDestroyed()) {
      popoutWindow.show();
      popoutWindow.focus();
      return { poppedOut: true };
    }
    popoutWindow = new BrowserWindow({
      width: 880,
      height: 740,
      minWidth: 540,
      minHeight: 460,
      title: 'Panda Contextual Workbench',
      backgroundColor: '#050a14',
      icon: createAppIcon(),
      show: true,
      webPreferences: {
        preload: path.join(__dirname, 'preload.js'),
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: !packageSmokeMode,
        spellcheck: false,
      },
    });
    popoutWindow.on('closed', () => {
      popoutWindow = undefined;
      sendToRenderer(DESKTOP_CHANNELS.event, {
        kind: 'status',
        at: new Date().toISOString(),
        summary: 'popout_closed',
      });
    });
    await popoutWindow.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'), {
      query: { mode: 'popout-workbench' },
    });
    return { poppedOut: true };
  });
  ipcMain.handle(DESKTOP_CHANNELS.closePopoutWorkbench, () => {
    if (popoutWindow && !popoutWindow.isDestroyed()) {
      popoutWindow.close();
      popoutWindow = undefined;
    }
    return { poppedOut: false };
  });
  ipcMain.handle(DESKTOP_CHANNELS.quitApp, () => {
    void shutdownAndQuit();
  });
}

if (gotSingleInstanceLock) {
  app.on('second-instance', (_event, commandLine) => {
    const isShutdown = Array.isArray(commandLine) && commandLine.some(
      (arg) => arg === '--shutdown' || arg === '--shutdown-for-upgrade' || arg === '--quit',
    );
    if (isShutdown) {
      hostLog('graceful shutdown requested via second-instance for upgrade');
      void shutdownAndQuit();
      return;
    }
    hostLog('second instance attempted; focusing existing Pandesh window');
    showJarvisWindow();
  });

  app.whenReady().then(async () => {
    hostLog('Electron ready');
    registerIpc();
    // The build identity is written into every host log line's context: a
    // crash report can be tied to the exact build without asking the user.
    const identity = currentBuildIdentity();
    hostLog(
      `build identity: v${identity.version} · ${identity.buildKind === 'release' ? `b${identity.buildNumber}` : 'dev'} `
      + `(${identity.releaseChannel}) commit=${identity.commit ?? 'unknown'} built=${identity.builtAt ?? 'unknown'} `
      + `installer=${identity.installerVersion ?? 'unknown'} electron=${process.versions.electron ?? 'n/a'}`,
    );
    await createWindow();
    powerMonitor.on('resume', () => {
      hostLog('host resume — reconciling reminders');
      void session?.reconcileRemindersAfterResume('resume').then(() => sendSnapshot()).catch((err) => {
        hostLog(`resume reconcile failed: ${(err as Error).message}`);
      });
    });
    hostLog('window created');
  }).catch((err) => {
    hostLog(`failed to start: ${(err as Error).stack ?? err}`);
    app.exit(1);
  });

  app.on('before-quit', (event) => {
    if (!isShuttingDown) {
      event.preventDefault();
      void shutdownAndQuit();
    }
  });

  app.on('window-all-closed', () => {
    if (isQuitting || isShuttingDown) {
      void shutdownAndQuit();
      return;
    }
    if (!tray || !tray.isAvailable()) {
      hostLog('window-all-closed: tray unavailable — quitting KarkeDikha');
      void shutdownAndQuit();
    } else {
      hostLog('window-all-closed ignored — KarkeDikha stays in tray until Quit');
    }
  });

  process.on('SIGINT', () => {
    void shutdownAndQuit();
  });
  process.on('SIGTERM', () => {
    void shutdownAndQuit();
  });

  process.on('uncaughtException', (err) => {
    hostLog(`uncaughtException: ${err.stack ?? err.message}`);
  });
  process.on('unhandledRejection', (err) => {
    hostLog(`unhandledRejection: ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
  });
}
