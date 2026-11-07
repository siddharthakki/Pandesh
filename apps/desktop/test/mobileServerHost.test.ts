import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { defaultMobileHost } from '../src/host/mobileServer';

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
