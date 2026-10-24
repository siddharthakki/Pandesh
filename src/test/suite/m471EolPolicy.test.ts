import { describe, expect, it } from 'vitest';
import { describeEolDifferences, detectEol, isEolOnlyDifference, normalizeEol } from '../../coding/EolPolicy';

/**
 * Logical text equivalence is not byte identity. These helpers only classify; they never rewrite content, so a
 * repository's line endings are never normalised and a user's endings are never changed.
 */
describe('EolPolicy', () => {
  it('classifies line endings', () => {
    expect(detectEol('')).toBe('none');
    expect(detectEol('one line')).toBe('none');
    expect(detectEol('a\nb\n')).toBe('lf');
    expect(detectEol('a\r\nb\r\n')).toBe('crlf');
    expect(detectEol('a\r\nb\n')).toBe('mixed');
    expect(detectEol('a\rb')).toBe('mixed');
    expect(detectEol(Buffer.from('a\r\n'))).toBe('crlf');
  });

  it('separates an EOL-only difference from identical and from genuinely different content', () => {
    expect(isEolOnlyDifference('LINE1\nLINE2\n', 'LINE1\r\nLINE2\r\n')).toBe(true);
    expect(isEolOnlyDifference(Buffer.from('a\r\n'), Buffer.from('a\n'))).toBe(true);
    // Byte identical is NOT a difference.
    expect(isEolOnlyDifference('a\n', 'a\n')).toBe(false);
    // A real content change hidden behind an EOL change is still a content change.
    expect(isEolOnlyDifference('LINE1\nLINE2\n', 'LINE1\r\nLINE3\r\n')).toBe(false);
    // Trailing-newline presence is content, not rendering.
    expect(isEolOnlyDifference('a\n', 'a')).toBe(false);
  });

  it('does not modify its inputs and normalisation is read-only', () => {
    const original = 'a\r\nb\r\n';
    expect(normalizeEol(original)).toBe('a\nb\n');
    expect(original).toBe('a\r\nb\r\n');
  });

  it('describes differences in one sentence, bounded, naming the Git policy', () => {
    const differences = Array.from({ length: 7 }, (_, index) => ({ path: `f${index}.txt`, validated: 'lf' as const, delivered: 'crlf' as const }));
    const sentence = describeEolDifferences(differences, 'core.autocrlf=true');
    expect(sentence).toContain('only in line endings');
    expect(sentence).toContain('f0.txt (validated lf, delivered crlf)');
    expect(sentence).toContain('and 2 more');
    expect(sentence).not.toContain('f6.txt');
    expect(sentence).toContain('core.autocrlf=true');
    expect(describeEolDifferences([])).toBe('');
  });
});

import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { spawnSync } from 'child_process';
import { afterEach, beforeEach } from 'vitest';
import { conformContentToExistingEol } from '../../coding/EolPolicy';
import { WorkspaceMutationEngine, WorkspaceSnapshotBinder } from '../../coding/WorkspaceMutation';
import { CODING_PROPOSAL_VERSION, type CodingProposal } from '../../coding/CodingProposal';

describe('conformContentToExistingEol (pure)', () => {
  const crlf = Buffer.from('a\r\nb\r\nc\r\n');
  it('keeps a consistently CRLF file CRLF when replaced with consistently LF text', () => {
    expect(conformContentToExistingEol('a\nB\nc\n', crlf)).toEqual({ content: 'a\r\nB\r\nc\r\n', conformed: true });
  });
  it('leaves everything else alone', () => {
    expect(conformContentToExistingEol('a\nb\n', Buffer.from('a\nb\n')).conformed).toBe(false);          // existing is LF
    expect(conformContentToExistingEol('a\nb\n', Buffer.from('a\r\nb\n')).conformed).toBe(false);        // existing is mixed
    expect(conformContentToExistingEol('a\r\nb\r\n', crlf).conformed).toBe(false);                       // already CRLF
    expect(conformContentToExistingEol('a\r\nb\n', crlf).conformed).toBe(false);                         // content is mixed
    expect(conformContentToExistingEol('single line', crlf).conformed).toBe(false);                      // no line breaks
  });
  it('honours a task that is itself about line endings', () => {
    expect(conformContentToExistingEol('a\nb\n', crlf, 'Convert this file to LF line endings').conformed).toBe(false);
    expect(conformContentToExistingEol('a\nb\n', crlf, 'run dos2unix on config').conformed).toBe(false);
  });
});

/** Windows-focused: real git, core.autocrlf=false so a flipped EOL is a visible whole-file change. */
describe('replacing a CRLF file (real git, autocrlf=false)', () => {
  let root: string;
  const git = (...args: string[]) => spawnSync('git', args, { cwd: root, encoding: 'utf8' });
  const proposal = (operations: CodingProposal['operations'], taskSummary = 'Update the greeting'): CodingProposal => ({
    version: CODING_PROPOSAL_VERSION,
    taskSummary,
    operations,
    validationCommands: [],
    limits: { maxFiles: 10, maxBytesPerFile: 100_000, totalBytes: 1_000_000 },
    warnings: [],
    status: 'proposed',
  });

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'oa-eol-'));
    git('init');
    git('config', 'user.email', 't@example.com');
    git('config', 'user.name', 'T');
    git('config', 'core.autocrlf', 'false');
    await fs.writeFile(path.join(root, 'crlf.txt'), 'one\r\ntwo\r\nthree\r\nfour\r\nfive\r\n');
    await fs.writeFile(path.join(root, 'lf.txt'), 'one\ntwo\nthree\n');
    git('add', '.');
    git('commit', '-m', 'init');
  });
  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });

  async function applyOne(operation: CodingProposal['operations'][number], summary?: string) {
    const bound = await new WorkspaceSnapshotBinder(root).bind(proposal([operation], summary));
    await new WorkspaceMutationEngine(root).apply(bound);
    return bound;
  }

  it('a one-line edit of a CRLF file stays a one-line diff instead of rewriting every line', async () => {
    const bound = await applyOne({ type: 'replace', path: 'crlf.txt', reason: 'edit line two', content: 'one\nTWO\nthree\nfour\nfive\n' });
    const bytes = await fs.readFile(path.join(root, 'crlf.txt'));
    expect(bytes.toString('utf8')).toBe('one\r\nTWO\r\nthree\r\nfour\r\nfive\r\n');
    // The bound (approved, hashed, evidence-checked) content is the same bytes that were written.
    expect(bound.operations[0].content).toBe(bytes.toString('utf8'));
    const numstat = git('diff', '--numstat').stdout.trim();
    expect(numstat).toBe('1\t1\tcrlf.txt');
  });

  it('under autocrlf=true the repository stores LF, so a CRLF checkout is left exactly as approved', async () => {
    git('config', 'core.autocrlf', 'true');
    await fs.writeFile(path.join(root, 'rendered.txt'), 'one\ntwo\n');
    git('add', 'rendered.txt');
    git('commit', '-m', 'lf blob');
    // The index keeps LF; only the working copy is CRLF, which is how Git for Windows renders a checkout.
    await fs.writeFile(path.join(root, 'rendered.txt'), 'one\r\ntwo\r\n');
    expect(git('ls-files', '--eol', 'rendered.txt').stdout).toMatch(/i\/lf\s+w\/crlf/);
    await applyOne({ type: 'replace', path: 'rendered.txt', reason: 'edit', content: 'one\nTWO\n' });
    expect((await fs.readFile(path.join(root, 'rendered.txt'))).toString('utf8')).toBe('one\nTWO\n');
  });

  it('does not touch an LF file, and does not touch a new file', async () => {
    await applyOne({ type: 'replace', path: 'lf.txt', reason: 'edit', content: 'one\nTWO\nthree\n' });
    expect((await fs.readFile(path.join(root, 'lf.txt'))).toString('utf8')).toBe('one\nTWO\nthree\n');
    await applyOne({ type: 'create', path: 'new.txt', reason: 'new file', content: 'x\ny\n' });
    expect((await fs.readFile(path.join(root, 'new.txt'))).toString('utf8')).toBe('x\ny\n');
  });

  it('an explicit line-ending conversion is honoured, not undone', async () => {
    await applyOne({ type: 'replace', path: 'crlf.txt', reason: 'convert to LF line endings', content: 'one\ntwo\nthree\nfour\nfive\n' }, 'Convert crlf.txt to LF line endings');
    expect((await fs.readFile(path.join(root, 'crlf.txt'))).toString('utf8')).toBe('one\ntwo\nthree\nfour\nfive\n');
  });
});
