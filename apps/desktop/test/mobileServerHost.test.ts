import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { MobileServer, defaultMobileHost, parseMobileAccess } from '../src/host/mobileServer';
import { readHostPreferences, writeHostPreferences } from '../src/host/desktopHostPreferences';
import * as os from 'node:os';

const real = path.resolve('C:/Users/me/AppData/Local/KarkeDikha/desktop');

describe('defaultMobileHost (firewall prompt per test build)', () => {
  it('the real install keeps listening on the LAN so a phone can pair', () => {
    expect(defaultMobileHost({}, real, real)).toBe('0.0.0.0');
    expect(defaultMobileHost({}, `${real.toUpperCase()}/`, real)).toBe('0.0.0.0');
  });

  it('smoke tests and scratch profiles stay on loopback', () => {
    expect(defaultMobileHost({ KARKEDIKHA_DESKTOP_SMOKE_MODE: '1' }, real, real)).toBe('127.0.0.1');
    expect(defaultMobileHost({}, 'D:/Projects/Pandesh/.tmp/claude-audit-profile/desktop', real)).toBe('127.0.0.1');
  });

  it('an explicit override wins', () => {
    expect(defaultMobileHost({ KARKEDIKHA_MOBILE_HOST: '192.0.2.66' }, 'D:/scratch', real)).toBe('192.0.2.66');
  });
});

describe('who can reach Pandesh Mobile (the owner\'s setting)', () => {
  it('"Tailscale only" listens on loopback, so only the local tailscale serve proxy reaches it', () => {
    expect(defaultMobileHost({}, real, real, 'tailscale')).toBe('127.0.0.1');
    expect(defaultMobileHost({}, real, real, 'lan')).toBe('0.0.0.0');
    // A test profile never listens on the network, whatever the setting says.
    expect(defaultMobileHost({}, 'D:/scratch/desktop', real, 'lan')).toBe('127.0.0.1');
  });

  it('only off, lan and tailscale are understood; anything else is the default', () => {
    expect(parseMobileAccess('off')).toBe('off');
    expect(parseMobileAccess('tailscale')).toBe('tailscale');
    expect(parseMobileAccess('lan')).toBe('lan');
    expect(parseMobileAccess('public')).toBe('lan');
    expect(parseMobileAccess(undefined)).toBe('lan');
  });

  it('is kept in the host preferences, home network by default', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pandesh-prefs-'));
    try {
      expect(readHostPreferences(dir).mobileAccess).toBe('lan');
      writeHostPreferences(dir, { mobileAccess: 'tailscale' });
      expect(readHostPreferences(dir).mobileAccess).toBe('tailscale');
      fs.writeFileSync(path.join(dir, 'host-preferences.json'), JSON.stringify({ mobileAccess: 'everyone' }));
      expect(readHostPreferences(dir).mobileAccess).toBe('lan');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('the host log never records the pairing code (Build 161 audit, gate E)', () => {
  it('names where the server listens, without the code or the ?pair= link', () => {
    const line = MobileServer.logLine({ ip: '192.0.2.10', port: 3030 });
    expect(line).toContain('http://192.0.2.10:3030/');
    expect(line).not.toMatch(/pair=|PIN:\s*\w/);
  });

  it('main.ts logs the started server through that line only', () => {
    const main = fs.readFileSync(path.join(__dirname, '../src/main.ts'), 'utf8');
    expect(main).toContain('hostLog(MobileServer.logLine(info))');
    expect(main).not.toMatch(/hostLog\([^)]*(?:info\.code|info\.url|pairingCode|secureUrl)/);
  });

  it('the tray opens the phone page without a code, so a click never uses up the one-time code', () => {
    const main = fs.readFileSync(path.join(__dirname, '../src/main.ts'), 'utf8');
    const tray = main.slice(main.indexOf('openMobileUrl:'), main.indexOf('setUiVariant:'));
    expect(tray).toContain('shell.openExternal(`http://127.0.0.1:${info.port}/`)');
    expect(tray).not.toContain('info.url');
  });
});
