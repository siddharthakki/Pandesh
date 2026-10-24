import { describe, expect, it } from 'vitest';
import {
  classifyCallKind,
  EXPLORATION_LIMIT,
  EXPLORATION_NUDGE_AT,
  evaluateObjectiveFiles,
  explicitMutationTargets,
  objectiveFileRoles,
  explorationBudgetAction,
  explorationNudgeMessage,
  explorationRefusedMessage,
  isObviousRefusalOrIncomplete,
  outstandingMutationTargets,
  noteSuccessfulRead,
  redundantDiscoveryReason,
  redundantReadReason,
} from '../runtime/completionGate';
import { INITIAL_LOOP_PROGRESS, type LoopProgressState } from '../runtime/loopProgress';

const fresh = (): LoopProgressState => ({ ...INITIAL_LOOP_PROGRESS });

describe('classifyCallKind', () => {
  it('separates reads, discovery, validation and mutation', () => {
    expect(classifyCallKind('read_file', { path: 'README.md' }, false)).toBe('read');
    expect(classifyCallKind('propose_text_edit', {}, true)).toBe('mutation');
    expect(classifyCallKind('run_command', { command: 'dir /s *.md' }, false)).toBe('discovery');
    expect(classifyCallKind('run_command', { command: 'findstr /s "ci_level" *.py' }, false)).toBe('discovery');
    expect(classifyCallKind('run_command', { command: 'npm run compile' }, false)).toBe('validation');
    expect(classifyCallKind('run_command', { command: 'python -m pytest -q' }, false)).toBe('validation');
  });
});

describe('evidence ledger', () => {
  it('treats a second whole-file read at an unchanged revision as redundant, a ranged read as new', () => {
    const state = fresh();
    expect(redundantReadReason(state, { path: 'README.md' })).toBeUndefined();
    noteSuccessfulRead(state, { path: 'README.md' });
    expect(redundantReadReason(state, { path: './README.md' })).toMatch(/already read in full/);
    expect(redundantReadReason(state, { path: 'other.md' })).toBeUndefined();
    state.revision += 1;
    expect(redundantReadReason(state, { path: 'README.md' })).toBeUndefined();
  });

  it('does not record a ranged read as a full read', () => {
    const state = fresh();
    noteSuccessfulRead(state, { path: 'a.ts', startLine: 1, endLine: 20 });
    expect(redundantReadReason(state, { path: 'a.ts' })).toBeUndefined();
  });

  it('allows a small discovery allowance when a host pack supplied the files, none without a pack', () => {
    const state: LoopProgressState = { ...fresh(), discoveryCommands: 2 };
    expect(redundantDiscoveryReason(state, ['README.md'])).toMatch(/already supplied 1 relevant file/);
    expect(redundantDiscoveryReason({ ...fresh(), discoveryCommands: 1 }, ['README.md'])).toBeUndefined();
    expect(redundantDiscoveryReason(state, [])).toBeUndefined();
  });
});

describe('explicit mutation targets', () => {
  it('extracts explicitly named files, excludes reference/inspection-only ones, and needs two or more', () => {
    expect(explicitMutationTargets('Create one.txt, two.txt and three.txt.')).toEqual(['one.txt', 'two.txt', 'three.txt']);
    expect(explicitMutationTargets('Update a.txt and inspect b.txt.')).toEqual(['a.txt']);
    expect(explicitMutationTargets('Change a.ts to match b.ts')).toEqual(['a.ts']);
    expect(outstandingMutationTargets(['a.txt'], [])).toEqual([]);
    expect(outstandingMutationTargets(['one.txt', 'two.txt', 'three.txt'], ['./one.txt'])).toEqual(['two.txt', 'three.txt']);
    expect(outstandingMutationTargets(['src/a.ts', 'b.ts'], ['src/a.ts', 'src/b.ts'])).toEqual([]);
  });
  it('flags plain refusals and unfinished admissions, not ordinary completions', () => {
    expect(isObviousRefusalOrIncomplete("I'm unable to finish the remaining changes.")).toBe(true);
    expect(isObviousRefusalOrIncomplete('I cannot do that.')).toBe(true);
    expect(isObviousRefusalOrIncomplete('Updated both files; there is no remaining work.')).toBe(false);
    expect(isObviousRefusalOrIncomplete('Done. Everything is complete.')).toBe(false);
  });
});

describe('M55 pre-write exploration budget', () => {
  it('allows early reads, nudges once, then refuses', () => {
    const state = fresh();
    expect(explorationBudgetAction(state)).toBe('ok');
    state.explorationCalls = EXPLORATION_NUDGE_AT;
    expect(explorationBudgetAction(state)).toBe('nudge');
    state.explorationNudged = true;
    expect(explorationBudgetAction(state)).toBe('ok');
    state.explorationCalls = EXPLORATION_LIMIT;
    expect(explorationBudgetAction(state)).toBe('refuse');
  });

  it('names the copy-then-anchored-edit strategy and the refusal is a tool result, not a failure', () => {
    expect(explorationNudgeMessage(EXPLORATION_NUDGE_AT)).toMatch(/^STRATEGY_CHANGE .*copy.*propose_text_edit/s);
    expect(explorationRefusedMessage('read_file')).toMatch(/^\[read_file\] REFUSED/);
  });
});

import { hasAffirmativeMutationIntent } from '../domain/actionIntent';

describe('M55 copy requests are change requests', () => {
  it.each([
    'Make a new copy of event_forms.html.',
    'make a new copy of this file and format, organize and refactor',
    'Create a backup copy of config.json',
    'copy event_forms.html to event_forms_v2.html',
    'duplicate notes.md',
  ])('%s', (text) => expect(hasAffirmativeMutationIntent(text)).toBe(true));

  it.each([
    'How do I copy a file in PowerShell?',
    'Where is the copy of the settings kept?',
    'What does the copy button do?',
    'How does this app work?',
  ])('%s is not', (text) => expect(hasAffirmativeMutationIntent(text)).toBe(false));
});

import {
  EXPLORATION_HARD_LIMIT,
  explorationCallCost,
  noteExplorationCall,
  resetExplorationBudget,
} from '../runtime/completionGate';
import { isFileChangingShellCommand } from '../domain/mutationPolicy';

describe('M55 exploration budget is evidence-aware', () => {
  /** Drives the executor's per-call sequence: cost -> action -> (refuse | note). */
  const run = (state: LoopProgressState, kind: 'read' | 'discovery', tool: string, args: Record<string, unknown>) => {
    const cost = explorationCallCost(state, kind, tool, args);
    const action = explorationBudgetAction(state, cost);
    if (action === 'nudge') state.explorationNudged = true;
    if (action !== 'refuse') noteExplorationCall(state, kind, args, cost);
    return action;
  };

  it('refuses unproductive paging of one large file at the 8th wide read, nudging once at the 4th', () => {
    const state = fresh();
    const actions: string[] = [];
    for (let i = 0; i < 14; i++) actions.push(run(state, 'read', 'read_file', { path: 'big.html' }));
    expect(actions.indexOf('nudge')).toBe(5); // 1st read free, then 4 wide reads spent
    expect(actions.filter((a) => a === 'nudge')).toHaveLength(1);
    expect(actions.indexOf('refuse')).toBe(9); // 1 free + 8 wide
  });

  it('does not block legitimate inspection: several files and bounded regions of a large file', () => {
    const state = fresh();
    const actions: string[] = [];
    for (const path of ['a.html', 'b.js', 'c.css', 'd.json']) actions.push(run(state, 'read', 'read_file', { path }));
    actions.push(run(state, 'discovery', 'run_command', { command: 'findstr /n "function" big.html' }));
    for (let start = 1; start <= 1000; start += 100) actions.push(run(state, 'read', 'read_file', { path: 'big.html', startLine: start, endLine: start + 99 }));
    expect(actions).not.toContain('refuse');
    expect(actions).not.toContain('nudge');
  });

  it('still bounds targeted exploration by the hard ceiling', () => {
    const state = fresh();
    let refusedAt = -1;
    for (let i = 0; i < 40 && refusedAt < 0; i++) {
      if (run(state, 'read', 'read_file', { path: 'big.html', startLine: i * 10 + 1, endLine: i * 10 + 10 }) === 'refuse') refusedAt = i;
    }
    expect(refusedAt).toBe(EXPLORATION_HARD_LIMIT);
  });

  it('a write-class action resets calls, spend, seen files and the nudge', () => {
    const state = fresh();
    for (let i = 0; i < 6; i++) run(state, 'read', 'read_file', { path: 'big.html' });
    expect(state.explorationNudged).toBe(true);
    resetExplorationBudget(state);
    expect(state).toMatchObject({ explorationCalls: 0, explorationSpent: 0, explorationNudged: false, explorationPaths: [] });
    expect(run(state, 'read', 'read_file', { path: 'big.html' })).toBe('ok');
  });

  it('broad listings cost budget, targeted searches do not', () => {
    const state = fresh();
    expect(explorationCallCost(state, 'discovery', 'run_command', { command: 'dir /s' })).toBe(1);
    expect(explorationCallCost(state, 'discovery', 'run_command', { command: 'findstr /n "x" f.html' })).toBe(0);
    expect(explorationCallCost(state, 'discovery', 'list_files', {})).toBe(1);
  });
});

describe('M55 verified mutation commands', () => {
  it.each([
    'copy event_forms.html event_forms_copy.html',
    'cp a b',
    'echo hi > out.txt',
    'git commit -m x',
    'npm install left-pad',
    'node -e "require(\'fs\').writeFileSync(\'a\',\'b\')"',
    'Copy-Item a.html b.html',
    'create note-saath.txt containing Hello',
  ])('%s changes files', (command) => expect(isFileChangingShellCommand(command)).toBe(true));

  it.each([
    'dir',
    'node -v',
    'node --check copy.js',
    'npm test',
    'findstr /n "function" event_forms_copy.html',
    'node -e "console.log(require(\'fs\').readFileSync(\'a\',\'utf8\').length)"',
    '',
  ])('%s proves nothing was changed', (command) => expect(isFileChangingShellCommand(command)).toBe(false));
});

describe('objective file roles (negated, protected and reference files)', () => {
  const PRICING = 'Modify pricing.py so the coupon applies before the loyalty discount and totals never go negative. Do not modify test_pricing.py. Run python -m pytest -q.';

  it('treats a prohibited file as protected, not as a required edit', () => {
    const roles = objectiveFileRoles(PRICING);
    expect(roles.required).toEqual(['pricing.py']);
    expect(roles.protectedFiles).toEqual(['test_pricing.py']);
  });

  it('passes: pricing.py modified and the protected test untouched', () => {
    expect(evaluateObjectiveFiles('Modify pricing.py; do not modify test_pricing.py', ['pricing.py'])).toEqual({ outstanding: [], violations: [] });
    expect(evaluateObjectiveFiles(PRICING, ['pricing.py'])).toEqual({ outstanding: [], violations: [] });
  });

  it('fails: the required file has no applied change', () => {
    expect(evaluateObjectiveFiles('Modify pricing.py; do not modify test_pricing.py', []).outstanding).toEqual(['pricing.py']);
    expect(evaluateObjectiveFiles(PRICING, ['notes.md']).outstanding).toEqual(['pricing.py']);
  });

  it('fails: the protected file was modified', () => {
    expect(evaluateObjectiveFiles(PRICING, ['pricing.py', './test_pricing.py']).violations).toEqual(['test_pricing.py']);
    expect(evaluateObjectiveFiles(PRICING, ['src/test_pricing.py']).violations).toEqual(['src/test_pricing.py']);
  });

  it('still requires every genuinely required file', () => {
    expect(evaluateObjectiveFiles('Update a.py and b.py; leave c.py unchanged.', ['a.py']).outstanding).toEqual(['b.py']);
  });

  it('does not require a referenced, inspected or test-run file to change', () => {
    expect(objectiveFileRoles('Read tests/test_x.py but do not edit it. Modify x.py.')).toMatchObject({ required: ['x.py'], protectedFiles: ['tests/test_x.py'] });
    expect(objectiveFileRoles('Modify x.py and run tests in test_x.py.')).toMatchObject({ required: ['x.py'], reference: ['test_x.py'] });
    expect(objectiveFileRoles('Inspect config.yaml, then modify x.py and y.py.')).toMatchObject({ required: ['x.py', 'y.py'], reference: ['config.yaml'] });
    expect(evaluateObjectiveFiles('Modify x.py and run tests in test_x.py.', ['x.py'])).toEqual({ outstanding: [], violations: [] });
  });

  it('understands leave-unchanged and trailing keep-as-is phrasings', () => {
    expect(objectiveFileRoles('Leave test_a.py unchanged and edit a.py.')).toMatchObject({ required: ['a.py'], protectedFiles: ['test_a.py'] });
    expect(objectiveFileRoles('Edit a.py. test_a.py must remain unchanged.')).toMatchObject({ required: ['a.py'], protectedFiles: ['test_a.py'] });
    expect(objectiveFileRoles('Edit a.py; test_a.py should not be modified.')).toMatchObject({ required: ['a.py'], protectedFiles: ['test_a.py'] });
    expect(objectiveFileRoles("Edit a.py but don't touch b.py or c.py.")).toMatchObject({ required: ['a.py'], protectedFiles: ['b.py', 'c.py'] });
  });

  it('enforces "only modify Y": a change outside that scope is a violation', () => {
    const task = 'Only modify pricing.py. Run the tests in test_pricing.py.';
    expect(evaluateObjectiveFiles(task, ['pricing.py'])).toEqual({ outstanding: [], violations: [] });
    expect(evaluateObjectiveFiles(task, ['pricing.py', 'test_pricing.py']).violations).toEqual(['test_pricing.py']);
  });

  it('regression: the reproduced JARVIS mission objective (mis-1791545449733-adgei) completes with only pricing.py changed', () => {
    const task = [
      'Modify pricing.py.',
      'Apply the coupon before the loyalty discount.',
      'Prevent negative totals.',
      'Do not modify test_pricing.py.',
      'Run python -m pytest -q.',
    ].join(String.fromCharCode(10));
    expect(objectiveFileRoles(task)).toMatchObject({ required: ['pricing.py'], protectedFiles: ['test_pricing.py'] });
    expect(evaluateObjectiveFiles(task, ['pricing.py'])).toEqual({ outstanding: [], violations: [] });
    expect(evaluateObjectiveFiles(task, []).outstanding).toEqual(['pricing.py']);
    expect(evaluateObjectiveFiles(task, ['pricing.py', 'test_pricing.py']).violations).toEqual(['test_pricing.py']);
  });
});
