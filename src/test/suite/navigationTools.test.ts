import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { ToolRegistry } from '../../tools/ToolRegistry';
import { TOOL_SCHEMAS } from '../../tools/ToolSchemas';
import { PolicyEngine } from '../../policy/PolicyEngine';

const NAV = ['find_relevant', 'find_references', 'impact_analysis', 'repo_map'];
let root = '';

async function write(files: Record<string, string>): Promise<void> {
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(root, rel);
    await fs.mkdir(path.dirname(full), { recursive: true });
    await fs.writeFile(full, content.replace(/\n/g, '\r\n')); // Windows checkout
  }
}

async function run(name: string, args: Record<string, unknown>): Promise<{ ok: boolean; text: string }> {
  const tool = ToolRegistry.get(name)!;
  const result = await tool.execute(args, { workspaceRoot: root, sessionId: 's', turnId: 't', model: 'm', mode: 'ask' });
  return result.ok ? { ok: true, text: String(result.data) } : { ok: false, text: result.error };
}

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'kkd-navtools-'));
  await write({
    'package.json': '{"name":"demo","main":"src/index.ts"}',
    'src/index.ts': "import { submit } from './form';\nexport function main() { return submit('x'); }\n",
    'src/form.ts': "import { validate } from './validator';\nexport function submit(v: string) { return validate(v); }\n",
    'src/validator.ts': 'export function validate(v: string) { return v.length > 0; }\n',
    'src/validator.test.ts': "import { validate } from './validator';\ntest('v', () => validate('a'));\n",
  });
  execFileSync('git', ['init', '-q'], { cwd: root });
  execFileSync('git', ['add', '-A'], { cwd: root });
  execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'x'], { cwd: root, stdio: 'ignore' });
});
afterEach(async () => { await fs.rm(root, { recursive: true, force: true }); });

describe('repository navigation tools (Saath Kar / Karke Dikha)', () => {
  it('are registered, read-only, and offered in read-only modes', () => {
    for (const name of NAV) {
      const tool = ToolRegistry.get(name)!;
      expect(tool, name).toBeDefined();
      expect(tool.riskLevel).toBe('safe');
      expect(tool.mutatesWorkspace).toBe(false);
      expect(ToolRegistry.schemasForMode('ask').some(s => s.function.name === name)).toBe(true);
    }
  });

  it('stay cheap for small local models: the four schemas fit in ~1K tokens', () => {
    const chars = JSON.stringify(TOOL_SCHEMAS.filter(s => NAV.includes(s.function.name))).length;
    expect(chars / 3.5).toBeLessThan(1000); // vs ~8K tokens for Serena's 22-tool MCP surface
  });

  it('find_relevant ranks files for a topic by stemmed words and lists the matching symbols with lines', async () => {
    const result = await run('find_relevant', { topic: 'Where is the validation logic?' });
    expect(result.ok).toBe(true);
    expect(result.text.split('\n')[0]).toContain('src/validator.ts');
    expect(result.text).toContain('validate:1');
  });

  it('find_references lists exact call sites without file bodies (CRLF workspace)', async () => {
    const result = await run('find_references', { symbol: 'validate' });
    expect(result.text).toContain('defined at src/validator.ts:1');
    expect(result.text).toContain('src/form.ts:2');
    expect(result.text).toContain('src/validator.test.ts');
    expect(result.text).not.toContain('\r');
  });

  it('impact_analysis names dependents and the tests to run', async () => {
    const result = await run('impact_analysis', { target: 'src/validator.ts' });
    expect(result.text).toContain('Directly affected');
    expect(result.text).toContain('src/form.ts');
    expect(result.text).toContain('src/index.ts'); // indirect, through form.ts
    expect(result.text).toContain('Tests to run');
    expect(result.text).toContain('src/validator.test.ts');
  });

  it('repo_map is a compact, bounded orientation', async () => {
    const result = await run('repo_map', { budgetTokens: 300 });
    expect(result.ok).toBe(true);
    expect(result.text).toContain('src/validator.ts: validate');
    expect(result.text.length / 3.5).toBeLessThan(330);
  });

  it('see a file created after the index was built (fresh results, no re-index step)', async () => {
    await run('find_references', { symbol: 'validate' }); // builds the index
    await write({ 'src/audit.ts': "import { validate } from './validator';\nexport const audit = () => validate('z');\n" });
    const result = await run('find_references', { symbol: 'validate' });
    expect(result.text).toContain('src/audit.ts:2'); // untracked, never `git add`ed
  });

  it('are on the read-only policy list (no approval prompt)', () => {
    for (const name of NAV) expect(new PolicyEngine().evaluate(name, { symbol: 'x' }, 'ask').action).toBe('allow-once');
  });
});
