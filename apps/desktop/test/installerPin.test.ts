import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

const desktopRoot = path.resolve(__dirname, '..');
const pinPath = path.join(desktopRoot, 'installer', 'installer-pin.json');
const issPath = path.join(desktopRoot, 'installer', 'pandesh-desktop.iss');
const appPackagePath = path.join(desktopRoot, 'package.json');

describe('Windows installer pin', () => {
  it('pins Inno Setup 6.7.3 with reproducible setup naming and per-user install', () => {
    const pin = JSON.parse(fs.readFileSync(pinPath, 'utf8')) as {
      tool: string;
      version: string;
      installerUrl: string;
      installerSha256: string;
      setupFileName: string;
      privilegesRequired: string;
      dataDirRelative: string;
      electronVersion: string;
      productName: string;
    };

    expect(pin.tool).toBe('Inno Setup');
    expect(pin.version).toBe('6.7.3');
    expect(pin.setupFileName).toBe('Pandesh-Setup.exe');
    expect(pin.productName).toBe('Pandesh');
    expect(pin.privilegesRequired).toBe('lowest');
    expect(pin.dataDirRelative.replace(/\\/g, '/')).toBe('KarkeDikha/desktop');
    expect(pin.electronVersion).toBe('33.4.11');
    expect(pin.installerUrl).toContain('innosetup-6.7.3.exe');
    expect(pin.installerSha256).toMatch(/^[A-F0-9]{64}$/i);
  });

  it('keeps exactly one application version: the app manifest, never a pinned copy', () => {
    const pin = JSON.parse(fs.readFileSync(pinPath, 'utf8')) as Record<string, unknown>;
    const appPackage = JSON.parse(fs.readFileSync(appPackagePath, 'utf8')) as { version: string };
    // The installer pin is a TOOL pin. It must not carry a second copy of the
    // product version, or the installer and the app could disagree.
    expect(pin.productVersion).toBeUndefined();
    expect(appPackage.version).toMatch(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/);
    for (const iss of [issPath, path.join(desktopRoot, 'installer', 'pandesh-smoke.iss')]) {
      const text = fs.readFileSync(iss, 'utf8');
      // The version must be supplied at compile time, never hard-coded.
      expect(text).toMatch(/#error MyAppVersion must be defined/);
      expect(text).not.toMatch(/#define MyAppVersion "\d/);
    }
  });

  it('ISS stays per-user, preserves LocalAppData, and launches electron\\Pandesh.exe', () => {
    const iss = fs.readFileSync(issPath, 'utf8');
    expect(iss).toMatch(/PrivilegesRequired=lowest/);
    expect(iss).toMatch(/DefaultDirName=\{localappdata\}\\Programs\\/);
    expect(iss).toMatch(/OutputBaseFilename=Pandesh-Setup/);
    expect(iss).toMatch(/MyAppExeName "electron\\Pandesh\.exe"/);
    expect(iss).toMatch(/\{userdesktop\}/);
    expect(iss).toMatch(/\{group\}/);
    expect(iss).toMatch(/KarkeDikha\\desktop/);
    expect(iss).not.toMatch(/PrivilegesRequired=admin/i);
  });

  it('keeps the install identity of the earlier builds so an upgrade is in place', () => {
    const iss = fs.readFileSync(issPath, 'utf8');
    const pin = JSON.parse(fs.readFileSync(pinPath, 'utf8')) as { appIdGuid?: string };
    // The AppId GUID is the installed-product identity. Changing it would
    // install a second, separate copy beside the first and orphan the user's
    // settings, paired phones and stored Google credential.
    expect(iss).toMatch(/AppId=\{\{[0-9A-F-]{36}\}/);
    expect(pin.appIdGuid).toBe('{8F3C2A91-6B4E-4D17-9C5A-2E8F0B7D4A11}');
    expect(iss).toContain('8F3C2A91-6B4E-4D17-9C5A-2E8F0B7D4A11');
  });

  it('configures upgrade-safe shutdown without relying on Restart Manager CloseApplications', () => {
    const desktopIss = fs.readFileSync(issPath, 'utf8');
    const smokeIssPath = path.join(desktopRoot, 'installer', 'pandesh-smoke.iss');
    const smokeIss = fs.readFileSync(smokeIssPath, 'utf8');
    const shutdownIssPath = path.join(desktopRoot, 'installer', 'upgrade-shutdown.iss');
    const shutdownIss = fs.readFileSync(shutdownIssPath, 'utf8');

    expect(desktopIss).toMatch(/CloseApplications=no/);
    expect(desktopIss).toMatch(/#include "upgrade-shutdown\.iss"/);
    expect(smokeIss).toMatch(/CloseApplications=no/);
    expect(smokeIss).toMatch(/#include "upgrade-shutdown\.iss"/);

    expect(shutdownIss).toContain('PrepareToInstall');
    expect(shutdownIss).toContain('FindRunningProcessesInDir');
    expect(shutdownIss).toContain('RequestGracefulShutdown');
    expect(shutdownIss).toContain('--shutdown-for-upgrade');
    expect(shutdownIss).toContain('/v1/core/shutdown');
  });
});
