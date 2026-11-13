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
  protocol,
  screen,
  shell,
} from 'electron';
import { DesktopSession } from './host/desktopSession';
import { DESIGN_PREVIEW_SCHEME, DesignPreviewStore, isDesignPreviewUrl } from './host/designPreview';
import { checkDesignHtml } from '../../../core/shared/workshop/design';
import {
  formatDiagnosticsReport,
  resolveBuildIdentity,
  type DesktopBuildIdentity,
} from './host/desktopBuildIdentity';
import { googleConnectRefusal, isTestProfile, ownsLoginItem, realDesktopDataDirFromOs, readHostPreferences, resolveUiVariant, TEST_PROFILE_GOOGLE_ENV, windowTitleForProfile, writeHostPreferences } from './host/desktopHostPreferences';
import { DESKTOP_CHANNELS, type DesktopAppMetadata, type DesktopUpdateStartResult, type DesktopUpdateStatus, type MobilePairingView } from './ipc';
import {
  acknowledgeUpdateResult, inspectPackage, launchUpdater, quiesceCore, readCoreReadiness, readUpdateResult,
  setUpdateGate, updaterAvailable, writeUiHealth,
} from './host/desktopUpdate';
import { JarvisTrayController } from './host/jarvisTray';
import { createAppIcon } from './host/appIcon';
import { normalizeSafeExternalUrl, normalizeSafeBrowserUrl } from './host/desktopSafeOpen';
import { MobileServer, defaultMobileHost, parseMobileAccess } from './host/mobileServer';

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

// The Design workshop's preview scheme (host/designPreview.ts): registered before the app is ready, as Electron
// requires. Not bypassCSP, no fetch, no service workers: a preview page gets nothing a web page would not.
protocol.registerSchemesAsPrivileged([{ scheme: DESIGN_PREVIEW_SCHEME, privileges: { standard: true, secure: true } }]);
const designPreviews = new DesignPreviewStore();

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
  let mobileStatus = parseMobileAccess(prefs.mobileAccess) === 'off' ? 'Off' : 'Stopped';
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
    uiVariant: resolveUiVariant(prefs),
    uiVariantForced: Boolean(process.env.PANDESH_UI_V2?.trim()),
  });
}

/**
 * Starts (or restarts) Pandesh Mobile as the owner set it: off, on the home network, or for the local Tailscale proxy
 * only. Test and scratch profiles always stay on loopback (defaultMobileHost). The server object exists even while
 * access is off, so the PC can still list and forget paired phones.
 */
async function startMobileServer(): Promise<void> {
  if (!session) return;
  const access = parseMobileAccess(prefs.mobileAccess);
  if (mobileServer) {
    mobileServer.stop();
    mobileServer = undefined;
  }
  mobileServer = new MobileServer({
    dataDir,
    session,
    access,
    // Overrides exist so an isolated test instance can run beside the live app (loopback, another port).
    port: Number(process.env.KARKEDIKHA_MOBILE_PORT) || 3030,
    // Test and scratch instances stay on loopback (no firewall prompt per build, not reachable from the LAN).
    host: defaultMobileHost(process.env, dataDir, defaultDesktopDataDir(), access),
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
  if (access === 'off') {
    hostLog('Pandesh Mobile is off (owner setting)');
    syncTrayFromSession();
    return;
  }
  try {
    await mobileServer.start();
    const info = mobileServer.getPairingInfo();
    hostLog(MobileServer.logLine(info));
  } catch (err) {
    hostLog(`mobile server start failed: ${(err as Error).message}`);
  }
  syncTrayFromSession();
}

/** What Connections → Phone (v2) and Integrations (Classic) show. Never a session token. */
async function mobilePairingView(): Promise<MobilePairingView> {
  const access = parseMobileAccess(prefs.mobileAccess);
  const port = Number(process.env.KARKEDIKHA_MOBILE_PORT) || 3030;
  if (mobileServer && access !== 'off') return { ...(await mobileServer.getPairingView()), access };
  const devices = mobileServer ? mobileServer.pairedDevices() : [];
  return {
    code: '',
    codeExpiresAt: null,
    port,
    ip: '127.0.0.1',
    url: '',
    secureUrl: null,
    secure: { state: 'unchecked', url: null, detail: access === 'off' ? 'Phone access is off.' : 'Pandesh Mobile has not started.' },
    localUrl: '',
    access,
    pairedCount: devices.length,
    connectedClients: 0,
    listening: false,
    devices,
    pairingPausedUntil: null,
  };
}

function applyOpenAtLogin(enabled: boolean): void {
  prefs = writeHostPreferences(dataDir, { openAtLogin: enabled });
  // A test or scratch profile keeps its own preference but never writes or deletes the shared Windows entry.
  if (!ownsLoginItem(dataDir, realDesktopDataDirFromOs())) {
    hostLog(`login item left alone: profile ${dataDir} is not the real desktop profile (preference saved: ${enabled ? 'on' : 'off'})`);
    syncTrayFromSession();
    return;
  }
  try {
    app.setLoginItemSettings({
      openAtLogin: enabled,
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

/**
 * Shows one outbox notification and waits for the operating system's own answer: 'show' means Windows accepted the
 * toast, 'failed' carries its error. Silence for 8 s is reported as a failure, never as success.
 */
function deliverOutboxNotification(input: { id: string; title: string; body: string }): Promise<{ ok: boolean; via: string; error?: string }> {
  const via = 'windows_toast';
  if (!Notification.isSupported()) return Promise.resolve({ ok: false, via, error: 'desktop notifications are not supported on this system' });
  return new Promise((resolve) => {
    let settled = false;
    const done = (result: { ok: boolean; via: string; error?: string }) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const notification = new Notification({ title: input.title, body: input.body, silent: false });
    const timer = setTimeout(() => done({ ok: false, via, error: 'Windows did not confirm showing the notification within 8 seconds' }), 8_000);
    notification.on('show', () => done({ ok: true, via }));
    notification.on('failed', (_event, error) => done({ ok: false, via, error: String(error || 'Windows reported the notification failed') }));
    notification.on('click', () => showJarvisWindow());
    try {
      notification.show();
    } catch (err) {
      done({ ok: false, via, error: (err as Error).message });
    }
  });
}

async function ensureMainWindow(): Promise<BrowserWindow> {
  if (window && !window.isDestroyed()) return window;
  const windowTitle = windowTitleForProfile(dataDir, realDesktopDataDirFromOs());
  window = new BrowserWindow({
    width: 1100,
    height: 820,
    title: windowTitle,
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
  // A test copy keeps saying so: the page's own <title> must not replace "TEST COPY" (tracker item 23).
  if (windowTitle !== 'Pandesh') window.on('page-title-updated', (event) => event.preventDefault());
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
    if (url === window?.webContents.getURL()) return;
    event.preventDefault();
    try {
      void shell.openExternal(normalizeSafeBrowserUrl(url));
    } catch {
      // Refused: the app window never navigates away.
    }
  });
  // The only frames inside the window are Workshop previews; a frame may load a preview and nothing else. The
  // window's own policy (frame-src pandesh-preview:) already blocks any other address before a request is made;
  // this is the second layer, should that policy ever be loosened.
  window.webContents.on('will-frame-navigate', (details) => {
    if (details.isMainFrame) return;
    if (isDesignPreviewUrl(details.url) || details.url === 'about:blank') return;
    details.preventDefault();
    hostLog('stopped a navigation inside a Workshop preview frame');
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
  // Only the window itself, never a frame inside it (a Workshop preview), may use the microphone.
  window.webContents.session.setPermissionRequestHandler((_wc, permission, callback, details) => {
    callback(permission === 'media' && details.isMainFrame !== false && !isDesignPreviewUrl(details.requestingUrl ?? ''));
  });
  window.webContents.session.setPermissionCheckHandler((_wc, permission, requestingOrigin, details) => (
    permission === 'media' && details.isMainFrame !== false && !isDesignPreviewUrl(requestingOrigin ?? '') && !isDesignPreviewUrl(details.requestingUrl ?? '')
  ));
  await window.loadFile(rendererEntry());
  return window;
}

/** Classic renderer unless the Phase 2 UI is selected (PANDESH_UI_V2 or the saved preference). */
function rendererEntry(): string {
  return resolveUiVariant(prefs) === 'v2'
    ? path.join(__dirname, '..', 'renderer', 'v2', 'index.html')
    : path.join(__dirname, '..', 'renderer', 'index.html');
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
      // The phone page on this PC, without a pairing code: a code works once, and this click must not use it up.
      if (mobileServer && mobileServer.isRunning()) {
        const info = mobileServer.getPairingInfo();
        void shell.openExternal(`http://127.0.0.1:${info.port}/`);
      }
    },
    setUiVariant: (variant) => {
      prefs = writeHostPreferences(dataDir, { uiVariant: variant });
      if (window && !window.isDestroyed()) void window.loadFile(rendererEntry());
      syncTrayFromSession();
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
    deliverNotification: (input) => deliverOutboxNotification(input),
    // Messages typed in this window may ask the assistant to open places in it (navigate_to).
    uiSurface: () => resolveUiVariant(prefs),
    notificationChannel: () => ({
      supported: Notification.isSupported(),
      detail: Notification.isSupported() ? 'Windows desktop notifications (toast)' : 'desktop notifications unsupported on this system',
    }),
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

  await startMobileServer();

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
  ipcMain.handle(DESKTOP_CHANNELS.chooseFolder, async (_event, options?: { title?: unknown; purpose?: unknown }) => {
    if (!window) return null;
    const purpose = options?.purpose === 'second_brain' ? 'second_brain' : 'workspace';
    const current = session?.snapshot().folder ?? null;
    const result = await dialog.showOpenDialog(window, {
      title: purpose === 'second_brain' ? 'Choose a folder for Second Brain to read' : 'Choose a workspace folder for Pandesh',
      ...(current ? { defaultPath: current } : {}),
      properties: ['openDirectory'],
    });
    if (result.canceled || result.filePaths.length === 0) return null;
    return { folder: result.filePaths[0] };
  });
  ipcMain.handle(DESKTOP_CHANNELS.checkWorkspaceFolder, async (_event, folder: unknown) => {
    if (!session) throw new Error('desktop session is not started');
    return session.checkWorkspaceFolder(String(folder ?? ''));
  });
  ipcMain.handle(DESKTOP_CHANNELS.useWorkspace, async (_event, folder: unknown, access: unknown, source: unknown) => {
    if (!session) throw new Error('desktop session is not started');
    const a = (access && typeof access === 'object' ? access : {}) as { read?: unknown; write?: unknown };
    const from = source === 'chat' || source === 'recent' ? source : 'picker';
    const snap = session.useWorkspace(String(folder ?? ''), { read: a.read === true, write: a.write === true }, from);
    sendSnapshot();
    return snap;
  });
  ipcMain.handle(DESKTOP_CHANNELS.setWorkspaceAccess, async (_event, access: unknown) => {
    if (!session) throw new Error('desktop session is not started');
    const snap = session.setWorkspaceAccess(access === 'read' ? 'read' : access === 'read_write' ? 'read_write' : (String(access) as never));
    sendSnapshot();
    return snap;
  });
  ipcMain.handle(DESKTOP_CHANNELS.inspectFolderMention, async (_event, text: unknown) => {
    if (!session) return null;
    return session.inspectFolderMention(String(text ?? ''));
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
  // ── Free models + credentials. Keys and passphrases travel renderer → host only; nothing secret is returned. ──
  const requireSession = () => { if (!session) throw new Error('desktop session is not started'); return session; };
  const idList = (value: unknown): string[] => (Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string' && /^[a-z0-9][a-z0-9-]{1,48}$/.test(v)) : []);
  ipcMain.handle(DESKTOP_CHANNELS.getFreeModels, () => requireSession().getFreeModels());
  ipcMain.handle(DESKTOP_CHANNELS.refreshFreeModels, async () => { const state = await requireSession().refreshFreeModels(); sendSnapshot(); return state; });
  ipcMain.handle(DESKTOP_CHANNELS.setFreeModelPreferences, (_event, prefs: Record<string, unknown>) => requireSession().setFreeModelPreferences({
    ...(prefs && 'autoProviders' in prefs ? { autoProviders: idList(prefs.autoProviders) } : {}),
    ...(prefs && 'disabledProviders' in prefs ? { disabledProviders: idList(prefs.disabledProviders) } : {}),
    ...(prefs && 'preferredOrder' in prefs ? { preferredOrder: idList(prefs.preferredOrder) } : {}),
    ...(prefs && typeof prefs.fallbackOnRateLimit === 'boolean' ? { fallbackOnRateLimit: prefs.fallbackOnRateLimit } : {}),
  }));
  ipcMain.handle(DESKTOP_CHANNELS.setFreeModelSchedule, (_event, enabled: boolean) => requireSession().setFreeModelSchedule(enabled !== false));
  ipcMain.handle(DESKTOP_CHANNELS.testProviderKey, async (_event, providerId: string) => { const state = await requireSession().testProviderKey(String(providerId ?? '')); sendSnapshot(); return state; });
  ipcMain.handle(DESKTOP_CHANNELS.qualifyFreeModel, (_event, providerId: string, model: string) => requireSession().qualifyFreeModel(String(providerId ?? ''), String(model ?? '')));
  ipcMain.handle(DESKTOP_CHANNELS.migrateLegacyKeys, async (_event, providerIds: unknown) => { const result = await requireSession().migrateLegacyKeys(idList(providerIds)); sendSnapshot(); return result; });
  ipcMain.handle(DESKTOP_CHANNELS.exportCredentialBackup, async (_event, passphrase: string, providerIds: unknown) => {
    const s = requireSession();
    const suggestedDir = fs.existsSync('D:\\PandeshBackups') ? 'D:\\PandeshBackups' : app.getPath('documents');
    const options = {
      title: 'Save encrypted key backup',
      defaultPath: path.join(suggestedDir, `pandesh-keys-${new Date().toISOString().slice(0, 10)}.pandesh-keys`),
      filters: [{ name: 'Pandesh key backup', extensions: ['pandesh-keys'] }],
    };
    const picked = window ? await dialog.showSaveDialog(window, options) : await dialog.showSaveDialog(options);
    if (picked.canceled || !picked.filePath) return null;
    return s.exportCredentialBackup(picked.filePath, String(passphrase ?? ''), idList(providerIds));
  });
  ipcMain.handle(DESKTOP_CHANNELS.inspectCredentialBackup, async (_event, file: string | null, passphrase: string) => {
    const s = requireSession();
    let target = typeof file === 'string' && file ? file : '';
    if (!target) {
      const options = { title: 'Open encrypted key backup', properties: ['openFile' as const], filters: [{ name: 'Pandesh key backup', extensions: ['pandesh-keys'] }] };
      const picked = window ? await dialog.showOpenDialog(window, options) : await dialog.showOpenDialog(options);
      if (picked.canceled || picked.filePaths.length === 0) return null;
      target = picked.filePaths[0];
    }
    return { file: target, ...(await s.inspectCredentialBackup(target, String(passphrase ?? ''))) };
  });
  ipcMain.handle(DESKTOP_CHANNELS.restoreCredentialBackup, async (_event, file: string, passphrase: string, providerIds: unknown) => {
    const result = await requireSession().restoreCredentialBackup(String(file ?? ''), String(passphrase ?? ''), idList(providerIds));
    sendSnapshot();
    return result;
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
    await session.resolvePending(String(approvalId ?? ''), resolution === 'approved' ? 'approved' : 'rejected');
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
    // Every Google connection leaves a line in the host log, and a test copy refuses (tracker item 23).
    const refusal = googleConnectRefusal(dataDir, realDesktopDataDirFromOs());
    if (refusal) {
      hostLog(`Google connect refused: ${refusal}`);
      throw new Error(refusal);
    }
    hostLog(`Google connect started from the Pandesh window (profile ${dataDir}${isTestProfile(dataDir, realDesktopDataDirFromOs()) ? `, TEST COPY allowed by ${TEST_PROFILE_GOOGLE_ENV}=1` : ''})`);
    const result = await session.connectGmail();
    hostLog(`Google connect finished: ${result.connected ? `connected (calendar ${result.calendarAccess})` : `not connected${result.lastError ? ` (${String(result.lastError).slice(0, 200)})` : ''}`}`);
    sendSnapshot();
    return result;
  });
  ipcMain.handle(DESKTOP_CHANNELS.disconnectGmail, async () => {
    if (!session) throw new Error('desktop session is not started');
    const result = await session.disconnectGmail();
    hostLog('Google disconnected from the Pandesh window; Gmail and Calendar permissions revoked in Core');
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
    const result = await session.resolveGmailApproval(String(approvalId ?? ''), resolution === 'approved' ? 'approved' : 'rejected');
    sendSnapshot();
    return result;
  });
  ipcMain.handle(DESKTOP_CHANNELS.summarizeGmailThread, async (_event, messages: Array<{ from: string; subject: string; date: string; bodyText: string }>) => {
    if (!session) throw new Error('desktop session is not started');
    return session.summarizeGmailThread(Array.isArray(messages) ? messages : []);
  });
  ipcMain.handle(DESKTOP_CHANNELS.setPermissionMode, async (_event, mode: unknown, grant: unknown) => {
    if (!session) throw new Error('desktop session is not started');
    if (mode !== 'ask' && mode !== 'auto' && mode !== 'plan') throw new Error('unknown permission mode');
    const g = grant && typeof grant === 'object' ? grant as Record<string, unknown> : null;
    const parsed = g ? { categories: Array.isArray(g.categories) ? g.categories.map(String) : [], expiresInMinutes: Number(g.expiresInMinutes) } : undefined;
    const snapshot = await session.setPermissionMode(mode, parsed);
    sendSnapshot();
    return snapshot;
  });
  ipcMain.handle(DESKTOP_CHANNELS.confirmNavigation, async (_event, navigationId: unknown, ok: unknown, detail: unknown, surface: unknown) => {
    if (!session) throw new Error('desktop session is not started');
    return session.confirmNavigation(String(navigationId ?? ''), ok === true, typeof detail === 'string' ? detail.slice(0, 300) : undefined, surface === 'classic' || surface === 'v2' ? surface : undefined);
  });
  ipcMain.handle(DESKTOP_CHANNELS.revokeAuthorization, async (_event, id: unknown) => {
    if (!session) throw new Error('desktop session is not started');
    const snapshot = await session.revokeAuthorization(String(id));
    sendSnapshot();
    return snapshot;
  });
  ipcMain.handle(DESKTOP_CHANNELS.retryGmailProbe, async () => {
    if (!session) throw new Error('desktop session is not started');
    const result = await session.retryGmailProbe();
    sendSnapshot();
    return result;
  });
  ipcMain.handle(DESKTOP_CHANNELS.allowInboxOrganization, async () => {
    if (!session) throw new Error('desktop session is not started');
    // A new Google consent (gmail.modify): the same test-copy rule and log line as Connect (tracker item 23).
    const refusal = googleConnectRefusal(dataDir, realDesktopDataDirFromOs());
    if (refusal) {
      hostLog(`Google inbox organization refused: ${refusal}`);
      throw new Error(refusal);
    }
    hostLog(`Google inbox organization (gmail.modify) consent started from the Pandesh window (profile ${dataDir})`);
    const result = await session.allowInboxOrganization();
    hostLog(`Google inbox organization finished: ${result.inboxOrganization}`);
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
    hostLog('Google OAuth client removed and Google disconnected from the Pandesh window; Gmail and Calendar permissions revoked in Core');
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
    return session.resolveWebResearch(approval, resolution === 'approved' ? 'approved' : 'rejected');
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
  ipcMain.handle(DESKTOP_CHANNELS.household, async (_event, action: string, args?: Record<string, unknown>) => {
    if (!session) throw new Error('desktop session is not started');
    return session.household(String(action ?? ''), args && typeof args === 'object' ? args : {});
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
    const result = await session.resolveAssistantApproval(String(approvalId ?? ''), resolution === 'approved' ? 'approved' : 'rejected');
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
  ipcMain.handle(DESKTOP_CHANNELS.openActivityDocument, async (_event, activityId: string) => {
    if (!session) throw new Error('desktop session is not started');
    const file = session.activityDocumentPath(String(activityId ?? ''));
    const result = await shell.openPath(file);
    if (result) throw new Error(result);
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
  // --- The Workshop: every write goes to Core, which owns the versions (core/api/workshopRoutes.ts) ---
  ipcMain.handle(DESKTOP_CHANNELS.listWorkshops, async (_event, conversationId: unknown, scope: unknown) => {
    if (!session) throw new Error('desktop session is not started');
    return session.listWorkshops(typeof conversationId === 'string' ? conversationId : null, scope === 'recent' ? 'recent' : undefined);
  });
  ipcMain.handle(DESKTOP_CHANNELS.loadWorkshopVersion, async (_event, artifactId: unknown) => {
    if (!session) throw new Error('desktop session is not started');
    return session.loadWorkshopVersion(String(artifactId ?? ''));
  });
  ipcMain.handle(DESKTOP_CHANNELS.focusWorkshop, async (_event, conversationId: unknown, workshopId: unknown, artifactId: unknown, open: unknown) => {
    if (!session) throw new Error('desktop session is not started');
    return session.focusWorkshop(String(conversationId ?? ''), typeof workshopId === 'string' ? workshopId : null, typeof artifactId === 'string' ? artifactId : null, open === true);
  });
  ipcMain.handle(DESKTOP_CHANNELS.confirmWorkshopCommand, async (_event, commandId: unknown, ok: unknown, detail: unknown, state: unknown) => {
    if (!session) throw new Error('desktop session is not started');
    return session.confirmWorkshopCommand(String(commandId ?? ''), ok === true, typeof detail === 'string' ? detail.slice(0, 400) : undefined, state && typeof state === 'object' && !Array.isArray(state) ? state as Record<string, unknown> : undefined);
  });
  ipcMain.handle(DESKTOP_CHANNELS.saveWorkshopEdit, async (_event, workshopId: unknown, parentArtifactId: unknown, conversationId: unknown, edits: unknown) => {
    if (!session) throw new Error('desktop session is not started');
    // 3D edits arrive as a list, simulation changes as { set, adjust }; Core validates either before saving.
    return session.saveWorkshopEdit(String(workshopId ?? ''), String(parentArtifactId ?? ''), typeof conversationId === 'string' ? conversationId : null, Array.isArray(edits) || (edits && typeof edits === 'object') ? edits : []);
  });
  ipcMain.handle(DESKTOP_CHANNELS.exportWorkshopGlb, async (_event, workshopId: unknown, sourceArtifactId: unknown, conversationId: unknown, bytes: unknown, expectedNodes: unknown) => {
    if (!session) throw new Error('desktop session is not started');
    if (!(bytes instanceof Uint8Array)) throw new Error('the export must be binary data');
    return session.exportWorkshopGlb(String(workshopId ?? ''), String(sourceArtifactId ?? ''), typeof conversationId === 'string' ? conversationId : null, bytes, Array.isArray(expectedNodes) ? expectedNodes.map(String) : []);
  });
  ipcMain.handle(DESKTOP_CHANNELS.designPreview, async (_event, artifactId: unknown) => {
    if (!session) throw new Error('desktop session is not started');
    // The hash-verified page from Core, checked again, then served only from memory by a short-lived token.
    const content = await session.loadWorkshopVersion(String(artifactId ?? ''));
    if (content.type !== 'design') throw new Error('This file is not a Design workshop page');
    const check = checkDesignHtml(content.html);
    if (!check.ok) throw new Error(`The page cannot be shown: ${check.errors.join('; ')}`);
    return { ...designPreviews.mint({ artifactId: content.artifactId, html: content.html }), warnings: check.warnings };
  });
  ipcMain.handle(DESKTOP_CHANNELS.saveWorkshopFile, async (_event, artifactId: unknown) => {
    if (!session || !window) throw new Error('desktop session is not started');
    const source = await session.artifactPath(String(artifactId ?? ''));
    const choice = await dialog.showSaveDialog(window, { title: 'Save a copy', defaultPath: path.basename(source) });
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
    return session.resolveImageApproval(String(approvalId ?? ''), resolution === 'approved' ? 'approved' : 'rejected');
  });
  ipcMain.handle(DESKTOP_CHANNELS.cancelImageGeneration, async () => {
    if (!session) throw new Error('desktop session is not started');
    await session.cancelImageGeneration();
  });
  ipcMain.handle(DESKTOP_CHANNELS.resolveWeatherApproval, async (_event, approvalId: string, resolution: 'approved' | 'rejected') => {
    if (!session) throw new Error('desktop session is not started');
    return session.resolveWeatherApproval(String(approvalId ?? ''), resolution === 'approved' ? 'approved' : 'rejected');
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
  ipcMain.handle(DESKTOP_CHANNELS.getMobilePairing, () => mobilePairingView());
  ipcMain.handle(DESKTOP_CHANNELS.rotateMobilePairingCode, async () => {
    mobileServer?.rotateCode();
    return mobilePairingView();
  });
  ipcMain.handle(DESKTOP_CHANNELS.forgetMobileDevice, async (_event, id: string) => {
    const target = String(id ?? '').trim();
    if (!target) throw new Error('which phone to forget is required');
    mobileServer?.forgetDevice(target);
    sendSnapshot();
    return mobilePairingView();
  });
  ipcMain.handle(DESKTOP_CHANNELS.setMobileAccess, async (_event, mode: string) => {
    const access = parseMobileAccess(mode);
    if (String(mode) !== access) throw new Error(`unknown phone access '${String(mode)}'`);
    prefs = writeHostPreferences(dataDir, { mobileAccess: access });
    hostLog(`Pandesh Mobile access set to ${access}`);
    await startMobileServer();
    sendSnapshot();
    return mobilePairingView();
  });
  ipcMain.handle(DESKTOP_CHANNELS.resumeMobilePairing, async () => {
    mobileServer?.resumePairing();
    return mobilePairingView();
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
  ipcMain.handle(DESKTOP_CHANNELS.getUiVariant, () => ({
    variant: resolveUiVariant(prefs),
    forcedByEnv: Boolean(process.env.PANDESH_UI_V2?.trim()),
  }));
  ipcMain.handle(DESKTOP_CHANNELS.setUiVariant, (event, variant: unknown) => {
    prefs = writeHostPreferences(dataDir, { uiVariant: variant === 'v2' ? 'v2' : 'classic' });
    // Reload only the window that asked, after the reply is delivered.
    const target = BrowserWindow.fromWebContents(event.sender);
    if (target && !target.isDestroyed()) setTimeout(() => { void target.loadFile(rendererEntry()); }, 50);
    return { variant: resolveUiVariant(prefs), forcedByEnv: Boolean(process.env.PANDESH_UI_V2?.trim()) };
  });
  ipcMain.handle(DESKTOP_CHANNELS.getUpdateStatus, (): DesktopUpdateStatus => {
    const identity = currentBuildIdentity();
    return {
      available: updaterAvailable(productRoot),
      installedRevision: identity.buildNumber,
      version: identity.version,
      lastResult: readUpdateResult(dataDir),
    };
  });
  ipcMain.handle(DESKTOP_CHANNELS.acknowledgeUpdateResult, () => acknowledgeUpdateResult(dataDir));
  ipcMain.handle(DESKTOP_CHANNELS.startUpdate, (_event, testPackagePath?: string) => startUpdate(testPackagePath));
}

/** Test hook: an isolated test instance may skip the confirmation dialogs and name its package. Never set in production. */
const updateTestMode = process.env.KARKEDIKHA_UPDATE_TEST_AUTOCONFIRM === '1';
let updateInProgress = false;

/**
 * Update & Restart. Verifies a user-chosen local package, makes Core safe to stop (no new Gmail writes, running ones
 * finish), starts the separate updater and quits. Every refusal leaves the installation exactly as it was.
 */
async function startUpdate(testPackagePath?: string): Promise<DesktopUpdateStartResult> {
  if (updateInProgress || isShuttingDown) return { status: 'blocked', message: 'An update is already in progress.' };
  if (!updaterAvailable(productRoot)) {
    return { status: 'unavailable', message: 'This installation does not include the updater. Run the latest Pandesh installer once to enable updates.' };
  }
  const node = process.env.KARKEDIKHA_DESKTOP_NODE?.trim() || path.join(productRoot, 'runtime', 'node.exe');
  let packagePath = updateTestMode && testPackagePath ? testPackagePath : undefined;
  if (!packagePath) {
    const picked = await dialog.showOpenDialog(window!, {
      title: 'Choose a Pandesh update package',
      filters: [{ name: 'Pandesh update', extensions: ['pdupdate'] }],
      properties: ['openFile'],
    });
    if (picked.canceled || !picked.filePaths[0]) return { status: 'cancelled', message: 'No update package was chosen.' };
    packagePath = picked.filePaths[0];
  }

  let summary;
  try {
    summary = await inspectPackage({ productRoot, dataDir, node, packagePath });
  } catch (err) {
    hostLog(`update rejected: ${(err as Error).message}`);
    return { status: 'rejected', message: (err as Error).message };
  }

  if (!updateTestMode) {
    const active = (await readCoreReadiness(dataDir))?.activeAttempts ?? 0;
    const detail = [
      `Build b${summary.installedRevision} → b${summary.revision} (v${summary.version}), updating: ${summary.components.join(' + ')}.`,
      summary.migrates ? `The database will be upgraded (schema ${summary.dbSchemaFrom} → ${summary.dbSchemaTo}); it is backed up first.` : 'No database change.',
      'Your conversations, memory, settings and Google sign-in are kept. If the new version does not start, the previous one is restored automatically.',
      active > 0 ? `${active} task(s) are running. They will be stopped at a safe point and can be resumed after the restart. A Gmail change that is already being written is always finished first.` : '',
    ].filter(Boolean).join('\n\n');
    const choice = await dialog.showMessageBox(window!, {
      type: 'question', buttons: ['Update & Restart', 'Cancel'], defaultId: 1, cancelId: 1, title: 'Update Pandesh', message: `Update Pandesh to build b${summary.revision}?`, detail,
    });
    if (choice.response !== 0) return { status: 'cancelled', message: 'Update cancelled. Nothing was changed.' };
  }

  updateInProgress = true;
  if (!(await quiesceCore(dataDir))) {
    updateInProgress = false;
    return { status: 'blocked', message: 'A Gmail change is still being written. Nothing was changed; try again in a minute.' };
  }
  try {
    launchUpdater({ productRoot, dataDir, node });
  } catch (err) {
    await setUpdateGate(dataDir, false);
    updateInProgress = false;
    return { status: 'blocked', message: `The updater could not be started: ${(err as Error).message}` };
  }
  hostLog(`update to b${summary.revision} verified; handing over to the updater and quitting`);
  void shutdownAndQuit();
  return { status: 'applying', message: 'Updating… Pandesh will restart in a moment.' };
}

/** Once the window has loaded and Core is connected, say so on disk: the updater uses this to confirm a good update. */
function startUiHealthMarker(): void {
  const started = Date.now();
  const timer = setInterval(() => {
    if (isShuttingDown || Date.now() - started > 300_000) { clearInterval(timer); return; }
    const loaded = Boolean(window && !window.isDestroyed() && !window.webContents.isLoading());
    if (!loaded || session?.snapshot()?.coreState !== 'connected') return;
    try {
      writeUiHealth(dataDir, { buildNumber: currentBuildIdentity().buildNumber, rendererLoaded: true, coreConnected: true });
    } catch (err) {
      hostLog(`could not write ui health marker: ${(err as Error).message}`);
    }
    clearInterval(timer);
  }, 1000);
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
    // "Open in Pandesh" from the browser bridge: the native host relaunches the app with --panda-open=<conversation id>; the
    // running instance shows that conversation. The id is validated here because it comes from outside the process.
    const pandaOpen = Array.isArray(commandLine) ? commandLine.find((arg) => arg.startsWith('--panda-open=')) : undefined;
    const pandaOpenId = pandaOpen?.slice('--panda-open='.length) ?? '';
    if (/^[\w-]{1,80}$/.test(pandaOpenId)) {
      hostLog('opening a browser-bridge task conversation');
      showJarvisWindow();
      sendToRenderer(DESKTOP_CHANNELS.event, {
        kind: 'status',
        at: new Date().toISOString(),
        summary: 'Open browser-bridge task',
        eventType: 'panda_bridge_open',
        text: pandaOpenId,
      });
      return;
    }
    hostLog('second instance attempted; focusing existing Pandesh window');
    showJarvisWindow();
  });

  app.whenReady().then(async () => {
    hostLog('Electron ready');
    // Workshop previews come from memory by token, never from a path (host/designPreview.ts).
    protocol.handle(DESIGN_PREVIEW_SCHEME, (request) => {
      const answer = designPreviews.respond(request.url, request.method);
      return new Response(answer.body, { status: answer.status, headers: answer.headers });
    });
    registerIpc();
    // The build identity is written into every host log line's context: a
    // crash report can be tied to the exact build without asking the user.
    const identity = currentBuildIdentity();
    hostLog(
      `build identity: v${identity.version} · ${identity.buildKind === 'release' ? `b${identity.buildNumber}` : 'dev'} `
      + `(${identity.releaseChannel}) commit=${identity.commit ?? 'unknown'} built=${identity.builtAt ?? 'unknown'} `
      + `installer=${identity.installerVersion ?? 'unknown'} electron=${process.versions.electron ?? 'n/a'}`,
    );
    startUiHealthMarker();
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
