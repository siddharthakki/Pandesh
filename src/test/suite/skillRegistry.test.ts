import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { SkillRegistry } from '../../extensibility/SkillRegistry';

describe('progressive skill registry', () => {
  let root: string;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'oa-skills-'));
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it('selects metadata before loading full instructions', async () => {
    const directory = path.join(root, 'typescript-review');
    await fs.mkdir(path.join(directory, 'references'), { recursive: true });
    await fs.writeFile(path.join(directory, 'SKILL.md'), [
      '---',
      'id: typescript-review',
      'name: TypeScript Review',
      'description: Review TypeScript changes',
      'version: 1.0.0',
      'tags: typescript, review',
      'tools: read_file@read',
      '---',
      'Inspect types and tests.',
    ].join('\n'), 'utf8');
    await fs.writeFile(path.join(directory, 'references', 'guide.md'), 'Reference', 'utf8');

    const registry = new SkillRegistry({
      roots: [{ scope: 'repository', directory: root, trusted: false }],
    });
    await registry.refresh();
    const selected = registry.select({ query: 'typescript review', allowedAccess: ['read'] });
    const loaded = await registry.load(selected[0].id, selected[0].checksum);

    expect(selected[0].id).toBe('typescript-review');
    expect(loaded.instructions).toContain('Inspect types');
    expect(loaded.references).toContain('references/guide.md');
  });
});
