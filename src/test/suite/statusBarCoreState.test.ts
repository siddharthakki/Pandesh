import { describe, expect, it, vi } from 'vitest';

const item = { text: '', tooltip: '', command: '', backgroundColor: undefined as unknown, show: vi.fn(), dispose: vi.fn() };

vi.mock('vscode', () => ({
  window: { createStatusBarItem: () => item },
  StatusBarAlignment: { Left: 1 },
  ThemeColor: class { constructor(readonly id: string) {} },
}));

import { StatusBarController } from '../../ui/StatusBarController';

describe('status bar Core state', () => {
  it('offers Start/Retry while Core is unavailable, never overwrites it with idle/running, and restores chat on connect', () => {
    const bar = new StatusBarController();
    expect(item.command).toBe('ollama-agent.openChat');

    bar.setCoreStatus({ state: 'unavailable' });
    expect(item.text).toContain('Core offline');
    expect(item.command).toBe('ollama-agent.restartKarkeDikhaCore');
    expect(String(item.tooltip)).toMatch(/Diagnostics, diffs and previews still work/);

    bar.setIdle();
    bar.setRunning('model');
    bar.setError();
    expect(item.text).toContain('Core offline');

    bar.setCoreStatus({ state: 'starting' });
    expect(item.text).toContain('Core starting');

    bar.setCoreStatus({ state: 'connected' });
    expect(item.text).toBe('$(robot) KarkeDikha');
    expect(item.command).toBe('ollama-agent.openChat');
    bar.setRunning('m');
    expect(item.text).toContain('KarkeDikha: m');
  });
});
