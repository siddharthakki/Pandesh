import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import {
  buildTargetedSourceContext,
  renderTargetedExcerpts,
  selectTargetedExcerpts,
  targetedSearchTerms,
} from '../../coding/TargetedSourceExcerpts';
import {
  applyAnchoredEdits,
  describeAnchorMiss,
  describeProposalShape,
  parseValidateAndExpandCodingProposal,
  renderProposalForModel,
} from '../../coding/AnchoredEdit';
import { FIXED_MULTI_AGENT_GRAPH_CONTRACT_VERSION, FixedMultiAgentGraph } from '../../orchestration/FixedMultiAgentGraph';
import { GovernedModelExecutionDispatcher } from '../../agent/GovernedModelExecutionDispatcher';
import type { GovernedModelRequest } from '../../agent/GovernedModelExecutionTypes';
import { buildCompactProposalRepairPrompt } from '../../coding/InvestigationLoop';
import { EvidenceManifest } from '../../autonomous/recovery/AttemptJournal';
import { checkProposalGrounding, workspaceFileReader } from '../../autonomous/recovery/Grounding';
import { sha256 } from '../../coding/WorkspaceMutation';

const TASK = [
  'Add a Duplicate Event feature to this existing Turnout Event Form Studio.',
  'Create a new independent event with a new unique ID and title: <original title> — Copy.',
  'Copy blocks, theme, background, settings and ticket tier definitions and prices.',
  'Reset responses, analytics and stats; reset every ticket tier sold count to 0. Persist it and open it in Studio.',
].join('\n');

/** A ~60 KB single-file app shaped like the UAT fixture: the relevant code sits far from the top. */
function largeApp(): string {
  const lines: string[] = ['<!doctype html>', '<html><head><style>'];
  for (let index = 0; index < 600; index += 1) lines.push(`.c${index}{margin:${index}px;padding:0;color:#${(index % 999).toString().padStart(3, '0')}}`);
  lines.push('</style></head><body><script>');
  lines.push("function saveDB(){try{localStorage.setItem(DB_KEY,JSON.stringify(db))}catch(e){}}");
  lines.push('function commit(){saveDB();flashSaved()}');
  for (let index = 0; index < 400; index += 1) lines.push(`function helper${index}(x){return x+${index}}`);
  lines.push('function renderHome(){');
  lines.push(" return db.forms.map(f=>`<div class=\"card\"><button onclick=\"T.openStudio('${f.id}')\">Edit</button><button onclick=\"T.delForm('${f.id}')\">Delete</button></div>`).join('');");
  lines.push('}');
  for (let index = 0; index < 400; index += 1) lines.push(`function filler${index}(y){return y*${index}}`);
  lines.push('const T={');
  lines.push(" newBlank(){const f=mkForm({title:'Untitled event'});db.forms.unshift(f);commit();go('studio/'+f.id)},");
  lines.push(" openStudio(id){go('studio/'+id)},");
  lines.push(" delForm(id){db.forms=db.forms.filter(x=>x.id!==id);commit();go('home')},");
  lines.push(' updTier(fid,tid,k,v){const f=getForm(fid);const t=f.tickets.find(x=>x.id===tid);t[k]=v;if(t.sold>t.qty)t.sold=t.qty;commit()},');
  lines.push('};');
  lines.push('</script></body></html>');
  return lines.join('\n') + '\n';
}

describe('targeted source excerpts', () => {
  it('derives distinctive task terms and drops filler words', () => {
    const terms = targetedSearchTerms(TASK);
    expect(terms).toEqual(expect.arrayContaining(['duplicat', 'ticket', 'sold', 'studio', 'persist', 'respons']));
    expect(terms).not.toContain('the');
    expect(terms).not.toContain('existing');
  });

  it('selects bounded, deduplicated, line-exact excerpts around the relevant code, not the file prefix', () => {
    const content = largeApp();
    expect(content.length).toBeGreaterThan(20_000);
    const excerpts = selectTargetedExcerpts('event_forms.html', content, targetedSearchTerms(TASK), 6_000, 6);
    const lines = content.split('\n');
    expect(excerpts.length).toBeGreaterThan(0);
    expect(excerpts.length).toBeLessThanOrEqual(6);
    expect(excerpts.reduce((sum, excerpt) => sum + excerpt.text.length, 0)).toBeLessThanOrEqual(6_000);
    for (const excerpt of excerpts) {
      // Provenance is exact: the text IS those lines of the file, so any substring is a valid anchor.
      expect(excerpt.text).toBe(lines.slice(excerpt.startLine - 1, excerpt.endLine).join('\n'));
      expect(content.includes(excerpt.text)).toBe(true);
    }
    for (let index = 1; index < excerpts.length; index += 1) {
      expect(excerpts[index].startLine).toBeGreaterThan(excerpts[index - 1].endLine);
    }
    const joined = excerpts.map(excerpt => excerpt.text).join('\n');
    expect(joined).toContain("openStudio(id){go('studio/'+id)}");
    expect(joined).toContain('updTier(fid,tid');
    expect(joined).not.toContain('<!doctype html>');
    expect(renderTargetedExcerpts(excerpts)).toContain('event_forms.html lines ');
  });

  describe('workspace scan', () => {
    let root: string;
    beforeEach(async () => {
      root = await fs.mkdtemp(path.join(os.tmpdir(), 'oa-targeted-'));
      await fs.writeFile(path.join(root, 'event_forms.html'), largeApp(), 'utf8');
      await fs.writeFile(path.join(root, 'small.js'), 'export const ticket = 1; // duplicate sold studio\n', 'utf8');
    });
    afterEach(async () => {
      await fs.rm(root, { recursive: true, force: true });
    });

    it('excerpts only large source files and respects the character budget', async () => {
      const context = await buildTargetedSourceContext(root, TASK, { maxChars: 5_000, maxExcerpts: 5 });
      expect(context.excerpts.length).toBeGreaterThan(0);
      expect(context.excerpts.every(excerpt => excerpt.path === 'event_forms.html')).toBe(true);
      expect(context.text.length).toBeLessThan(5_000 + 1_500);
      expect(context.text).toContain('Copy every edit oldText verbatim');
    });

    it('returns nothing for a workspace with no large files (no prompt growth for small repos)', async () => {
      await fs.rm(path.join(root, 'event_forms.html'));
      expect((await buildTargetedSourceContext(root, TASK)).text).toBe('');
    });

    it('gives the graph planner and proposal stages verbatim excerpts, but not the analyst', async () => {
      const prompts = new Map<string, string>();
      const dispatcher = new GovernedModelExecutionDispatcher({
        execute: vi.fn(async (modelRequest: GovernedModelRequest) => {
          const stage = modelRequest.requestId.split(':').pop()!;
          prompts.set(stage, modelRequest.prompt);
          return { completion: `output from ${stage}` };
        }),
      });
      await new FixedMultiAgentGraph(dispatcher).execute({
        contractVersion: FIXED_MULTI_AGENT_GRAPH_CONTRACT_VERSION,
        invocationId: 'inv',
        taskId: 'task',
        goal: TASK,
        model: 'test-model',
        workspaceRoot: root,
      });
      for (const stage of ['planner', 'implementer', 'reviewer', 'validator']) {
        expect(prompts.get(stage)).toContain("openStudio(id){go('studio/'+id)}");
      }
      expect(prompts.get('repository-analyst')).not.toContain('Targeted source excerpts');
    });

    it('records the rejected graph proposal shape and anchor evidence without applying anything', async () => {
      const before = await fs.readFile(path.join(root, 'event_forms.html'), 'utf8');
      const badProposal = JSON.stringify({
        version: 1,
        taskSummary: 'Duplicate event',
        operations: [{
          type: 'edit',
          path: 'event_forms.html',
          reason: 'add duplicate',
          edits: [{ oldText: " openStudio(id){go('studio/' + id)},", newText: ' dupForm(id){},' }],
        }],
        validationCommands: [{ kind: 'git-diff-check' }],
        warnings: [],
        status: 'proposed',
      });
      const dispatcher = new GovernedModelExecutionDispatcher({
        execute: vi.fn(async (modelRequest: GovernedModelRequest) => {
          const stage = modelRequest.requestId.split(':').pop()!;
          return { completion: stage === 'validator' ? badProposal : `output from ${stage}` };
        }),
      });
      const result = await new FixedMultiAgentGraph(dispatcher).execute({
        contractVersion: FIXED_MULTI_AGENT_GRAPH_CONTRACT_VERSION,
        invocationId: 'inv',
        taskId: 'task',
        goal: TASK,
        model: 'test-model',
        workspaceRoot: root,
      });
      expect(result.proposalConsumption?.status).toBe('invalid');
      expect(result.proposalConsumption?.errors).toContain('edit_anchor_not_found');
      expect(result.proposalConsumption?.shape).toBe('ops=1 [edit event_forms.html edits=1 content=no]');
      expect(result.proposalConsumption?.repairHints?.[0]).toContain('openStudio');
      expect(await fs.readFile(path.join(root, 'event_forms.html'), 'utf8')).toBe(before);
    });
  });
});

describe('anchor repair hints', () => {
  const file = 'line one\nconst T={\n openStudio(id){go(\'studio/\'+id)},\n delForm(id){remove(id)},\n};\nend\n';

  it('quotes the current text where an inexact anchor was aiming', () => {
    const hint = describeAnchorMiss('app.js', file, "const T={\n openStudio(id){ go('studio/'+id) },", 'edit_anchor_not_found');
    expect(hint).toContain('edit_anchor_not_found in app.js');
    expect(hint).toContain("openStudio(id){go('studio/'+id)},");
    expect(hint).toContain('lines ');
  });

  it('points at the duplicates for an ambiguous anchor', () => {
    const hint = describeAnchorMiss('app.js', 'a();\nfoo();\nb();\nfoo();\n', 'foo();', 'edit_anchor_ambiguous');
    expect(hint).toContain('occurs more than once (lines 2, 4)');
  });

  it('is bounded and says so when nothing similar exists', () => {
    const hint = describeAnchorMiss('app.js', file, '@@@@@@@@@@', 'edit_anchor_not_found');
    expect(hint).toContain('nothing similar was found');
    expect(hint.length).toBeLessThan(2_000);
  });

  it('reports which edit failed, still failing closed', () => {
    expect(applyAnchoredEdits('abc def', [{ oldText: 'abc', newText: 'x' }, { oldText: 'zzz', newText: 'y' }]))
      .toEqual({ ok: false, error: 'edit_anchor_not_found', editIndex: 1 });
  });

  describe('through proposal expansion', () => {
    let root: string;
    beforeEach(async () => {
      root = await fs.mkdtemp(path.join(os.tmpdir(), 'oa-anchor-hint-'));
      await fs.writeFile(path.join(root, 'app.js'), file, 'utf8');
    });
    afterEach(async () => {
      await fs.rm(root, { recursive: true, force: true });
    });

    const envelope = (operations: unknown[]): string => JSON.stringify({
      version: 1,
      taskSummary: 'Change app',
      operations,
      validationCommands: [{ kind: 'git-diff-check' }],
      warnings: [],
      status: 'proposed',
    });

    it('returns hints with the failure and never a proposal', async () => {
      const result = await parseValidateAndExpandCodingProposal(envelope([{
        type: 'edit', path: 'app.js', reason: 'r', edits: [{ oldText: " openStudio(id) { go('studio/'+id) },", newText: 'x' }],
      }]), [], root);
      expect(result.ok).toBe(false);
      expect(result.proposal).toBeUndefined();
      expect(result.errors).toEqual(['edit_anchor_not_found']);
      expect(result.repairHints?.[0]).toContain('openStudio');
      expect(await fs.readFile(path.join(root, 'app.js'), 'utf8')).toBe(file);
    });

    it('a repaired proposal with exact anchors from the hint is matched from scratch and expands', async () => {
      const result = await parseValidateAndExpandCodingProposal(envelope([{
        type: 'edit', path: 'app.js', reason: 'r', edits: [{ oldText: " openStudio(id){go('studio/'+id)},", newText: " openStudio(id){go('studio/'+id)},\n dupForm(id){},"}],
      }]), [], root);
      expect(result.ok).toBe(true);
      expect(result.proposal?.operations[0]).toMatchObject({ type: 'replace', path: 'app.js' });
      expect(result.proposal?.operations[0].content).toContain('dupForm(id){},');
    });

    it('normalizes a flat edit and merges same-path anchored edits into one exact edit', async () => {
      const result = await parseValidateAndExpandCodingProposal(envelope([
        { type: 'edit', path: 'app.js', reason: 'a', oldText: 'line one', newText: 'line 1' },
        { type: 'edit', path: 'app.js', reason: 'b', edits: [{ oldText: 'end\n', newText: 'END\n' }] },
      ]), [], root);
      expect(result.ok).toBe(true);
      expect(result.proposal?.operations).toHaveLength(1);
      expect(result.proposal?.operations[0].content?.startsWith('line 1\n')).toBe(true);
      expect(result.proposal?.operations[0].content?.endsWith('END\n')).toBe(true);
    });

    it('merged anchors still fail closed when they overlap', async () => {
      const result = await parseValidateAndExpandCodingProposal(envelope([
        { type: 'edit', path: 'app.js', reason: 'a', oldText: 'line one\nconst', newText: 'x' },
        { type: 'edit', path: 'app.js', reason: 'b', oldText: 'one\nconst T', newText: 'y' },
      ]), [], root);
      expect(result.ok).toBe(false);
      expect(result.errors).toEqual(['edit_overlap']);
    });
  });

  it('puts the hints into the investigation compact repair prompt', () => {
    const prompt = buildCompactProposalRepairPrompt({ operations: [] }, ['edit_anchor_not_found'], ['{"kind":"git-diff-check"}'], ['HINT_SENTINEL current text']);
    expect(prompt).toContain('HINT_SENTINEL current text');
  });
});

describe('proposal shape diagnostics', () => {
  it('summarizes operation shape without file content', () => {
    const shape = describeProposalShape(JSON.stringify({
      operations: [
        { type: 'edit', path: 'event_forms.html', oldText: 'SECRET_SOURCE', newText: 'x' },
        { type: 'replace', path: 'event_forms.html', content: 'SECRET_SOURCE_CONTENT' },
      ],
    }));
    expect(shape).toBe('ops=2 [edit event_forms.html edits=flat content=no] [replace event_forms.html edits=0 content=21ch]');
    expect(shape).not.toContain('SECRET');
    expect(describeProposalShape('not json')).toMatch(/^unparseable/);
  });
});

describe('grounding of host-expanded anchored edits', () => {
  let root: string;
  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'oa-edit-ground-'));
    await fs.writeFile(path.join(root, 'big.html'), 'current bytes\n', 'utf8');
  });
  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  const ground = (operations: Array<{ type: string; path: string; editBaseSha256?: string }>) => checkProposalGrounding({
    operations,
    manifest: new EvidenceManifest({ evidence: new Map() } as unknown as ConstructorParameters<typeof EvidenceManifest>[0]),
    readCurrent: workspaceFileReader(root),
  });

  it('admits an edit-derived replace whose host digest is the current file, without a whole-file model read', async () => {
    const digest = sha256(Buffer.from('current bytes\n', 'utf8'));
    expect(await ground([{ type: 'replace', path: 'big.html', editBaseSha256: digest }])).toEqual({ ok: true, missing: [] });
  });

  it('still requires a full read for a model-authored replace, or when the file moved after expansion', async () => {
    expect((await ground([{ type: 'replace', path: 'big.html' }])).ok).toBe(false);
    const stale = sha256(Buffer.from('older bytes\n', 'utf8'));
    expect((await ground([{ type: 'replace', path: 'big.html', editBaseSha256: stale }])).ok).toBe(false);
  });
});

describe('graph proposal schema offers delete only for removal tasks', () => {
  const schemaHasDelete = (format: unknown): boolean => JSON.stringify(format).includes('"const":"delete"');
  const validatorFormat = async (goal: string): Promise<unknown> => {
    const formats = new Map<string, unknown>();
    const dispatcher = new GovernedModelExecutionDispatcher({
      execute: vi.fn(async (modelRequest: GovernedModelRequest) => {
        const stage = modelRequest.requestId.split(':').pop()!;
        formats.set(stage, modelRequest.responseFormat);
        return { completion: `output from ${stage}` };
      }),
    });
    await new FixedMultiAgentGraph(dispatcher).execute({ contractVersion: FIXED_MULTI_AGENT_GRAPH_CONTRACT_VERSION, invocationId: 'inv', taskId: 'task', goal, model: 'test-model' });
    return formats.get('validator');
  };

  it('does not offer the content-free delete branch for the Duplicate Event edit task', async () => {
    expect(schemaHasDelete(await validatorFormat(TASK))).toBe(false);
  });

  it('still offers delete when the task asks for removal', async () => {
    expect(schemaHasDelete(await validatorFormat('Remove the unused legacy_report.js file.'))).toBe(true);
  });
});

describe('repair turns see an expanded edit compactly', () => {
  let root: string;
  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'oa-compact-'));
    await fs.writeFile(path.join(root, 'event_forms.html'), largeApp(), 'utf8');
  });
  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it('keeps the exact anchors on the expanded replace and renders it back as an edit, not the whole file', async () => {
    const edits = [{ oldText: " openStudio(id){go('studio/'+id)},", newText: " openStudio(id){go('studio/'+id)},\n dupForm(id){},"}];
    const result = await parseValidateAndExpandCodingProposal(JSON.stringify({
      version: 1, taskSummary: 'Duplicate', operations: [{ type: 'edit', path: 'event_forms.html', reason: 'r', edits }],
      validationCommands: [{ kind: 'git-diff-check' }], warnings: [], status: 'proposed',
    }), [], root);
    expect(result.ok).toBe(true);
    const operation = result.proposal!.operations[0];
    expect(operation.type).toBe('replace');
    expect(operation.content!.length).toBeGreaterThan(20_000);
    expect(operation.anchoredEdits).toEqual(edits);
    const rendered = renderProposalForModel(result.proposal);
    expect(rendered.length).toBeLessThan(2_000);
    expect(JSON.parse(rendered).operations[0]).toEqual({ type: 'edit', path: 'event_forms.html', reason: 'r', edits });
    expect(rendered).not.toContain('editBaseSha256');
  });

  it('leaves ordinary operations untouched', () => {
    const proposal = { operations: [{ type: 'create', path: 'a.js', reason: 'r', content: 'x' }] };
    expect(JSON.parse(renderProposalForModel(proposal))).toEqual(proposal);
  });
});

describe('anchored edits keep an LF file LF', () => {
  it('converts CRLF in replacement text and anchors to LF for a consistently-LF file', () => {
    const result = applyAnchoredEdits('a();\nb();\nc();\n', [{ oldText: 'b();\r\nc();', newText: 'b();\r\nd();\r\nc();' }]);
    expect(result).toEqual({ ok: true, content: 'a();\nb();\nd();\nc();\n' });
  });

  it('still keeps a CRLF file CRLF and refuses to guess on a mixed file', () => {
    expect(applyAnchoredEdits('a();\r\nb();\r\n', [{ oldText: 'b();', newText: 'x();\ny();' }]))
      .toEqual({ ok: true, content: 'a();\r\nx();\r\ny();\r\n' });
    expect(applyAnchoredEdits('a();\r\nb();\n', [{ oldText: 'a();\r\nb();', newText: 'x' }]))
      .toEqual({ ok: false, error: 'edit_mixed_eol' });
  });
});
