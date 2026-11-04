import { describe, expect, it } from 'vitest';
import { createJugaadDeviceCapabilityAdapter, parseBridgeReply, visibleTextFromDump, type AdbRunner } from '../runtime/jugaadDeviceCapability';
import type { ModelToolCall } from '../runtime/modelBackend';

const ctx = {} as never;
const call = (name: string, args: Record<string, unknown> = {}): ModelToolCall => ({ id: 't', name, arguments: args } as ModelToolCall);

function runner(reply: string, seen: string[][] = []): AdbRunner {
  return async (args) => { seen.push(args); return { ok: true, stdout: reply, stderr: '' }; };
}

describe('JUGAAD device capability', () => {
  it('classifies reads as read_only and UI input as consequential', () => {
    const a = createJugaadDeviceCapabilityAdapter({ serial: 'ABC123' });
    for (const t of ['jugaad_status', 'jugaad_pulse', 'jugaad_expenses', 'jugaad_vault', 'jugaad_ui_read']) expect(a.classify(t)).toBe('read_only');
    for (const t of ['jugaad_ui_tap', 'jugaad_ui_swipe', 'jugaad_ui_back']) expect(a.classify(t)).toBe('consequential');
  });

  it('refuses to guess a device when no serial is configured', async () => {
    const prev = process.env.JUGAAD_ADB_SERIAL; delete process.env.JUGAAD_ADB_SERIAL;
    const seen: string[][] = [];
    const a = createJugaadDeviceCapabilityAdapter({ token: 't', runAdb: runner('', seen) });
    const r = await a.run(call('jugaad_pulse'), ctx);
    if (prev !== undefined) process.env.JUGAAD_ADB_SERIAL = prev;
    expect(r.resultCategory).toBe('device_not_selected');
    expect(seen).toHaveLength(0);
  });

  it('requires the pairing token for private data and never runs adb without it', async () => {
    const seen: string[][] = [];
    const a = createJugaadDeviceCapabilityAdapter({ serial: 'ABC123', token: '', runAdb: runner('', seen) });
    const r = await a.run(call('jugaad_expenses'), ctx);
    expect(r.resultCategory).toBe('authorization_required');
    expect(seen).toHaveLength(0);
  });

  it('maps bridge refusals to authorization_required', async () => {
    const a = createJugaadDeviceCapabilityAdapter({ serial: 'ABC123', token: 'x', runAdb: runner('Result: Bundle[{json={"ok":false,"error":"unauthorized"}}]') });
    expect((await a.run(call('jugaad_pulse'), ctx)).resultCategory).toBe('authorization_required');
  });

  it('targets the named device and passes the token as the provider arg, not as a tool argument', async () => {
    const seen: string[][] = [];
    const a = createJugaadDeviceCapabilityAdapter({ serial: 'ABC123', token: 'secret', runAdb: runner('Result: Bundle[{json={"ok":true,"total":1,"items":[{"a":1}]}}]', seen) });
    const r = await a.run(call('jugaad_vault', { sourceType: 'RECOVERED', limit: 10 }), ctx);
    expect(r.status).toBe('succeeded');
    expect(seen[0].slice(0, 2)).toEqual(['-s', 'ABC123']);
    expect(seen[0]).toContain('sourceType:s:RECOVERED');
    expect(r.output).not.toContain('secret');
  });

  it('validates arguments before touching the device', async () => {
    const seen: string[][] = [];
    const a = createJugaadDeviceCapabilityAdapter({ serial: 'ABC123', token: 'x', runAdb: runner('', seen) });
    expect((await a.run(call('jugaad_expenses', { from: '2026-1-1' }), ctx)).resultCategory).toBe('invalid_arguments');
    expect((await a.run(call('jugaad_vault', { sourceType: 'a; rm -rf' }), ctx)).resultCategory).toBe('invalid_arguments');
    expect((await a.run(call('jugaad_ui_tap', { x: -1, y: 5 }), ctx)).resultCategory).toBe('invalid_arguments');
    expect(seen).toHaveLength(0);
  });

  it('parses payloads containing braces and extracts visible UI text', () => {
    expect(parseBridgeReply('Result: Bundle[{json={"ok":true,"n":{"x":1}}}]')).toEqual({ ok: true, n: { x: 1 } });
    const xml = '<node index="0" text="Safe &amp; sound" resource-id="" class="x" content-desc="" bounds="[1,2][3,4]" />';
    expect(visibleTextFromDump(xml)).toEqual(['[1,2][3,4] Safe & sound']);
  });
});
