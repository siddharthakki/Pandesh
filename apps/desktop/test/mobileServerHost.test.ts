import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { MobileServer, defaultMobileHost } from '../src/host/mobileServer';

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
    expect(defaultMobileHost({ KARKEDIKHA_MOBILE_HOST: '192.168.2.66' }, 'D:/scratch', real)).toBe('192.168.2.66');
  });
});

describe('the host log never records the pairing PIN (Build 161 audit, gate E)', () => {
  it('names where the server listens, without the PIN or the ?pair= link', () => {
    const line = MobileServer.logLine({ ip: '192.168.2.66', port: 3030 });
    expect(line).toContain('http://192.168.2.66:3030/');
    expect(line).not.toMatch(/pair=|PIN:\s*\w/);
  });

  it('main.ts logs the started server through that line only', () => {
    const main = fs.readFileSync(path.join(__dirname, '../src/main.ts'), 'utf8');
    expect(main).toContain('hostLog(MobileServer.logLine(info))');
    expect(main).not.toMatch(/hostLog\([^)]*(?:info\.code|info\.url|pairingCode)/);
  });
});
