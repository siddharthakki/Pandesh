/**
 * Windows tray for Jarvis background operation (window hidden ≠ quit).
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { Menu, Tray, nativeImage, type NativeImage } from 'electron';
import { createAppIcon } from './appIcon';

export interface JarvisTrayHandlers {
  openJarvis: () => void;
  setWakeEnabled: (enabled: boolean) => void | Promise<void>;
  setWakeMuted: (muted: boolean) => void | Promise<void>;
  stopSpeaking: () => void;
  setOpenAtLogin: (enabled: boolean) => void;
  quitJarvis: () => void;
  openMobileUrl?: () => void;
}

export interface JarvisTrayState {
  wakeEnabled: boolean;
  wakeMuted: boolean;
  speaking: boolean;
  openAtLogin: boolean;
  windowHidden: boolean;
  mobileServerStatus?: string;
}

function trayIcon(): NativeImage {
  const candidates = [
    path.join(__dirname, '..', '..', 'assets', 'icon.ico'),
    path.join(__dirname, '..', 'assets', 'icon.ico'),
    path.join(process.cwd(), 'apps', 'desktop', 'assets', 'icon.ico'),
    path.join(process.resourcesPath || '', 'assets', 'icon.ico'),
    path.join(process.resourcesPath || '', 'icon.ico'),
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) {
      try {
        const img = nativeImage.createFromPath(c);
        if (!img.isEmpty()) return img;
      } catch {}
    }
  }
  return createAppIcon();
}

export class JarvisTrayController {
  private tray: Tray | null = null;
  private state: JarvisTrayState = {
    wakeEnabled: false,
    wakeMuted: false,
    speaking: false,
    openAtLogin: false,
    windowHidden: false,
  };

  constructor(
    private readonly handlers: JarvisTrayHandlers,
    private readonly log?: (message: string) => void,
  ) {}

  ensure(): Tray | null {
    if (this.tray && !this.tray.isDestroyed()) return this.tray;
    try {
      this.tray = new Tray(trayIcon());
      this.tray.setToolTip('JARVIS');
      this.tray.on('double-click', () => this.handlers.openJarvis());
      this.tray.on('click', () => this.handlers.openJarvis());
      this.rebuildMenu();
      this.log?.('system tray ready');
      return this.tray;
    } catch (err) {
      this.log?.(`system tray initialization failed: ${(err as Error).message}`);
      this.tray = null;
      return null;
    }
  }

  isAvailable(): boolean {
    return this.tray !== null && !this.tray.isDestroyed();
  }

  dispose(): void {
    try { this.tray?.destroy(); } catch { /* ignore */ }
    this.tray = null;
  }

  update(partial: Partial<JarvisTrayState>): void {
    this.state = { ...this.state, ...partial };
    if (this.tray && !this.tray.isDestroyed()) this.rebuildMenu();
  }

  private rebuildMenu(): void {
    if (!this.tray || this.tray.isDestroyed()) return;
    const s = this.state;
    const menu = Menu.buildFromTemplate([
      {
        label: 'Open JARVIS',
        click: () => this.handlers.openJarvis(),
      },
      {
        label: s.mobileServerStatus ? `Mobile Server: ${s.mobileServerStatus}` : 'Mobile Server status: Running (port 3030)',
        click: () => this.handlers.openMobileUrl?.(),
      },
      { type: 'separator' },
      {
        label: 'Wake listening',
        type: 'checkbox',
        checked: s.wakeEnabled,
        click: (item) => { void this.handlers.setWakeEnabled(item.checked); },
      },
      {
        label: 'Mute wake',
        type: 'checkbox',
        checked: s.wakeMuted,
        enabled: s.wakeEnabled,
        click: (item) => { void this.handlers.setWakeMuted(item.checked); },
      },
      {
        label: 'Stop speaking',
        enabled: s.speaking,
        click: () => this.handlers.stopSpeaking(),
      },
      { type: 'separator' },
      {
        label: 'Start KarkeDikha when I sign in',
        type: 'checkbox',
        checked: s.openAtLogin,
        click: (item) => this.handlers.setOpenAtLogin(item.checked),
      },
      { type: 'separator' },
      {
        label: 'Quit',
        click: () => this.handlers.quitJarvis(),
      },
    ]);
    this.tray.setContextMenu(menu);
    const parts = ['JARVIS'];
    if (s.windowHidden) parts.push('running in background');
    if (s.mobileServerStatus) parts.push(s.mobileServerStatus);
    this.tray.setToolTip(parts.join(' · '));
  }
}
