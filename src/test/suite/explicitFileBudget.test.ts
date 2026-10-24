import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { RepoFastPath } from '../../repository/RepoFastPath';
import { buildWorkspaceInventory, wantsFullInventory } from '../../repository/WorkspaceInventory';

describe('explicit file audit takes the named file first', () => {
  let root = '';
  const write = (rel: string, content: string) => {
    const full = path.join(root, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  };
  beforeAll(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'explicit-'));
    // ~290 lines, ~17K chars: larger than 65% of an 18K packet, smaller than the explicit-file allowance.
    const readme = ['# Demo', '', ...Array.from({ length: 288 }, (_, i) => `Line ${i + 1}: this documents behaviour number ${i + 1} of the demo tool in some detail.`)].join('\n');
    write('README.md', readme);
    write('package.json', JSON.stringify({ name: 'demo', scripts: { build: 'tsc' } }));
    write('src/index.ts', 'export const x = 1;\n');
  });
  afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

  it('includes a 290-line README whole when the packet allows it', async () => {
    const result = await new RepoFastPath(root).repoQuery('Is the readme up to date?', { maxChars: 30_000 });
    expect(result).toBeDefined();
    expect(result!.explicitFiles).toEqual(['README.md']);
    expect(result!.prompt).toMatch(/README\.md \[full file, 290 lines/);
    expect(result!.prompt).toContain('Line 288:');
    expect(result!.prompt).not.toContain('NOT included');
  });

  it('states exactly which lines were left out when the file cannot fit', async () => {
    const result = await new RepoFastPath(root).repoQuery('Is the readme up to date?', { maxChars: 8_000 });
    expect(result!.prompt).toMatch(/large file, structured excerpt of 290 lines/);
    expect(result!.prompt).toMatch(/NOT included: lines \d+-290/);
    expect(result!.prompt).toContain('Do not claim to have verified');
  });
});

describe('compact workspace inventory', () => {
  let root = '';
  const write = (rel: string, content: string) => {
    const full = path.join(root, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  };
  beforeAll(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'compact-'));
    for (let i = 1; i <= 9; i++) write(`work/proj${i}/package.json`, JSON.stringify({ name: `proj-${i}`, description: `Project number ${i}` }));
    write('apps/readme-only/README.md', '# Readme Only\n\nA project that only has a README file inside it.');
    write('experiments/loose/a.py', 'x=1');
    write('experiments/loose/b.py', 'y=2');
  });
  afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

  it('summarises areas and representatives, and says more exist', async () => {
    const compact = await buildWorkspaceInventory(root, 20_000);
    expect(compact!.prompt).toMatch(/- work\/ — 9 projects/);
    expect(compact!.prompt).toMatch(/\+6 more in work\/ not listed/);
    expect(compact!.omittedProjects).toBe(6);
    expect(compact!.prompt).toContain('ask for the full inventory');
    expect(compact!.prompt).not.toContain('proj9');
  });

  it('ranks manifest and README markers above the source-file fallback', async () => {
    const compact = await buildWorkspaceInventory(root, 20_000);
    expect(compact!.prompt).toContain('9 by manifest, 1 by README, 1 inferred from source files only');
    expect(compact!.prompt).toMatch(/apps\/readme-only — .*README, no manifest/);
    expect(compact!.prompt).toMatch(/experiments\/loose — .*inferred from source files only/);
  });

  it('lists everything when the user asks for the full inventory', async () => {
    expect(wantsFullInventory('give me the full inventory')).toBe(true);
    expect(wantsFullInventory('list all projects in this folder')).toBe(true);
    expect(wantsFullInventory('summarize projects in this folder')).toBe(false);
    const full = await buildWorkspaceInventory(root, 20_000, { full: true });
    expect(full!.prompt).toContain('work/proj9');
    expect(full!.omittedProjects).toBe(0);
  });
});
