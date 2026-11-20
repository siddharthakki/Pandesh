import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { AUTHORITATIVE_PROCESS_SPAWN_ALLOWLIST } from '../security/architectureGuard';
import { DEFAULT_TAILSCALE_EXE, TAILSCALE_ARGV, TailscaleError, filterTailscaleStatus, readTailscaleStatus, resolveTailscaleExe } from '../runtime/tailscaleStatus';
import { tailscaleService } from '../runtime/kandev/bridgeCoreServices';
import { classifyInstruction } from '../runtime/kandev/intentRouter';

const RAW = {
  Version: '1.0', BackendState: 'Running', AuthURL: 'https://login.tailscale.com/a/SECRET-AUTH', HaveNodeKey: true, Health: ['warn one'],
  CurrentTailnet: { Name: 'example.ts.net', MagicDNSSuffix: 'x' },
  Self: { ID: 'n1', PublicKey: 'nodekey:SECRETKEY', UserID: 7, HostName: 'desktop-1', DNSName: 'desktop-1.t.ts.net.', TailscaleIPs: ['100.1.1.1'], Online: true, PrimaryRoutes: ['10.0.0.0/8'] },
  Peer: {
    'nodekey:AAA': { PublicKey: 'nodekey:AAA', HostName: 'phone', DNSName: 'phone.t.ts.net.', TailscaleIPs: ['100.1.1.2'], Online: true, OS: 'android', LastSeen: '0001-01-01T00:00:00Z' },
    'nodekey:BBB': { PublicKey: 'nodekey:BBB', HostName: 'nas', DNSName: 'nas.t.ts.net.', TailscaleIPs: ['100.1.1.3'], Online: false, OS: 'linux', LastSeen: '2026-11-19T10:00:00Z' },
  },
  User: { 7: { LoginName: 'private@example.com' } },
};

describe('tailscale status adapter', () => {
  it('can only run one fixed argv, and the module is separately allowlisted', () => {
    expect([...TAILSCALE_ARGV]).toEqual(['status', '--json']);
    expect(Object.isFrozen(TAILSCALE_ARGV)).toBe(true);
    expect(AUTHORITATIVE_PROCESS_SPAWN_ALLOWLIST.has('core/runtime/tailscaleStatus.ts')).toBe(true);
    const src = fs.readFileSync(path.join(__dirname, '..', 'runtime', 'tailscaleStatus.ts'), 'utf8');
    expect(src.match(/spawn\(/g)?.length).toBe(1);
    expect(src).not.toMatch(/'(up|down|login|logout|set|serve|funnel|cert|ssh|file|lock|switch)'/);
  });

  it('keeps only allow-listed fields: no keys, auth URLs, user profiles or routes', () => {
    const s = filterTailscaleStatus(RAW);
    const text = JSON.stringify(s);
    for (const secret of ['SECRET-AUTH', 'SECRETKEY', 'nodekey', 'private@example.com', '10.0.0.0/8', 'UserID']) expect(text).not.toContain(secret);
    expect(s).toMatchObject({ backendState: 'Running', tailnet: 'example.ts.net', health: ['warn one'], self: { hostName: 'desktop-1', online: true } });
    expect(s.peers.map(p => [p.hostName, p.online, p.lastSeen])).toEqual([['nas', false, '2026-11-19T10:00:00Z'], ['phone', true, null]]);
  });

  it('rejects output that is not a status object', () => {
    expect(() => filterTailscaleStatus(null)).toThrow(TailscaleError);
    expect(() => filterTailscaleStatus({ nope: 1 })).toThrow(/BackendState/);
  });

  it('missing, mis-named or unrunnable executables fail with a clear reason, never a guess', async () => {
    await expect(readTailscaleStatus({ exe: null })).rejects.toMatchObject({ reason: 'not_installed' });
    expect(resolveTailscaleExe({ KARKEDIKHA_TAILSCALE_EXE: 'C:\\Windows\\System32\\cmd.exe' } as NodeJS.ProcessEnv)).toBeNull();
    expect(resolveTailscaleExe({ KARKEDIKHA_TAILSCALE_EXE: 'C:\\nope\\tailscale.exe' } as NodeJS.ProcessEnv)).toBeNull();
    await expect(readTailscaleStatus({ exe: 'C:\\nope\\tailscale.exe' })).rejects.toMatchObject({ reason: 'failed' });
  });

  it('routes plain status questions deterministically and leaves changes to the model/approval path', () => {
    expect(classifyInstruction('Is Tailscale connected?')).toMatchObject({ kind: 'service', taskClass: 'network.status' });
    expect(classifyInstruction('tailscale status')).toMatchObject({ taskClass: 'network.status' });
    expect(classifyInstruction('which devices are online on the tailnet')).toMatchObject({ taskClass: 'network.status' });
    expect(classifyInstruction('install tailscale and log in')).toBeNull();
    expect(classifyInstruction('explain why tailscale is not connected')).toBeNull();
  });

  const live = fs.existsSync(DEFAULT_TAILSCALE_EXE);
  it.skipIf(!live)('with the real client installed, returns a filtered status', async () => {
    const out = await tailscaleService().run({ args: {}, signal: new AbortController().signal } as never);
    expect(out.evidence).toMatchObject({ kind: 'tailscale-status' });
    expect(JSON.stringify(out.evidence)).not.toMatch(/nodekey:|AuthURL/);
  }, 20_000);
});
