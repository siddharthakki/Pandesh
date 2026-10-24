import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { buildWorkspaceInventory, isInventoryQuestion } from '../../repository/WorkspaceInventory';

describe('isInventoryQuestion', () => {
  it('recognises workspace inventory phrasing', () => {
    for (const q of [
      'Summarize what projects are there in this folder.',
      'what projects are in this workspace?',
      'list the apps in this repo',
      'What is in this workspace?',
      'what is in this folder',
      'repository structure',
      'show me the structure of this repo',
      'which packages do we have here',
    ]) expect(isInventoryQuestion(q), q).toBe(true);
  });

  it('leaves ordinary questions alone', () => {
    for (const q of ['summarize this project', 'what does the router do?', 'explain README.md', 'how do I add a package', 'what is 2 + 2']) expect(isInventoryQuestion(q), q).toBe(false);
  });
});

describe('buildWorkspaceInventory', () => {
  let root = '';
  const write = (rel: string, content: string) => {
    const full = path.join(root, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  };
  beforeAll(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'inv-'));
    write('apps/web/package.json', JSON.stringify({ name: 'web-app', description: 'The web UI', dependencies: { react: '1' } }));
    write('apps/web/README.md', '# Web\n\nA small React front end for the dashboard.');
    write('apps/api/pyproject.toml', '[project]\nname = "api-svc"\ndescription = "REST backend"\n');
    write('tools/scraper/a.py', 'x=1');
    write('tools/scraper/b.py', 'y=2');
    write('docs/guide.md', '# Guide');
    write('node_modules/pkg/package.json', '{"name":"noise"}');
    write('README.md', '# Mono\n');
  });
  afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

  it('returns a project inventory from manifests, not a sample of source files', async () => {
    const inventory = await buildWorkspaceInventory(root, 20_000);
    expect(inventory).toBeDefined();
    const prompt = inventory!.prompt;
    expect(prompt).toContain('apps/web');
    expect(prompt).toContain('web-app');
    expect(prompt).toContain('A small React front end');
    expect(prompt).toContain('apps/api');
    expect(prompt).toContain('api-svc');
    expect(prompt).toContain('tools/scraper');
    expect(prompt).toMatch(/docs\/ — folder, not a recognised project/);
    expect(prompt).not.toContain('noise');
    expect(inventory!.projectCount).toBe(3);
    expect(inventory!.files.map(f => f.path)).toContain('apps/web/package.json');
  });

  it('stays within the budget', async () => {
    const inventory = await buildWorkspaceInventory(root, 2_000);
    expect(inventory!.prompt.length).toBeLessThan(4_500);
  });
});
