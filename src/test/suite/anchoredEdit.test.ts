import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { applyAnchoredEdits, parseValidateAndExpandCodingProposal } from '../../coding/AnchoredEdit';
import { buildCodingProposalJsonSchema } from '../../coding/CodingProposal';
import { WorkspaceSnapshotBinder } from '../../coding/WorkspaceMutation';

describe('applyAnchoredEdits', () => {
  it('applies non-overlapping edits against the original text', () => {
    const result = applyAnchoredEdits('alpha\nbeta\ngamma\n', [
      { oldText: 'alpha', newText: 'ALPHA' },
      { oldText: 'gamma', newText: 'GAMMA' },
    ]);
    expect(result).toEqual({ ok: true, content: 'ALPHA\nbeta\nGAMMA\n' });
  });

  it('fails closed on zero matches', () => {
    expect(applyAnchoredEdits('abc', [{ oldText: 'zzz', newText: 'x' }])).toEqual({ ok: false, error: 'edit_anchor_not_found', editIndex: 0 });
  });

  it('fails closed on multiple matches, including overlapping ones', () => {
    expect(applyAnchoredEdits('foo foo', [{ oldText: 'foo', newText: 'x' }])).toEqual({ ok: false, error: 'edit_anchor_ambiguous', editIndex: 0 });
    expect(applyAnchoredEdits('aaa', [{ oldText: 'aa', newText: 'x' }])).toEqual({ ok: false, error: 'edit_anchor_ambiguous', editIndex: 0 });
  });

  it('rejects empty oldText, empty edit list, and too many edits', () => {
    expect(applyAnchoredEdits('abc', [{ oldText: '', newText: 'x' }])).toEqual({ ok: false, error: 'edit_old_text_required' });
    expect(applyAnchoredEdits('abc', [])).toEqual({ ok: false, error: 'edit_malformed' });
    const many = Array.from({ length: 21 }, (_, index) => ({ oldText: `t${index}`, newText: 'x' }));
    expect(applyAnchoredEdits(many.map(edit => edit.oldText).join(' '), many)).toEqual({ ok: false, error: 'edit_count_exceeded' });
  });

  it('rejects overlapping edits', () => {
    expect(applyAnchoredEdits('abcdef', [
      { oldText: 'abcd', newText: 'x' },
      { oldText: 'cdef', newText: 'y' },
    ])).toEqual({ ok: false, error: 'edit_overlap' });
  });

  it('does not match an anchor against another edit\'s output', () => {
    expect(applyAnchoredEdits('one two', [
      { oldText: 'one', newText: 'two' },
      { oldText: 'two', newText: 'three' },
    ])).toEqual({ ok: true, content: 'two three' });
  });

  it('rejects an edit that changes nothing', () => {
    expect(applyAnchoredEdits('abc', [{ oldText: 'b', newText: 'b' }])).toEqual({ ok: false, error: 'edit_no_change' });
  });

  it('keeps a consistently CRLF file CRLF when the model anchors with LF', () => {
    const result = applyAnchoredEdits('a\r\nb\r\nc\r\n', [{ oldText: 'a\nb', newText: 'a\nB\nB2' }]);
    expect(result).toEqual({ ok: true, content: 'a\r\nB\r\nB2\r\nc\r\n' });
  });

  it('fails closed on a multi-line anchor in a mixed-EOL file', () => {
    expect(applyAnchoredEdits('a\r\nb\nc', [{ oldText: 'a\nb', newText: 'x' }])).toEqual({ ok: false, error: 'edit_mixed_eol' });
  });
});

describe('anchored edit proposal expansion', () => {
  let root: string;
  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'anchored-edit-'));
    await fs.writeFile(path.join(root, 'event_forms.html'), '<h1>Events</h1>\n<p>Duplicate</p>\n<footer>2025</footer>\n', 'utf8');
  });
  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  const proposal = (operations: unknown[]): string => JSON.stringify({
    version: 1,
    taskSummary: 'Fix duplicate event',
    operations,
    validationCommands: [{ kind: 'git-diff-check' }],
    warnings: [],
    status: 'proposed',
  });

  it('expands an edit into a replace carrying the full resulting content and a host base digest', async () => {
    const result = await parseValidateAndExpandCodingProposal(proposal([
      { type: 'edit', path: 'event_forms.html', reason: 'update year', edits: [{ oldText: '<footer>2025</footer>', newText: '<footer>2026</footer>' }] },
    ]), [], root);
    expect(result.errors).toEqual([]);
    expect(result.ok).toBe(true);
    const operation = result.proposal!.operations[0];
    expect(operation.type).toBe('replace');
    expect(operation.content).toBe('<h1>Events</h1>\n<p>Duplicate</p>\n<footer>2026</footer>\n');
    expect(operation.editBaseSha256).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(result.conformance?.anchoredEditsExpanded).toBe(true);
  });

  it('ignores a model-supplied editBaseSha256 on an ordinary replace', async () => {
    const result = await parseValidateAndExpandCodingProposal(proposal([
      { type: 'replace', path: 'event_forms.html', reason: 'rewrite', content: '<h1>x</h1>\n', editBaseSha256: 'sha256:forged' },
    ]), [], root);
    expect(result.ok).toBe(true);
    expect(result.proposal!.operations[0].editBaseSha256).toBeUndefined();
  });

  it('fails closed on a missing target, an unmatched anchor, and a traversal path', async () => {
    const edit = (p: string, oldText: string) => proposal([{ type: 'edit', path: p, reason: 'r', edits: [{ oldText, newText: 'x' }] }]);
    expect((await parseValidateAndExpandCodingProposal(edit('nope.html', 'a'), [], root)).errors).toEqual(['edit_target_missing']);
    expect((await parseValidateAndExpandCodingProposal(edit('event_forms.html', 'absent'), [], root)).errors).toEqual(['edit_anchor_not_found']);
    expect((await parseValidateAndExpandCodingProposal(edit('../outside.html', 'a'), [], root)).errors).toEqual(['path_traversal_rejected']);
  });

  it('merges anchored edits on the same path, but rejects an edit mixed with another operation on that path', async () => {
    const merged = await parseValidateAndExpandCodingProposal(proposal([
      { type: 'edit', path: 'event_forms.html', reason: 'a', edits: [{ oldText: 'Events', newText: 'E' }] },
      { type: 'edit', path: 'event_forms.html', reason: 'b', edits: [{ oldText: 'Duplicate', newText: 'D' }] },
    ]), [], root);
    expect(merged.ok).toBe(true);
    expect(merged.proposal?.operations).toHaveLength(1);
    const mixed = await parseValidateAndExpandCodingProposal(proposal([
      { type: 'edit', path: 'event_forms.html', reason: 'a', edits: [{ oldText: 'Events', newText: 'E' }] },
      { type: 'replace', path: 'event_forms.html', reason: 'b', content: 'whole file' },
    ]), [], root);
    expect(mixed.ok).toBe(false);
    expect(mixed.errors).toContain('duplicate_operation_path');
  });

  it('fails closed as operation_unsupported when no workspace root is known', async () => {
    const result = await parseValidateAndExpandCodingProposal(proposal([
      { type: 'edit', path: 'event_forms.html', reason: 'r', edits: [{ oldText: 'Events', newText: 'E' }] },
    ]), [], undefined);
    expect(result.ok).toBe(false);
    expect(result.errors).toContain('operation_unsupported');
  });

  it('keeps the legacy "edit" alias with content as a whole-file replace', async () => {
    const result = await parseValidateAndExpandCodingProposal(proposal([
      { type: 'edit', path: 'event_forms.html', reason: 'r', content: '<h1>whole</h1>\n' },
    ]), [], root);
    expect(result.ok).toBe(true);
    expect(result.proposal!.operations[0]).toMatchObject({ type: 'replace', content: '<h1>whole</h1>\n' });
  });

  it('binding refuses when the file changed after the edit was expanded', async () => {
    const result = await parseValidateAndExpandCodingProposal(proposal([
      { type: 'edit', path: 'event_forms.html', reason: 'r', edits: [{ oldText: 'Events', newText: 'E' }] },
    ]), [], root);
    await fs.appendFile(path.join(root, 'event_forms.html'), '<!-- concurrent -->\n', 'utf8');
    await expect(new WorkspaceSnapshotBinder(root).bind(result.proposal!)).rejects.toThrow('workspace_changed_after_review');
  });

  it('binding accepts an unchanged file', async () => {
    const result = await parseValidateAndExpandCodingProposal(proposal([
      { type: 'edit', path: 'event_forms.html', reason: 'r', edits: [{ oldText: 'Events', newText: 'E' }] },
    ]), [], root);
    const bound = await new WorkspaceSnapshotBinder(root).bind(result.proposal!);
    expect(bound.operations[0].content).toContain('<h1>E</h1>');
  });

  it('offers the edit operation in the constrained schema', () => {
    const schema = JSON.stringify(buildCodingProposalJsonSchema());
    expect(schema).toContain('"oldText"');
    expect(schema).toContain('"const":"edit"');
  });
});
