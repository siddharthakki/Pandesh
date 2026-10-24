import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { ValidationSideEffectDetector } from '../../coding/ExecutionIntegrity';

describe('ValidationSideEffectDetector', () => {
  let root = '';

  afterEach(async () => {
    if (root) {
      await fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
      root = '';
    }
  });

  it('allows generated VSIX packages but still detects unapproved source changes', async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'oa-validation-side-effects-'));
    await fs.mkdir(path.join(root, 'src'), { recursive: true });
    await fs.writeFile(path.join(root, 'src', 'existing.ts'), 'export {};\n', 'utf8');

    const detector = new ValidationSideEffectDetector(root, ['docs/approved.md']);
    await detector.capture();

    await fs.writeFile(path.join(root, 'karkedikha-win32-x64.vsix'), 'generated package', 'utf8');
    await expect(detector.detect()).resolves.toEqual([]);

    await fs.writeFile(path.join(root, 'src', 'unapproved.ts'), 'export const changed = true;\n', 'utf8');
    await expect(detector.detect()).resolves.toEqual(['src/unapproved.ts']);
  });

  it('can rebind after an authorized repair and still catches validation side effects', async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'oa-validation-repair-side-effects-'));
    await fs.mkdir(path.join(root, 'src'), { recursive: true });
    await fs.mkdir(path.join(root, '.ollama-agent'), { recursive: true });
    await fs.writeFile(path.join(root, 'src', 'approved.ts'), 'initial\n', 'utf8');
    await fs.writeFile(path.join(root, '.ollama-agent', 'transaction.json'), 'initial\n', 'utf8');

    const detector = new ValidationSideEffectDetector(root, ['src/approved.ts']);
    await detector.capture();
    await fs.writeFile(path.join(root, 'src', 'approved.ts'), 'repaired\n', 'utf8');
    await fs.writeFile(path.join(root, '.ollama-agent', 'transaction.json'), 'repair-complete\n', 'utf8');

    // Governed repair activity becomes the new pre-validation baseline.
    await detector.capture();
    await expect(detector.detect()).resolves.toEqual([]);

    await fs.writeFile(path.join(root, 'src', 'validation-side-effect.ts'), 'unexpected\n', 'utf8');
    await expect(detector.detect()).resolves.toEqual(['src/validation-side-effect.ts']);
  });
});
