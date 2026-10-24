import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { SemanticCodeIndex } from '../../intelligence/SemanticCodeIndex';

describe('semantic code intelligence', () => {
  let root: string;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'oa-semantic-'));
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it('indexes symbols incrementally and ranks likely tests', async () => {
    await fs.mkdir(path.join(root, 'src'), { recursive: true });
    await fs.mkdir(path.join(root, 'test'), { recursive: true });
    await fs.writeFile(path.join(root, 'src', 'Calculator.ts'), 'export class Calculator { add(a: number, b: number) { return a + b; } }', 'utf8');
    await fs.writeFile(path.join(root, 'test', 'Calculator.test.ts'), 'const calculatorTest = true;', 'utf8');

    const index = new SemanticCodeIndex(root);
    const first = await index.refresh();
    const second = await index.refresh();
    const result = index.search('Calculator')[0];

    expect(first.indexed).toBe(2);
    expect(second.unchanged).toBe(2);
    expect(result.symbol.name).toBe('Calculator');
    expect(result.likelyTests).toContain('test/Calculator.test.ts');
  });
});
