import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createFilesystemCapabilityAdapter } from '../runtime/filesystemCapability';

let dir: string;
const adapter = createFilesystemCapabilityAdapter();

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'filesystem-cap-'));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('Filesystem-outside-workspace governed capability', () => {
  it('is classified consequential (read-only content, but approval-gated per path)', () => {
    expect(adapter.classify('list_directory_outside_workspace')).toBe('consequential');
    expect(adapter.classify('read_file_outside_workspace')).toBe('consequential');
  });

  it('normalizes approval/evidence paths to the absolute path Core will use', () => {
    const relative = path.relative(process.cwd(), path.join(dir, 'note.txt'));
    const redacted = adapter.redactArguments!('read_file_outside_workspace', { path: relative });
    expect(redacted.path).toBe(path.resolve(relative));
  });

  it('lists a directory outside any workspace', async () => {
    fs.writeFileSync(path.join(dir, 'a.txt'), 'hello');
    fs.mkdirSync(path.join(dir, 'sub'));
    const result = await adapter.run({ name: 'list_directory_outside_workspace', arguments: { path: dir } }, { cwd: process.cwd() });
    expect(result.status).toBe('succeeded');
    expect(result.output).toContain('f a.txt');
    expect(result.output).toContain('d sub');
  });

  it('reads a UTF-8 file outside any workspace', async () => {
    const file = path.join(dir, 'note.txt');
    fs.writeFileSync(file, 'secret plans');
    const result = await adapter.run({ name: 'read_file_outside_workspace', arguments: { path: file } }, { cwd: process.cwd() });
    expect(result.status).toBe('succeeded');
    expect(result.output).toBe('secret plans');
    expect(result.resultCategory).toBe('filesystem_file_read');
  });

  it('fails honestly when the path does not exist', async () => {
    const result = await adapter.run({ name: 'read_file_outside_workspace', arguments: { path: path.join(dir, 'missing.txt') } }, { cwd: process.cwd() });
    expect(result.status).toBe('failed');
    expect(result.resultCategory).toBe('filesystem_path_unavailable');
  });

  it('refuses to read a directory as a file', async () => {
    const result = await adapter.run({ name: 'read_file_outside_workspace', arguments: { path: dir } }, { cwd: process.cwd() });
    expect(result.status).toBe('failed');
    expect(result.resultCategory).toBe('filesystem_not_a_file');
  });

  it('refuses a file over the size limit', async () => {
    const big = path.join(dir, 'big.txt');
    fs.writeFileSync(big, Buffer.alloc(3 * 1024 * 1024, 'x'));
    const result = await adapter.run({ name: 'read_file_outside_workspace', arguments: { path: big } }, { cwd: process.cwd() });
    expect(result.status).toBe('failed');
    expect(result.resultCategory).toBe('filesystem_file_too_large');
  });

  it('rejects a missing path argument without touching the filesystem', async () => {
    const result = await adapter.run({ name: 'read_file_outside_workspace', arguments: {} }, { cwd: process.cwd() });
    expect(result.status).toBe('failed');
    expect(result.resultCategory).toBe('invalid_arguments');
  });
});
