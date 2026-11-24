import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
// @ts-expect-error plain ES module without types
import { loadExceptions, isApproved, checkGoldenEvidence, norm } from '../../scripts/lib/storage-policy.mjs';

let root: string;
const NOW = Date.parse('2026-11-24T12:00:00Z');
const line = (p: string, over: Record<string, string> = {}) => {
  const f: Record<string, string> = { path: p, owner: 'owner', purpose: 'live connector', evidence: 'config points here', expires: '2026-12-20', review: 'after Build 188 acceptance', ...over };
  return Object.entries(f).filter(([, v]) => v !== '').map(([k, v]) => `${k}=${v}`).join(' | ');
};
const load = (text: string) => { const f = path.join(root, '.storage-approved'); fs.writeFileSync(f, text); return loadExceptions(f, NOW); };

beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'storage-policy-')); });
afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });

describe('storage exceptions', () => {
  it('accepts a complete, exact, unexpired exception and matches only that exact path', () => {
    const a = path.join(root, 'PandeshTunnel'); fs.mkdirSync(a);
    fs.mkdirSync(path.join(a, 'child')); const sibling = path.join(root, 'PandeshTunnel2'); fs.mkdirSync(sibling);
    const r = load(line(a));
    expect(r.errors).toEqual([]);
    expect(isApproved(r.valid, a)).toBe(true);
    expect(isApproved(r.valid, path.join(a, 'child'))).toBe(false); // no prefix match: a parent does not cover its children
    expect(isApproved(r.valid, sibling)).toBe(false); // no sibling match
    expect(isApproved(r.valid, root)).toBe(false);
  });

  it.each(['owner', 'purpose', 'evidence', 'expires', 'review'])('rejects an exception without %s', (field) => {
    const a = path.join(root, 'x'); fs.mkdirSync(a);
    const r = load(line(a, { [field]: '' }));
    expect(r.valid.size).toBe(0);
    expect(r.errors.join()).toContain('missing');
  });

  it('fails an expired exception and one that is not temporary', () => {
    const a = path.join(root, 'x'); fs.mkdirSync(a);
    expect(load(line(a, { expires: '2026-11-23' })).errors.join()).toContain('EXPIRED');
    expect(load(line(a, { expires: '2027-06-01' })).errors.join()).toContain('temporary');
    expect(load(line(a, { expires: 'soon' })).errors.join()).toContain('YYYY-MM-DD');
  });

  it('fails a stale exception whose path is gone', () => {
    const r = load(line(path.join(root, 'gone')));
    expect(r.errors.join()).toContain('no longer exists');
  });

  it('rejects wildcards, relative paths, drive roots and old bare-path lines', () => {
    fs.mkdirSync(path.join(root, 'a'));
    expect(load(line(path.join(root, 'a*'))).errors.join()).toContain('exact absolute');
    expect(load(line('relative\\dir')).errors.join()).toContain('exact absolute');
    expect(load(line(path.parse(root).root)).errors.join()).toContain('drive root');
    expect(load('D:\\PandeshOld  # because').errors.join()).toContain('malformed');
  });

  it('approving "Stage" never approves the sibling "Stage " (trailing space) or "Stage.bak"', () => {
    fs.mkdirSync(path.join(root, 'Stage'));
    const r = load(line(path.join(root, 'Stage')));
    expect(r.errors).toEqual([]);
    expect(isApproved(r.valid, path.join(root, 'Stage'))).toBe(true);
    expect(isApproved(r.valid, path.join(root, 'Stage '))).toBe(false);
    expect(isApproved(r.valid, path.join(root, 'Stage.bak'))).toBe(false);
  });

  it('rejects a junction that escapes to another folder', () => {
    const target = path.join(root, 'target'); fs.mkdirSync(target);
    const link = path.join(root, 'link');
    fs.symlinkSync(target, link, 'junction');
    const r = load(line(link));
    expect(r.valid.size).toBe(0);
    expect(r.errors.join()).toContain('junction');
    expect(load(line(target)).errors).toEqual([]); // the real path is fine
  });

  it('rejects duplicates and requires exactly one of path= or branch=', () => {
    const a = path.join(root, 'x'); fs.mkdirSync(a);
    expect(load(`${line(a)}\n${line(a)}`).errors.join()).toContain('duplicate');
    expect(load(line(a, { branch: 'b' })).errors.join()).toContain('exactly one');
  });

  it('approves a local branch exactly', () => {
    const r = load('branch=wip/x | owner=o | purpose=p | evidence=e | expires=2026-12-01 | review=r');
    expect(r.errors).toEqual([]);
    expect(r.valid.has('branch:wip/x')).toBe(true);
    expect(r.valid.has('branch:wip/x2')).toBe(false);
  });

  it('norm is case-insensitive and ignores trailing separators only', () => {
    expect(norm('C:\\A\\B\\')).toBe(norm('c:/a/b'));
    expect(norm('C:\\A\\B')).not.toBe(norm('C:\\A\\B2'));
  });
});

describe('golden-evidence policy', () => {
  const run = (name = '2026-10-05T12-00-00Z') => { const d = path.join(root, 'golden', name); fs.mkdirSync(d, { recursive: true }); return d; };
  const manifest = (moved: unknown[]) => fs.writeFileSync(path.join(root, 'golden', 'TRIM-MANIFEST-20261124.json'), JSON.stringify({ moved }));

  it('reports run count and passes small evidence', () => {
    fs.writeFileSync(path.join(run('a'), 'report.json'), '{}'); run('b');
    const r = checkGoldenEvidence(path.join(root, 'golden'));
    expect(r.runs).toBe(2);
    expect(r.violations).toEqual([]);
  });

  it('is bounded by size, not by run count', () => {
    for (let i = 0; i < 40; i++) run(`run-${i}`);
    expect(checkGoldenEvidence(path.join(root, 'golden')).violations).toEqual([]); // 40 runs, no bytes
    fs.writeFileSync(path.join(run('big'), 'x.bin'), Buffer.alloc(2048));
    const r = checkGoldenEvidence(path.join(root, 'golden'), { maxBytes: 1024 });
    expect(r.violations.join()).toContain('limit');
  });

  it('rejects generated builds and caches', () => {
    fs.mkdirSync(path.join(run(), 'attempt-1', 'extensions', 'ollama-agent-0.1'), { recursive: true });
    fs.mkdirSync(path.join(run('b'), 'x', 'GPUCache'), { recursive: true });
    const v = checkGoldenEvidence(path.join(root, 'golden')).violations.join('\n');
    expect(v).toContain('extensions');
    expect(v).toContain('GPUCache');
  });

  it('rejects junctions inside the evidence folder', () => {
    const t = path.join(root, 'elsewhere'); fs.mkdirSync(t);
    fs.symlinkSync(t, path.join(run(), 'node_link'), 'junction');
    expect(checkGoldenEvidence(path.join(root, 'golden')).violations.join()).toContain('junction');
  });

  it('requires relocated evidence to be listed in a manifest, and listed evidence to exist with the same file count', () => {
    const ev = path.join(run(), 'retained-from-extension', 'ext-0.1', '.m47-1-evidence'); fs.mkdirSync(ev, { recursive: true });
    fs.writeFileSync(path.join(ev, 'a.log'), 'x');
    expect(checkGoldenEvidence(path.join(root, 'golden')).violations.join()).toContain('without a manifest');
    manifest([{ to: ev, files: 1, hashes: {} }]);
    expect(checkGoldenEvidence(path.join(root, 'golden')).violations).toEqual([]);
    manifest([{ to: ev, files: 2, hashes: {} }]);
    expect(checkGoldenEvidence(path.join(root, 'golden')).violations.join()).toContain('expected 2');
    fs.rmSync(ev, { recursive: true });
    expect(checkGoldenEvidence(path.join(root, 'golden')).violations.join()).toContain('missing');
  });

  it('can verify hashes, and never deletes anything', () => {
    const ev = path.join(run(), 'retained-from-extension', 'e', '.model-bench'); fs.mkdirSync(ev, { recursive: true });
    fs.writeFileSync(path.join(ev, 'a.log'), 'hello');
    const h = crypto.createHash('sha256').update('hello').digest('hex');
    manifest([{ to: ev, files: 1, hashes: { 'a.log': h } }]);
    expect(checkGoldenEvidence(path.join(root, 'golden'), { verifyHashes: true }).violations).toEqual([]);
    fs.writeFileSync(path.join(ev, 'a.log'), 'tampered');
    expect(checkGoldenEvidence(path.join(root, 'golden'), { verifyHashes: true }).violations.join()).toContain('hash mismatch');
    expect(fs.existsSync(path.join(ev, 'a.log'))).toBe(true);
  });
});
