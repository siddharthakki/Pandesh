import { describe, expect, it } from 'vitest';
import {
  createJugaadBridge,
  parseAdbDevices,
  parseContentCallReply,
  type AdbRunner,
} from '../runtime/jugaadDeviceCapability';

const TOKEN = 'a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90';
const SERIAL = 'R3CXB0K5SEF';

const bundle = (json: unknown) => `Result: Bundle[{json=${JSON.stringify(json)}}]\n`;

interface Recorded { args: string[]; stdin: string }

/** Fake phone: honours the one token it was paired with, like PandeshBridgeAuth.verify. */
function fakePhone(options: { enabled?: boolean; token?: string; pulse?: unknown; expenses?: unknown; vault?: unknown } = {}) {
  const calls: Recorded[] = [];
  const enabled = options.enabled ?? true;
  const paired = options.token ?? TOKEN;
  const runner: AdbRunner = async (args, opts) => {
    calls.push({ args, stdin: opts?.stdin ?? '' });
    if (args[0] === 'devices') {
      return { code: 0, timedOut: false, stderr: '', stdout: 'List of devices attached\nR3CXB0K5SEF            device product:e3qxeea model:SM_S928B device:e3q transport_id:4\nemulator-5554          device product:NE2211 model:NE2211 device:OP516FL1 transport_id:1\n' };
    }
    const m = /--method (\w+) --arg (\S*)/.exec(opts?.stdin ?? '');
    const method = m?.[1]; const token = m?.[2];
    const ok = (json: unknown) => ({ code: 0, timedOut: false, stderr: '', stdout: bundle(json) });
    if (method === 'status') return ok({ ok: true, bridgeEnabled: enabled, authorized: enabled && token === paired, app: 'com.jugaad.home', authorizedCalls: 3 });
    if (!enabled) return ok({ ok: false, error: 'bridge_disabled' });
    if (token !== paired) return ok({ ok: false, error: 'unauthorized' });
    if (method === 'pulse') return ok(options.pulse ?? { ok: true, status: 'WATCH', headline: 'On track', projectedAmount: 1234.5, daysLeft: 9 });
    if (method === 'expenses') return ok(options.expenses ?? { ok: true, total: 3, returned: 3, items: [
      { id: 1, title: 'REWE', category: 'Groceries', amount: 42.5, currency: 'EUR', date: '2026-10-01', excluded: false, hasReceipt: true },
      { id: 2, title: 'Rent', category: 'Housing', amount: 900, currency: 'EUR', date: '2026-10-01', excluded: true, hasReceipt: false },
      { id: 3, title: 'DM', category: 'Health', amount: 7.25, currency: 'EUR', date: '2026-10-02', excluded: false, hasReceipt: false },
    ] });
    if (method === 'vault') return ok(options.vault ?? { ok: true, total: 5, byCategory: { RECEIPT: 4 }, bySourceType: { SCAN: 2, RECOVERED: 3 }, returned: 0, items: [] });
    return ok({ ok: false, error: 'unknown_method' });
  };
  return { runner, calls };
}

const call = (name: string, args: Record<string, unknown> = {}) => ({ id: 't', name, arguments: args });
const ctx = { cwd: '.' };

describe('parsers', () => {
  it('parses adb devices -l including model and emulator flag', () => {
    const devices = parseAdbDevices('List of devices attached\nR3CXB0K5SEF device product:e3qxeea model:SM_S928B device:e3q transport_id:4\nemulator-5554 device model:NE2211\nXYZ unauthorized transport_id:9\n');
    expect(devices.map((d) => [d.serial, d.state, d.model, d.emulator])).toEqual([
      ['R3CXB0K5SEF', 'device', 'SM S928B', false], ['emulator-5554', 'device', 'NE2211', true], ['XYZ', 'unauthorized', null, false],
    ]);
  });

  it('extracts the json Bundle reply and rejects anything else', () => {
    expect(parseContentCallReply('Result: Bundle[{json={"ok":true,"x":"}]"}}]\n')).toEqual({ ok: true, x: '}]' });
    expect(parseContentCallReply('Error while accessing provider')).toBeNull();
    expect(parseContentCallReply('Result: Bundle[{json=not-json}]')).toBeNull();
  });
});

describe('JUGAAD bridge', () => {
  it('connects through status, sending the token on stdin and never in argv', async () => {
    const { runner, calls } = fakePhone();
    const bridge = createJugaadBridge({ runner });
    const result = await bridge.connect(SERIAL, TOKEN);
    expect(result).toMatchObject({ connected: true, bridgeEnabled: true, authorizedCalls: 3 });
    expect(JSON.stringify(result)).not.toContain(TOKEN);
    expect(calls).toHaveLength(1);
    expect(calls[0].args).toEqual(['-s', SERIAL, 'shell', '-T']);
    expect(calls[0].args.join(' ')).not.toContain(TOKEN);
    expect(calls[0].stdin).toContain(`--arg ${TOKEN}`);
    expect(bridge.session()).toEqual({ present: true, serial: SERIAL });
  });

  it('rejects a wrong token from the phone and holds no session afterwards', async () => {
    const { runner } = fakePhone();
    const bridge = createJugaadBridge({ runner });
    const wrong = 'f'.repeat(64);
    const result = await bridge.connect(SERIAL, wrong);
    expect(result).toMatchObject({ connected: false, reason: 'token_rejected' });
    expect(JSON.stringify(result)).not.toContain(wrong);
    expect(bridge.session().present).toBe(false);
    expect((await bridge.adapter.run(call('jugaad_pulse'), ctx)).resultCategory).toBe('jugaad_not_connected');
    expect(bridge.adapter.health().state).toBe('authorization_required');
  });

  it('refuses malformed tokens and serials locally, before any adb call', async () => {
    const { runner, calls } = fakePhone();
    const bridge = createJugaadBridge({ runner });
    for (const bad of ['short', `${TOKEN}; rm -rf /`, `${TOKEN}\nexit`, "tok'en".padEnd(20, 'a'), '']) {
      expect(await bridge.connect(SERIAL, bad)).toMatchObject({ connected: false, reason: 'token_rejected' });
    }
    expect(await bridge.connect('x; reboot', TOKEN)).toMatchObject({ connected: false });
    expect(calls).toHaveLength(0);
  });

  it('reports a disabled bridge distinctly from a rejected token', async () => {
    const { runner } = fakePhone({ enabled: false });
    expect(await createJugaadBridge({ runner }).connect(SERIAL, TOKEN)).toMatchObject({ connected: false, reason: 'bridge_disabled' });
  });

  it('serves pulse, a deterministic spend summary, and recovered-receipt counts', async () => {
    const { runner } = fakePhone();
    const bridge = createJugaadBridge({ runner });
    await bridge.connect(SERIAL, TOKEN);

    const pulse = await bridge.adapter.run(call('jugaad_pulse'), ctx);
    expect(pulse.status).toBe('succeeded');
    expect(JSON.parse(pulse.output)).toMatchObject({ status: 'WATCH', daysLeft: 9 });

    const expenses = await bridge.adapter.run(call('jugaad_expenses', { from: '2026-10-01', to: '2026-10-31' }), ctx);
    const parsed = JSON.parse(expenses.output);
    expect(parsed.summary).toMatchObject({ transactionsCounted: 2, excludedTransactions: 1, sumOfAmountsByCurrency: { EUR: 49.75 }, complete: true });
    expect(Object.keys(parsed)[0]).toBe('summary');

    const vault = await bridge.adapter.run(call('jugaad_vault'), ctx);
    expect(JSON.parse(vault.output)).toMatchObject({ recoveredReceipts: 3, total: 5 });
  });

  it('flags a partial expense page instead of presenting it as the whole', async () => {
    const { runner } = fakePhone({ expenses: { ok: true, total: 500, returned: 1, items: [{ id: 1, amount: 5, currency: 'EUR', excluded: false }] } });
    const bridge = createJugaadBridge({ runner });
    await bridge.connect(SERIAL, TOKEN);
    const out = JSON.parse((await bridge.adapter.run(call('jugaad_expenses'), ctx)).output);
    expect(out.summary.complete).toBe(false);
    expect(out.summary.note).toMatch(/PARTIAL/);
  });

  it('only ever sends read methods, and rejects injection-shaped arguments without calling adb', async () => {
    const { runner, calls } = fakePhone();
    const bridge = createJugaadBridge({ runner });
    await bridge.connect(SERIAL, TOKEN);
    const before = calls.length;
    for (const args of [{ from: '2026-10-01; reboot', to: '2026-10-31' }, { from: '2026-10-01' }]) {
      expect((await bridge.adapter.run(call('jugaad_expenses', args), ctx)).resultCategory).toBe('invalid_arguments');
    }
    expect((await bridge.adapter.run(call('jugaad_vault', { sourceType: 'x; id' }), ctx)).resultCategory).toBe('invalid_arguments');
    expect((await bridge.adapter.run(call('jugaad_delete_everything'), ctx)).resultCategory).toBe('capability_unknown_tool');
    expect(calls.length).toBe(before);

    await bridge.adapter.run(call('jugaad_pulse'), ctx);
    await bridge.adapter.run(call('jugaad_expenses'), ctx);
    await bridge.adapter.run(call('jugaad_vault', { sourceType: 'RECOVERED' }), ctx);
    const methods = calls.map((c) => /--method (\w+)/.exec(c.stdin)?.[1]).filter(Boolean);
    expect(new Set(methods)).toEqual(new Set(['status', 'pulse', 'expenses', 'vault']));
    expect(bridge.adapter.definitions().every((d) => bridge.adapter.classify(d.name) === 'read_only')).toBe(true);
  });

  it('never leaks the token even if adb echoes it back', async () => {
    const leaky: AdbRunner = async (_args, opts) => {
      if (/--method status/.test(opts?.stdin ?? '')) return { code: 0, timedOut: false, stderr: '', stdout: bundle({ ok: true, bridgeEnabled: true, authorized: true }) };
      return { code: 1, timedOut: false, stdout: '', stderr: `weird failure for ${TOKEN} here` };
    };
    const bridge = createJugaadBridge({ runner: leaky });
    await bridge.connect(SERIAL, TOKEN);
    const result = await bridge.adapter.run(call('jugaad_pulse'), ctx);
    expect(result.status).toBe('failed');
    expect(result.output).not.toContain(TOKEN);
    expect(result.output).toContain('[redacted]');
  });

  it('marks health authorization_required once the phone revokes, and disconnect erases the session', async () => {
    let revoked = false;
    const { runner: base } = fakePhone();
    const runner: AdbRunner = (a, o) => base(a, revoked ? { ...o, stdin: (o?.stdin ?? '').replace(TOKEN, 'b'.repeat(64)) } : o);
    const bridge = createJugaadBridge({ runner });
    await bridge.connect(SERIAL, TOKEN);
    expect(bridge.adapter.health().state).toBe('available');
    revoked = true;
    const result = await bridge.adapter.run(call('jugaad_pulse'), ctx);
    expect(result.status).toBe('failed');
    expect(bridge.adapter.health().state).toBe('authorization_required');
    bridge.disconnect();
    expect(bridge.session()).toEqual({ present: false, serial: null });
    expect((await bridge.verify()).reason).toBe('no_session');
  });

  it('lists devices for the picker', async () => {
    const { runner } = fakePhone();
    const { devices } = await createJugaadBridge({ runner }).listDevices();
    expect(devices.map((d) => d.serial)).toEqual(['R3CXB0K5SEF', 'emulator-5554']);
  });
});
