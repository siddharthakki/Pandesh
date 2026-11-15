import { describe, expect, it } from 'vitest';
import { maskSecrets } from '../shared/secretMask';
import { sanitizeToolActivity } from '../shared/toolActivity';

describe('secret masking', () => {
  it('masks tokens, keys, passwords and URL credentials, and says it did', () => {
    const cases = [
      'curl -H "Authorization: Bearer abcdef1234567890abcdef" https://x.test',
      'export OPENAI_API_KEY=sk-abcdefghijklmnopqrstuvwxyz123456',
      'token: ghp_abcdefghijklmnopqrstuvwxyz0123456789',
      'git clone https://user:hunter2pass@example.com/repo.git',
      'GET https://api.test/v1?access_token=abc123def456&page=2',
      'password = "correct horse battery"',
      'key AIzaSyA-abcdefghijklmnopqrstuvwxyz012345',
    ];
    for (const c of cases) {
      const r = maskSecrets(c);
      expect(r.masked, c).toBe(true);
      expect(r.text, c).toContain('••••');
    }
    expect(maskSecrets('curl -H "Authorization: Bearer abcdef1234567890abcdef" x').text).not.toMatch(/abcdef1234567890abcdef/);
    expect(maskSecrets('git clone https://user:hunter2pass@example.com/r.git').text).toBe('git clone https://user:••••@example.com/r.git');
    expect(maskSecrets('GET https://api.test/v1?access_token=abc123def456&page=2').text).toBe('GET https://api.test/v1?access_token=••••&page=2');
  });
  it('leaves ordinary text, paths and keys-without-values alone', () => {
    for (const t of ['npm test -- --run core/test/foo.test.ts', 'Read C:/work/readme.md (12 lines)', 'the token economy of a password manager', 'const key = items.length;', '12 passed, 0 failed']) {
      expect(maskSecrets(t), t).toEqual({ text: t, masked: false });
    }
  });
  it('is applied when a tool activity is stored, so a command or excerpt never carries the secret', () => {
    const a = sanitizeToolActivity({ kind: 'code', command: 'curl -H "Authorization: Bearer abcdef1234567890abcdef" https://x.test', excerpt: 'API_KEY=sk-abcdefghijklmnopqrstuvwxyz123456\nok', url: 'https://x.test/p?token=abc123def456' })!;
    expect(a.command).toContain('Bearer ••••');
    expect(a.excerpt).toContain('API_KEY=••••');
    expect(a.url).toContain('token=••••');
    expect(JSON.stringify(a)).not.toMatch(/abcdef1234567890abcdef|sk-abcdefghijkl|abc123def456/);
  });
});
