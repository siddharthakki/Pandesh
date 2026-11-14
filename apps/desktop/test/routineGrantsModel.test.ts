import { describe, expect, it } from 'vitest';
import { confirmText, describeLimits, statusLabel, type GrantCatalog, type GrantRow } from '../renderer-v2/src/grantModel';

const cat: GrantCatalog = { routines: [], operations: ['write_file'], caps: { maxFiles: 16 }, defaults: { maxFiles: 8, maxBytesPerFile: 65536, maxTotalBytes: 262144 } };
const row = (o: Partial<GrantRow> = {}): GrantRow => ({ taskId: 't', title: 'Daily count', instruction: 'x', dailyTime: '03:18', folder: 'C:\w\b', access: 'read_write', grantable: true, status: 'none', active: null, ...o });

describe('standing write permission panel model', () => {
  it('shows exact limits in plain words', () => { expect(describeLimits(cat.defaults)).toBe('up to 8 files per run, 64 KB per file, 256 KB in total'); });
  it('states each status honestly, including a permission that ended after a change', () => {
    expect(statusLabel(row()).tone).toBe('off');
    expect(statusLabel(row({ status: 'active' }))).toMatchObject({ tone: 'ok' });
    expect(statusLabel(row({ status: 'stale' })).text).toMatch(/changed.*Grant again/);
    expect(statusLabel(row({ grantable: false })).text).toMatch(/no writable folder/);
  });
  it('the confirmation names the routine, folder, operation, limits and what is never covered', () => {
    const t = confirmText(row(), cat).join('\n');
    for (const need of ['Daily count', 'C:\w\b', 'Create or replace a file', '8 files', 'shell commands', 'deleting', 'sending messages', 'calendar', 'ends and asks again', 'take it back']) expect(t).toContain(need);
  });
});
