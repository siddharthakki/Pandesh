import { describe, expect, it } from 'vitest';
import { ExecutionProjection, answerIsEvidenceRefusal, classifyCommandStage, classifyTerminalOutcome, compactRequest, stageForTool, type DhaagaNode } from '../../ui/executionProjection';

describe('terminal outcomes: Completed only when the objective was satisfied', () => {
  const run = () => new ExecutionProjection({ runId: 'o1', mode: 'baat_kar', request: 'count files in each project' });

  it('distinguishes completed, blocked, needs_input, failed and cancelled', () => {
    const expected = {
      completed: { phase: 'completed', title: 'Ho gaya boss.', status: 'done', text: 'Completed' },
      blocked: { phase: 'blocked', title: 'Ruk gaya...', status: 'blocked', text: 'Needs attention' },
      needs_input: { phase: 'needs_input', title: 'Aapka jawab chahiye...', status: 'waiting', text: 'Needs your input' },
      failed: { phase: 'failed', title: 'Atak gaya.', status: 'failed', text: 'Stopped before finishing' },
      cancelled: { phase: 'cancelled', title: 'Rok diya.', status: 'cancelled', text: 'Cancelled' },
    } as const;
    for (const [outcome, want] of Object.entries(expected)) {
      const p = run();
      p.modelActivity();
      p.terminal(outcome as keyof typeof expected);
      const state = p.snapshot();
      expect(state.phase, outcome).toBe(want.phase);
      expect(state.active, outcome).toBe(false);
      expect(state.statusText, outcome).toBe(want.text);
      const last = state.nodes[state.nodes.length - 1];
      expect([last.title, last.status], outcome).toEqual([want.title, want.status]);
    }
  });

  it('never greens a blocked ending, and keeps the work that really finished as done', () => {
    const p = run();
    p.repositoryFacts({ recognised: 139, computing: 'Counting tracked files by project' });
    p.modelActivity();
    p.terminal('blocked', 'The repository information needed was not obtained');
    const state = p.snapshot();
    expect(state.nodes.some(n => n.stage === 'completed')).toBe(false);
    expect(state.nodes.find(n => n.stage === 'planning')!.status).toBe('done');
    expect(state.nodes.find(n => n.stage === 'blocked')!.facts).toEqual(['The repository information needed was not obtained']);
  });
});

describe('Dhaaga fact nodes for host-computed answers', () => {
  it('shows what really happened and never a file read', () => {
    const p = new ExecutionProjection({ runId: 'f1', mode: 'baat_kar', request: 'count files in each project' });
    p.repositoryFacts({ recognised: 139, computing: 'Counting tracked files by project' });
    p.modelActivity();
    p.terminal('completed', '139 projects measured');
    const nodes = p.snapshot().nodes;
    expect(nodes.map(n => [n.title, n.facts])).toEqual([
      ['Repo dekh raha hoon...', ['139 projects recognised']],
      ['Hisab kar raha hoon...', ['Counting tracked files by project']],
      ['Soch raha hoon...', []],
      ['Ho gaya boss.', ['139 projects measured']],
    ]);
    expect(nodes.some(n => n.stage === 'reading_files')).toBe(false);
  });

  it('shows no recognised-projects fact when none was counted', () => {
    const p = new ExecutionProjection({ runId: 'f2', mode: 'baat_kar', request: 'x' });
    expect(p.repositoryFacts({})).toBeNull();
  });
});

describe('classifyTerminalOutcome', () => {
  const refusal = 'I have no tools to run commands or list directory contents. Please run Get-ChildItem in PowerShell yourself.';

  it('turns the live-UAT "Ho gaya boss" refusal into a blocked ending', () => {
    expect(classifyTerminalOutcome({ baatKarRepositoryTurn: true, answer: refusal })).toEqual({ outcome: 'blocked', detail: 'The repository information needed was not obtained' });
  });

  it('keeps a satisfied host-computed answer completed and carries the measured fact', () => {
    expect(classifyTerminalOutcome({ hostOutcome: 'completed', measured: '139 projects measured', baatKarRepositoryTurn: true, answer: 'By tracked file count, `x` is largest.' }))
      .toEqual({ outcome: 'completed', detail: '139 projects measured' });
  });

  it('lets host-known outcomes win over prose in both directions', () => {
    expect(classifyTerminalOutcome({ hostOutcome: 'needs_input', baatKarRepositoryTurn: true, answer: 'Which project do you mean?' }).outcome).toBe('needs_input');
    expect(classifyTerminalOutcome({ hostOutcome: 'blocked', measured: 'Could not complete', baatKarRepositoryTurn: true, answer: 'All done!' })).toEqual({ outcome: 'blocked', detail: 'Could not complete' });
  });

  it('never reclassifies plain chat or non-repository turns', () => {
    expect(classifyTerminalOutcome({ baatKarRepositoryTurn: false, answer: refusal }).outcome).toBe('completed');
    expect(classifyTerminalOutcome({ baatKarRepositoryTurn: false, answer: 'I cannot browse the web.' }).outcome).toBe('completed');
  });
});

describe('answerIsEvidenceRefusal', () => {
  it('flags the live-UAT refusals', () => {
    for (const answer of [
      'I could not determine it because the repository evidence contained no size metrics.',
      'I have no tools to run commands or list directory contents. You can run this in PowerShell: Get-ChildItem -Recurse | Measure-Object',
      "I don't have access to the file system, so I can't count them.",
      'Please run `dir /s` in a terminal and paste the output.',
    ]) expect(answerIsEvidenceRefusal(answer), answer).toBe(true);
  });

  it('does not flag real answers, including ones that mention a limit inside real content', () => {
    for (const answer of [
      'By tracked file count, `work/shm` is the largest project (4,210 files).\n\n| Project | Files |\n| --- | ---: |\n| `work/shm` | 4,210 |',
      `${'The router maps paths to handlers. '.repeat(40)}\nI can't verify the deployment config from here, but the routes above are accurate.`,
      'Which project do you mean: `apps/a` or `apps/b`?',
      '',
    ]) expect(answerIsEvidenceRefusal(answer), answer.slice(0, 40)).toBe(false);
  });
});

function nodesOf(projection: ExecutionProjection): DhaagaNode[] {
  return projection.snapshot().nodes;
}

describe('stageForTool', () => {
  it('maps real tool calls to stages without reading prose', () => {
    expect(stageForTool('read_file', { path: 'a.ts' })).toBe('reading_files');
    expect(stageForTool('run_command', { command: 'dir /s *.md' })).toBe('repo_scanning');
    expect(stageForTool('run_command', { command: 'npm run compile' })).toBe('building');
    expect(stageForTool('run_command', { command: 'npm test' })).toBe('testing');
    expect(stageForTool('propose_text_edit', { path: 'README.md' })).toBe('coding');
    expect(stageForTool('workspace_validation', {})).toBe('testing');
  });
});

describe('classifyCommandStage', () => {
  it('classifies commands by what they do; unknown commands are generic, never Building', () => {
    for (const c of ['dir', 'ls -la', 'git ls-files', 'find . -name "*.md"', 'findstr /s foo *.ts', 'rg foo', 'grep -rn x .', 'cd src && dir']) expect(classifyCommandStage(c), c).toBe('repo_scanning');
    for (const c of ['type README.md', 'cat package.json', 'head -n 20 a.txt', 'tail log.txt']) expect(classifyCommandStage(c), c).toBe('reading_files');
    for (const c of ['npm run build', 'npm run compile', 'tsc -p ./', 'dotnet build', 'cargo build --release', 'mvn package', 'gradle build', 'cd app && npm run build']) expect(classifyCommandStage(c), c).toBe('building');
    for (const c of ['npm test', 'npx vitest run', 'pytest -q', 'dotnet test', 'cargo test', 'npm run test:unit']) expect(classifyCommandStage(c), c).toBe('testing');
    for (const c of ['', 'python tool.py', 'echo hi && node script.js', 'ipconfig']) expect(classifyCommandStage(c), c).toBe('running_command');
  });

  it('a directory listing is never reported as a build', () => {
    const p = new ExecutionProjection({ runId: 'r', mode: 'saath_kar', request: 'list files' });
    p.toolStarted('c1', 'run_command', { command: 'dir' });
    p.toolFinished('c1', 'run_command', true, { output: 'a b c', exitCode: 0 });
    const node = nodesOf(p)[0];
    expect(node.stage).toBe('repo_scanning');
    expect(node.facts.join(' ')).not.toMatch(/Build/);
    expect(node.title).not.toMatch(/Build/);
  });

  it('an unknown command shows a generic title', () => {
    const p = new ExecutionProjection({ runId: 'r', mode: 'saath_kar', request: 'x' });
    p.toolStarted('c1', 'run_command', { command: 'python tool.py' });
    p.toolFinished('c1', 'run_command', true, { exitCode: 0 });
    const node = nodesOf(p)[0];
    expect(node.title).toBe('Running command');
    expect(node.facts.join(' ')).not.toMatch(/Build succeeded/);
  });
});

describe('ExecutionProjection', () => {
  it('Baat Kar shows only stages that happened and never autonomous stages', () => {
    const p = new ExecutionProjection({ runId: 'r1', mode: 'baat_kar', request: 'How does model routing work?' });
    p.repositoryEvidence(['src/a.ts', 'src/b.ts']);
    p.modelActivity();
    // A mutation-stage event cannot appear in Baat Kar.
    expect(p.toolStarted('c1', 'propose_text_edit', { path: 'README.md' })).toBeNull();
    p.terminal('completed');
    const stages = nodesOf(p).map((node) => node.stage);
    expect(stages).toEqual(['repo_scanning', 'reading_files', 'planning', 'completed']);
    expect(p.snapshot().active).toBe(false);
  });

  it('does not manufacture stages that did not happen', () => {
    const p = new ExecutionProjection({ runId: 'r1', mode: 'saath_kar', request: 'x' });
    p.terminal('completed');
    expect(nodesOf(p).map((node) => node.stage)).toEqual(['completed']);
  });

  it('keeps exactly one active node and folds consecutive reads into one step with compact facts', () => {
    const p = new ExecutionProjection({ runId: 'r1', mode: 'saath_kar', request: 'update the readme' });
    p.toolStarted('c1', 'read_file', { path: 'README.md' });
    p.toolFinished('c1', 'read_file', true, {}, { path: 'README.md' });
    p.toolStarted('c2', 'read_file', { path: 'pyproject.toml' });
    const snapshot = p.snapshot();
    const reads = snapshot.nodes.filter((node) => node.stage === 'reading_files');
    expect(reads).toHaveLength(1);
    expect(reads[0].facts).toEqual(['README.md', 'pyproject.toml']);
    expect(snapshot.nodes.filter((node) => node.status === 'active')).toHaveLength(1);
    expect(snapshot.currentNodeId).toBe(reads[0].id);
    expect(snapshot.live).toBe('Reading pyproject.toml');
  });

  it('never puts raw tool JSON on the primary surface; raw payloads live in details', () => {
    const p = new ExecutionProjection({ runId: 'r1', mode: 'saath_kar', request: 'x' });
    p.toolStarted('c1', 'run_command', { command: 'npm run compile' });
    const node = nodesOf(p).find((candidate) => candidate.stage === 'building')!;
    expect(node.facts).toEqual(['npm run compile']);
    expect(node.facts.join(' ')).not.toMatch(/\{|run_command/);
    expect(node.details.join(' ')).toMatch(/run_command/);
  });

  it('projects a Saath Kar edit, approval wait and resumption in order', () => {
    const p = new ExecutionProjection({ runId: 'r1', mode: 'saath_kar', request: 'update the README' });
    p.repositoryEvidence(['README.md']);
    p.toolStarted('c1', 'propose_text_edit', { path: 'README.md' });
    p.approvalRequested();
    expect(p.snapshot().phase).toBe('waiting_approval');
    expect(p.snapshot().statusText).toBe('Waiting for your approval');
    const waiting = nodesOf(p).find((node) => node.stage === 'waiting_approval')!;
    expect(waiting.status).toBe('waiting');
    p.approvalSettled('approved');
    p.toolFinished(undefined, 'propose_text_edit', true, {}, { path: 'README.md' });
    p.terminal('completed');
    const stages = nodesOf(p).map((node) => node.stage);
    expect(stages).toEqual(['repo_scanning', 'reading_files', 'coding', 'waiting_approval', 'completed']);
    const coding = nodesOf(p).find((node) => node.stage === 'coding')!;
    expect(coding.status).toBe('done');
    expect(coding.facts).toContain('README.md updated');
    expect(nodesOf(p).every((node) => node.status === 'done')).toBe(true);
  });

  it('stays active through a second approved change; only the host terminal marks a multi-file run completed', () => {
    const p = new ExecutionProjection({ runId: 'r2', mode: 'saath_kar', request: 'update a.txt and b.txt' });
    p.toolStarted('c1', 'propose_file_change', { path: 'a.txt' });
    p.approvalRequested();
    p.approvalSettled('approved');
    p.toolFinished(undefined, 'propose_file_change', true, {}, { path: 'a.txt' });
    expect(p.snapshot()).toMatchObject({ active: true });
    expect(p.snapshot().phase).not.toBe('completed');
    p.toolStarted('c2', 'read_file', { path: 'b.txt' });
    p.toolFinished('c2', 'read_file', true, {}, { path: 'b.txt' });
    p.toolStarted('c3', 'propose_file_change', { path: 'b.txt' });
    p.approvalRequested();
    expect(p.snapshot().phase).toBe('waiting_approval');
    p.approvalSettled('approved');
    p.toolFinished(undefined, 'propose_file_change', true, {}, { path: 'b.txt' });
    expect(p.snapshot()).toMatchObject({ active: true });
    p.terminal('completed');
    expect(p.snapshot()).toMatchObject({ active: false, phase: 'completed' });
  });

  it('records a test count fact from real evidence only', () => {
    const p = new ExecutionProjection({ runId: 'r1', mode: 'saath_kar', request: 'x' });
    p.toolStarted('c1', 'run_command', { command: 'npm test' });
    p.toolFinished('c1', 'run_command', true, { output: 'Tests  1144 passed (1144)', exitCode: 0 });
    expect(nodesOf(p).find((node) => node.stage === 'testing')!.facts).toContain('1144 tests passed');
  });

  it('turns a failed validation into a failed node, not a green one', () => {
    const p = new ExecutionProjection({ runId: 'r1', mode: 'saath_kar', request: 'x' });
    p.toolStarted('c1', 'run_command', { command: 'npm test' });
    p.toolFinished('c1', 'run_command', false, { output: '3 failed', exitCode: 1 });
    const node = nodesOf(p).find((candidate) => candidate.stage === 'testing')!;
    expect(node.status).toBe('failed');
    expect(node.facts).toContain('3 tests failed');
  });

  it('Baat Kar mutation request stops at "Change required", then continues as Saath Kar on confirmation', () => {
    const p = new ExecutionProjection({ runId: 'r1', mode: 'baat_kar', request: 'Check and update the README with missing info' });
    p.repositoryEvidence(['README.md', 'pyproject.toml']);
    p.modeChangeRequired();
    let snapshot = p.snapshot();
    expect(snapshot.phase).toBe('needs_mode_change');
    expect(snapshot.active).toBe(true);
    expect(snapshot.mode).toBe('baat_kar');
    expect(snapshot.nodes[snapshot.nodes.length - 1].stage).toBe('change_required');
    expect(snapshot.nodes[snapshot.nodes.length - 1].status).toBe('waiting');
    p.modeChanged('saath_kar');
    p.toolStarted('c1', 'propose_text_edit', { path: 'README.md' });
    snapshot = p.snapshot();
    expect(snapshot.mode).toBe('saath_kar');
    expect(snapshot.modeLabel).toBe('Saath Kar');
    expect(snapshot.nodes.map((node) => node.stage)).toEqual(['repo_scanning', 'reading_files', 'change_required', 'mode_started', 'coding']);
  });

  it('shows failure and cancellation distinctly and stops being active', () => {
    const failed = new ExecutionProjection({ runId: 'r1', mode: 'saath_kar', request: 'x' });
    failed.toolStarted('c1', 'read_file', { path: 'a.ts' });
    failed.terminal('failed', 'exceeded 16 tool turns without a final answer');
    expect(failed.snapshot().phase).toBe('failed');
    expect(failed.snapshot().nodes[failed.snapshot().nodes.length - 1].status).toBe('failed');
    const cancelled = new ExecutionProjection({ runId: 'r2', mode: 'saath_kar', request: 'x' });
    cancelled.toolStarted('c1', 'read_file', { path: 'a.ts' });
    cancelled.terminal('cancelled');
    expect(cancelled.snapshot().phase).toBe('cancelled');
    expect(cancelled.snapshot().nodes.every((node) => node.status === 'cancelled')).toBe(true);
  });

  it('renders branches only when the runtime supplies delegated work, connected to a delegating parent', () => {
    const solo = new ExecutionProjection({ runId: 'r1', mode: 'saath_kar', request: 'x' });
    expect(solo.branch('Splitting work', { id: 'b1', label: 'HTML', status: 'active' })).toBeNull();
    const kd = new ExecutionProjection({ runId: 'r2', mode: 'karke_dikha', request: 'x' });
    kd.branch('Parallel work', { id: 'b1', label: 'HTML restructuring', status: 'done' });
    kd.branch('Parallel work', { id: 'b2', label: 'UI validation', status: 'active' });
    const parent = kd.snapshot().nodes.find((node) => node.stage === 'delegated')!;
    expect(parent.branches.map((branch) => branch.label)).toEqual(['HTML restructuring', 'UI validation']);
    expect(parent.status).toBe('delegated');
    kd.branch('Parallel work', { id: 'b2', label: 'UI validation', status: 'done' });
    expect(kd.snapshot().nodes.find((node) => node.stage === 'delegated')!.status).toBe('done');
  });

  it('emits patches carrying only the changed nodes, and nothing when nothing changed', () => {
    const p = new ExecutionProjection({ runId: 'r1', mode: 'saath_kar', request: 'x' });
    p.toolStarted('c1', 'read_file', { path: 'a.ts' });
    p.toolFinished('c1', 'read_file', true);
    p.toolStarted('c2', 'read_file', { path: 'b.ts' });
    const patch = p.toolFinished('c2', 'read_file', true)!;
    expect(patch.upserts).toHaveLength(1);
    // Token-rate model activity with the planning step already present must not produce node churn.
    p.modelActivity();
    expect(p.modelActivity()).toBeNull();
  });

  it('compacts a long request for the root', () => {
    expect(compactRequest('a'.repeat(400)).length).toBeLessThanOrEqual(140);
    expect(compactRequest('  Check   and\nupdate ')).toBe('Check and update');
  });
});
