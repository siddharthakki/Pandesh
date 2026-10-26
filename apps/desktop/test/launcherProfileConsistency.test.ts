import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

const desktopRoot = path.resolve(__dirname, '..');
const packagePortablePath = path.join(desktopRoot, 'scripts', 'package-portable.mjs');
const launchScriptPath = path.join(desktopRoot, 'launch.mjs');
const mainTsPath = path.join(desktopRoot, 'src', 'main.ts');
const installerPinPath = path.join(desktopRoot, 'installer', 'installer-pin.json');
const issPath = path.join(desktopRoot, 'installer', 'pandesh-desktop.iss');

describe('Launcher and desktop profile consistency', () => {
  it('Launch-Pandesh.cmd resolves to production desktop profile by default', () => {
    const portableScript = fs.readFileSync(packagePortablePath, 'utf8');

    // Must set default data dir to KarkeDikha\desktop
    expect(portableScript).toMatch(
      /if not defined KARKEDIKHA_DESKTOP_DATA_DIR set "KARKEDIKHA_DESKTOP_DATA_DIR=%LOCALAPPDATA%\\\\KarkeDikha\\\\desktop"/,
    );

    // Must never fall back to legacy jarvis-desktop
    expect(portableScript).not.toContain('jarvis-desktop');
  });

  it('preserves explicit KARKEDIKHA_DESKTOP_DATA_DIR override for isolated tests', () => {
    const portableScript = fs.readFileSync(packagePortablePath, 'utf8');
    // Must be conditional ("if not defined"), allowing smoke and acceptance harnesses to isolate their data
    expect(portableScript).toContain('if not defined KARKEDIKHA_DESKTOP_DATA_DIR');

    const mainTs = fs.readFileSync(mainTsPath, 'utf8');
    expect(mainTs).toContain('!process.env.KARKEDIKHA_DESKTOP_DATA_DIR?.trim()');

    const launchScript = fs.readFileSync(launchScriptPath, 'utf8');
    expect(launchScript).toContain('process.env.KARKEDIKHA_DESKTOP_DATA_DIR');
  });

  it('normal installed main.ts and dev launch.mjs resolve to the same KarkeDikha/desktop profile', () => {
    const mainTs = fs.readFileSync(mainTsPath, 'utf8');
    expect(mainTs).toMatch(/path\.join\(localAppData,\s*'KarkeDikha',\s*'desktop'\)/);
    expect(mainTs).not.toContain('jarvis-desktop');

    const launchScript = fs.readFileSync(launchScriptPath, 'utf8');
    expect(launchScript).toMatch(/'KarkeDikha',\s*'desktop'/);
    expect(launchScript).not.toContain('jarvis-desktop');
  });

  it('installer pin and inno setup script target KarkeDikha\\desktop', () => {
    const pin = JSON.parse(fs.readFileSync(installerPinPath, 'utf8')) as {
      dataDirRelative: string;
    };
    expect(pin.dataDirRelative.replace(/\\\\/g, '/').replace(/\\/g, '/')).toBe('KarkeDikha/desktop');

    const iss = fs.readFileSync(issPath, 'utf8');
    expect(iss).toMatch(/KarkeDikha\\desktop/);
    expect(iss).not.toContain('jarvis-desktop');
  });
});
