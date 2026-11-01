import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { OPENCODE_PERMISSION, withPandeshPermissions, openCodeEnv } from '../runtime/opencodeEngine';

describe('OpenCode permission boundary', () => {
  it('denies everything Pandesh cannot approve and allows only workspace edits', () => {
    expect(OPENCODE_PERMISSION).toMatchObject({
      bash: 'deny',
      external_directory: 'deny',
      webfetch: 'deny',
      websearch: 'deny',
      task: 'deny',
      execute: 'deny',
      browser: 'deny',
      edit: 'allow',
    });
    const allowed = Object.entries(OPENCODE_PERMISSION).filter(([, v]) => v !== 'deny').map(([k]) => k);
    expect(allowed).toEqual(['edit']);
  });

  it('pins every built-in agent to the policy so no agent can widen it', () => {
    const config = withPandeshPermissions({ model: 'ollama/x' }) as any;
    expect(config.permission).toBe(OPENCODE_PERMISSION);
    for (const name of ['build', 'plan', 'general', 'explore']) {
      expect(config.agent[name].permission).toBe(OPENCODE_PERMISSION);
    }
  });

  it('never loads the global OpenCode config and carries the policy inline', () => {
    const config = withPandeshPermissions({});
    const env = openCodeEnv('/ws', config);
    expect(env.XDG_CONFIG_HOME).toContain('pandesh-opencode-config');
    expect(JSON.parse(env.OPENCODE_CONFIG_CONTENT!).permission.bash).toBe('deny');
  });

  it('never launches OpenCode with auto-approval', () => {
    const source = fs.readFileSync(path.join(__dirname, '..', 'runtime', 'opencodeEngine.ts'), 'utf8');
    expect(source).not.toMatch(/'--auto'|--dangerously-skip-permissions/);
    expect(source).not.toMatch(/bash:\s*'allow'/);
  });
});
