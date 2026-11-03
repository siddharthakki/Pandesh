import { describe, expect, it } from 'vitest';
import {
  authorizeDesktopTaskScope,
  describeDesktopTaskScope,
} from '../src/host/desktopTaskScope';
import { RENDERER_VISIBLE_KEYS } from '../src/ipc';

describe('desktop task scope', () => {
  const scope = authorizeDesktopTaskScope(describeDesktopTaskScope('C:\\\\tmp\\\\tip-calculator')!);

  it('shows repository, permitted actions, and local-commit delivery', () => {
    expect(scope.repository).toContain('tip-calculator');
    expect(scope.permittedActions.join(' ')).toMatch(/read_file/);
    expect(scope.permittedActions.join(' ')).toMatch(/propose_file_change/);
    expect(scope.permittedActions.join(' ')).toMatch(/inspect_page/);
    expect(scope.deliveryDestination).toMatch(/local git commit/);
    expect(scope.pushAuthorized).toBe(false);
    expect(scope.authorized).toBe(true);
  });

  it('gives the host no approval authority: no auto-approve classifier is exported', async () => {
    const mod = await import('../src/host/desktopTaskScope');
    expect(Object.keys(mod).sort()).toEqual(['DESKTOP_PERMITTED_ACTIONS', 'authorizeDesktopTaskScope', 'describeDesktopTaskScope']);
  });
});

describe('desktop snapshot contract', () => {
  it('exposes task scope without leaking Core envelope secrets', () => {
    expect(RENDERER_VISIBLE_KEYS).toContain('taskScope');
    expect(RENDERER_VISIBLE_KEYS.join(',')).not.toMatch(/token|digest|frozenContextHash|authorization/i);
  });
});
