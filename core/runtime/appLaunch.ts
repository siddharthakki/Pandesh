/**
 * Opening an app on the person's screen by its name.
 *
 * Everyday tasks, 2026-11-24: "Open Notepad" was answered with "I cannot open applications"; no tool did it.
 * What may be opened is narrow on purpose:
 *  - a short list of Windows' own everyday apps, started without a card (like opening a file in its viewer);
 *  - an installed program that Windows itself lists under that name (registered app path, Start menu shortcut, PATH),
 *    started only after the person approves a card that names the exact program file.
 * Never a command shell, script host, installer or system tool, and never with arguments: this opens a window for the
 * person, it does not run anything on Pandesh's behalf.
 */
import * as cp from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import type { InstalledAppLookup } from './installedAppLookup';

export interface BuiltinApp { label: string; start: string; process: string | null }

/** Windows' own everyday apps. `start` is handed to the shell's "start" verb; `process` is what the Task Manager shows. */
const BUILTIN_APPS: Record<string, BuiltinApp> = {
  notepad: { label: 'Notepad', start: 'notepad.exe', process: 'notepad.exe' },
  calculator: { label: 'Calculator', start: 'calc.exe', process: 'CalculatorApp.exe' },
  paint: { label: 'Paint', start: 'mspaint.exe', process: 'mspaint.exe' },
  'file explorer': { label: 'File Explorer', start: 'explorer.exe', process: null },
  settings: { label: 'Settings', start: 'ms-settings:', process: 'SystemSettings.exe' },
};
const BUILTIN_ALIASES: Record<string, string> = {
  calc: 'calculator', 'windows calculator': 'calculator', mspaint: 'paint', 'ms paint': 'paint', 'microsoft paint': 'paint',
  explorer: 'file explorer', 'windows explorer': 'file explorer', 'the file explorer': 'file explorer',
  'windows settings': 'settings', 'pc settings': 'settings', 'the notepad': 'notepad', 'windows notepad': 'notepad',
};

/** Shells, script hosts, installers and system tools: never opened by name, whoever asks. */
const NEVER_OPENED = /^(?:cmd|command prompt|powershell(?: ise)?|windows powershell|pwsh|terminal|windows terminal|wt|bash|wsl|ubuntu|git bash|regedit|registry editor|wscript|cscript|mshta|rundll32|regsvr32|msiexec|taskkill|schtasks|task scheduler|sc|net|reg|bcdedit|diskpart|format|shutdown|python\d*(?:\.\d+)?|pythonw|py|node|nodejs|npm|npx|git|curl|wget|ssh|certutil|bitsadmin|control|mmc|gpedit|services|computer management|disk management)$/i;
const NEVER_OPENED_FILE = /(?:^|[\\/])(?:unins\w*|uninstall\w*|setup|install\w*|update\w*|updater)[^\\/]*\.exe$/i;

export type AppTarget =
  | { ok: true; builtin: true; name: string; start: string; process: string | null }
  | { ok: true; builtin: false; name: string; file: string; process: string; source: string }
  | { ok: false; reason: string; text: string };

function normalise(name: string): string {
  return name.trim().toLowerCase().replace(/\.exe$/i, '').replace(/\s+/g, ' ').replace(/\s+app(?:lication)?$/i, '');
}

/** One of Windows' own everyday apps, or null. */
export function builtinApp(name: string): BuiltinApp | null {
  const q = normalise(name);
  return BUILTIN_APPS[q] ?? BUILTIN_APPS[BUILTIN_ALIASES[q] ?? ''] ?? null;
}

export function neverOpened(name: string): boolean {
  return NEVER_OPENED.test(normalise(name));
}

/**
 * Which program a name means, from what Windows lists. Exactly one program file, or a refusal that says why: an
 * ambiguous name is never guessed, because the wrong program would open on the person's screen.
 */
export function resolveAppTarget(name: string, lookup: InstalledAppLookup | null, exists: (file: string) => boolean = fs.existsSync): AppTarget {
  const q = normalise(name);
  const no = (reason: string, detail: string): AppTarget => ({ ok: false, reason, text: `NOT OPENED: ${detail} Nothing was opened; tell the user so.` });
  if (neverOpened(q)) return no('not an app Pandesh opens', `Pandesh does not open command shells, script hosts, installers or system tools ("${name}"). The user can open it themselves.`);
  const builtin = builtinApp(q);
  if (builtin) return { ok: true, builtin: true, name: builtin.label, start: builtin.start, process: builtin.process };
  if (!lookup) return no('not looked up', `"${name}" is not one of Windows' own everyday apps and the installed-app lookup did not run.`);

  const programs = lookup.matches
    .filter((m) => (m.source === 'app_paths' || m.source === 'start_menu' || m.source === 'path') && typeof m.path === 'string')
    .map((m) => ({ label: m.name.replace(/\.(?:exe|lnk)$/i, ''), file: path.normalize(String(m.path).trim().replace(/^"|"$/g, '')), source: m.source }))
    .filter((m) => /\.exe$/i.test(m.file) && path.isAbsolute(m.file) && !NEVER_OPENED_FILE.test(m.file) && !NEVER_OPENED.test(path.basename(m.file, '.exe')) && !/\buninstall\b/i.test(m.label) && exists(m.file));
  if (programs.length === 0) {
    const listed = lookup.matches.slice(0, 5).map((m) => m.name).join(', ');
    return no('no program file found', listed
      ? `Windows lists ${listed} for "${name}", but none of them as a program file Pandesh can start (a Store app, or only an install folder).`
      : `Windows does not list an app called "${name}" on this PC (registered app paths, Start menu and PATH were checked).`);
  }
  const exact = programs.filter((m) => m.label.toLowerCase() === q || path.basename(m.file, '.exe').toLowerCase() === q);
  const tier = exact.length ? exact : programs;
  const files = new Map<string, { label: string; file: string; source: string }>();
  for (const m of tier) if (!files.has(m.file.toLowerCase())) files.set(m.file.toLowerCase(), m);
  if (files.size > 1) {
    const names = [...files.values()].slice(0, 6).map((m) => `${m.label} (${m.file})`).join('; ');
    return no('more than one program matches', `"${name}" matches more than one program: ${names}. Ask the user which one, then call open_app with that exact name.`);
  }
  const only = [...files.values()][0];
  return { ok: true, builtin: false, name: only.label, file: only.file, process: path.basename(only.file), source: only.source };
}

export type ProcessCounter = (imageName: string) => Promise<number | null>;

/** How many processes with this image name Windows shows right now; null when Windows did not answer. */
export const countProcesses: ProcessCounter = (imageName) => new Promise((resolve) => {
  if (process.platform !== 'win32' || !/^[\w .+-]+\.exe$/i.test(imageName)) { resolve(null); return; }
  cp.execFile('tasklist.exe', ['/FI', `IMAGENAME eq ${imageName}`, '/FO', 'CSV', '/NH'], { windowsHide: true, timeout: 10_000 }, (err, stdout) => {
    if (err) { resolve(null); return; }
    resolve(String(stdout).split(/\r?\n/).filter((line) => line.startsWith('"')).length);
  });
});

export type AppStarter = (target: Extract<AppTarget, { ok: true }>) => void;

/** Hands the app to Windows, detached and without arguments. Throws only when Windows refuses to start the launcher. */
export const startApp: AppStarter = (target) => {
  const systemRoot = process.env.SystemRoot || 'C:\\Windows';
  // Built-ins go through the shell's own "start" (it knows the Store versions of Notepad, Paint and Calculator); the
  // name comes from the fixed table above, never from the request. A program file goes to Explorer, as a double-click.
  const [bin, argv] = target.builtin
    ? [path.join(systemRoot, 'System32', 'cmd.exe'), ['/d', '/c', 'start', '""', target.start]]
    : [path.join(systemRoot, 'explorer.exe'), [target.file]];
  // Verbatim for cmd: Node would otherwise escape the empty window title ("") that "start" needs as its first argument.
  const child = cp.spawn(bin, argv, { detached: true, stdio: 'ignore', windowsHide: target.builtin, windowsVerbatimArguments: target.builtin });
  child.on('error', () => { /* a failed start shows up as "no process appeared" below */ });
  child.unref();
};

export interface AppLaunchResult { opened: boolean; verified: boolean; text: string; before: number | null; after: number | null }

/**
 * Starts the app and checks that Windows shows its process. "Opened" is only reported from that check; an app whose
 * process cannot be counted (File Explorer is always running) is reported as requested, not as verified.
 */
export async function launchApp(target: Extract<AppTarget, { ok: true }>, deps: { start?: AppStarter; count?: ProcessCounter; waitMs?: number } = {}): Promise<AppLaunchResult> {
  const start = deps.start ?? startApp;
  const count = deps.count ?? countProcesses;
  const waitMs = deps.waitMs ?? 8_000;
  const before = target.process ? await count(target.process) : null;
  try { start(target); } catch (err: any) {
    return { opened: false, verified: false, before, after: before, text: `NOT OPENED: Windows did not start ${target.name}: ${err?.message ?? String(err)}. Nothing was opened; tell the user so.` };
  }
  if (!target.process || before === null) {
    return { opened: true, verified: false, before, after: null, text: `Asked Windows to open ${target.name}. Pandesh could not check that its window appeared, so say it was asked to open, not that it is open.` };
  }
  let after: number | null = before;
  const deadline = Date.now() + waitMs;
  do {
    await new Promise((r) => setTimeout(r, Math.min(500, Math.max(1, waitMs))));
    after = await count(target.process);
  } while ((after ?? 0) <= before && Date.now() < deadline);
  if ((after ?? 0) > before) return { opened: true, verified: true, before, after, text: `Opened ${target.name} on the user's screen (checked: Windows now shows ${after} ${target.process} process${after === 1 ? '' : 'es'}, ${before} before).` };
  if (before > 0 && (after ?? 0) >= before) return { opened: true, verified: true, before, after, text: `${target.name} was already running (${before} ${target.process} process${before === 1 ? '' : 'es'}); Windows was asked to open it again and it is still running. Say it was already open.` };
  return { opened: false, verified: false, before, after, text: `NOT OPENED: Windows was asked to start ${target.name}, but no ${target.process} process appeared within ${Math.round(waitMs / 1000)} seconds. Do not say it is open; tell the user it did not start.` };
}
