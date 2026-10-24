import { describe, expect, it } from 'vitest';
import { parseAutonomousProgressPhase, renderAutonomousProgressEventPlain } from '../../autonomous/AutonomousProgressEvents';

describe('Autonomous progress events (parse + render)', () => {
  it('distinguishes policy auto-approval from user approval states', () => {
    expect(parseAutonomousProgressPhase('approval_auto_approved gate=graph_dispatch policy=autonomous_runtime').title).toBe('Governance check passed');
    expect(parseAutonomousProgressPhase('approval_waiting gate=execution actor=user').title).toBe('Waiting for repository mutation approval');
    expect(parseAutonomousProgressPhase('approval_approved gate=execution actor=user').title).toBe('Repository mutation approved');
    expect(parseAutonomousProgressPhase('approval_rejected gate=execution actor=user').title).toBe('Repository mutation rejected');
    expect(parseAutonomousProgressPhase('approval_expired gate=execution actor=user').title).toBe('Repository mutation approval expired');
  });

  it('parses real proposal-gate progress suffixes without falling back to raw machine text', () => {
    const event = parseAutonomousProgressPhase(
      'approval_requested gate=proposal actor=user proposalId=sha256:abc version=1',
    );
    expect(event.kind).toBe('approval_requested');
    expect(event.title).toBe('Approval requested for coding proposal');
    expect(event.detail).toContain('Proposal version: 1');
    expect(event.detail.some(line => line.includes('proposalId'))).toBe(false);
  });

  it('renders graph stage start with provider/model and a meaningful activity description', () => {
    const event = parseAutonomousProgressPhase('graph_stage_started stage=planner index=2/5 model=qwen3-coder:30b provider=ollama');
    expect(event.title).toBe('Stage 2/5 — Planner');
    expect(event.detail).toContain('Designing the smallest safe implementation plan.');
    expect(event.detail).toContain('Provider: ollama');
    expect(event.detail).toContain('Model: qwen3-coder:30b');
  });

  it('renders graph stage completion with duration in seconds', () => {
    const event = parseAutonomousProgressPhase('graph_stage_completed stage=repository-analyst index=1/5 durationMs=9500');
    expect(event.title).toBe('Stage 1/5 — Repository Analyst completed');
    expect(event.detail).toContain('Finished in 9.5 s; handing the result to the next governed step.');
  });

  it('renders the proposal operation count as user-facing scope', () => {
    const event = parseAutonomousProgressPhase('proposal_operation_count operations=1');
    expect(event.title).toBe('Proposal scope identified');
    expect(event.detail).toContain('1 file operation proposed.');
  });

  it('renders a proposal conflict with operation index, action, path and mutation status', () => {
    const event = parseAutonomousProgressPhase('proposal_validation_failed operation=2/4 action=create path=events/views.py reason=target_exists mutation_started=false');
    expect(event.title).toBe('Proposal validation failed');
    expect(event.detail).toEqual([
      'Operation: 2 of 4',
      'Action: create',
      'Path: events/views.py',
      'Reason: target already exists',
      'Mutation started: no',
    ]);
  });

  it('renders mutation completion counts', () => {
    const event = parseAutonomousProgressPhase('mutation_completed created=1 modified=2 deleted=0');
    expect(event.title).toBe('Repository change applied');
    expect(event.detail).toEqual(['Files created: 1', 'Files modified: 2', 'Files deleted: 0']);
  });

  it('renders the exact active validation command', () => {
    const compile = parseAutonomousProgressPhase('validation_command_started index=1/2 command=npm run compile');
    expect(compile.kind).toBe('validation_command_started');
    expect(compile.title).toBe('Validation command 1/2 — npm run compile');
    expect(compile.detail).toContain('Compiling the extension source in the isolated worktree.');

    const test = parseAutonomousProgressPhase('validation_command_started index=2/2 command=npm test');
    expect(test.title).toBe('Validation command 2/2 — npm test');
    expect(test.detail[0]).toContain('complete Vitest suite');
  });

  it('renders a meaningful validation result', () => {
    const passed = parseAutonomousProgressPhase('validation_completed commands=3 failed=0');
    expect(passed.title).toBe('Validation passed');
    expect(passed.detail).toEqual(['Commands run: 3', 'Failed: 0']);

    const failed = parseAutonomousProgressPhase('validation_completed commands=3 failed=1');
    expect(failed.title).toBe('Validation found failures');
  });

  it('renders bounded validation-repair progress in everyday language', () => {
    const started = parseAutonomousProgressPhase('validation_repair_started cycle=1/2');
    expect(started.title).toContain('cycle 1 of 2');
    expect(started.detail[0]).toContain('approved files and checks');
    expect(parseAutonomousProgressPhase('validation_repair_completed cycle=1/2 failed=0').title).toBe('Validation repair passed');
    expect(parseAutonomousProgressPhase('validation_repair_no_progress cycle=2/2').title).toContain('made no progress');
  });

  it('renders the M16 quality gate result', () => {
    const event = parseAutonomousProgressPhase('m16_gate_result status=passed findings=0');
    expect(event.title).toBe('M16 quality gate passed');
    expect(event.detail).toEqual(['Findings: 0']);
  });

  it('distinguishes blocked, cancelled and waiting-for-approval terminal/interim states', () => {
    expect(parseAutonomousProgressPhase('blocked:create_target_exists operation=2/4 path=events/views.py mutation_started=false').title)
      .toBe('Task blocked: create_target_exists');
    expect(parseAutonomousProgressPhase('cancelled:proposal_rejected').title).toBe('Task cancelled');
    expect(parseAutonomousProgressPhase('waiting_for_delivery_approval').title).toBe('Ready for delivery approval');
    expect(parseAutonomousProgressPhase('awaiting_approval').title).not.toBe(parseAutonomousProgressPhase('awaiting_review').title);
  });

  it('bounds an oversized path or error message in rendered detail', () => {
    const longPath = 'a/'.repeat(500) + 'file.ts';
    const event = parseAutonomousProgressPhase(`proposal_validation_failed operation=1/1 action=create path=${longPath} reason=target_exists mutation_started=false`);
    const pathLine = event.detail.find(line => line.startsWith('Path: '))!;
    expect(pathLine.length).toBeLessThan(320);
  });

  it('never exceeds the bounded detail line count', () => {
    const event = parseAutonomousProgressPhase('graph_stage_started stage=validator index=5/5 model=m provider=p');
    const timestamp = new Date('2026-01-01T10:20:07.000Z');
    const rendered = renderAutonomousProgressEventPlain(event, timestamp);
    expect(rendered.split('\n').length).toBeLessThanOrEqual(13);
    const pad = (n: number) => String(n).padStart(2, '0');
    const localClock = `${pad(timestamp.getHours())}:${pad(timestamp.getMinutes())}:${pad(timestamp.getSeconds())}`;
    expect(rendered.startsWith(`${localClock}  Stage 5/5 — Validator`)).toBe(true);
  });

  it('renders investigation reads and searches with path, range, query, and remaining allowance', () => {
    const read = parseAutonomousProgressPhase(
      'investigation_turn turn=1 action=read_file phase=investigate remaining=5 requested=read_file completed=read_file path=src/activation/M15AutonomousRuntime.ts range=1-80 ok=true reads=1 unique_files=1',
    );
    expect(read.kind).toBe('investigation_read_file');
    expect(read.title).toContain('Reading src/activation/M15AutonomousRuntime.ts');
    expect(read.title).toContain('1-80');
    expect(read.detail).toContain('Path: src/activation/M15AutonomousRuntime.ts');
    expect(read.detail).toContain('Range: 1-80');
    expect(read.detail).toContain('Remaining investigation allowance: 5');

    const search = parseAutonomousProgressPhase(
      'investigation_turn turn=2 action=search phase=investigate remaining=4 requested=search completed=search scope=workspace results=12 ok=true reads=1 unique_files=1 query=approveDelivery',
    );
    expect(search.kind).toBe('investigation_search');
    expect(search.title).toContain('Searching for approveDelivery');
    expect(search.detail).toContain('Query: approveDelivery');
    expect(search.detail).toContain('Results: 12');
    const failedSearch = parseAutonomousProgressPhase(
      'investigation_turn turn=3 action=search phase=investigate remaining=3 requested=search completed=search scope=workspace error=search_timed_out ok=false reads=0 unique_files=0 query=classifyRuntimeError',
    );
    expect(failedSearch.title).toContain('Search failed for classifyRuntimeError');
    expect(failedSearch.detail).toContain('Error: search_timed_out');
    const rangedRead = parseAutonomousProgressPhase(
      'investigation_turn turn=1 action=read_file phase=investigate remaining=5 requested=read_file completed=read_file path=index.js range=2-2 delivered_chars=31 ok=true reads=1 unique_files=1',
    );
    expect(rangedRead.detail).toContain('Delivered to model: 31 chars');
  });

  it('renders investigation recovery, cloud recovery, and stop reasons', () => {
    expect(parseAutonomousProgressPhase('investigation_recovery reason=empty_content attempt=1/1').title)
      .toBe('Retrying an unusable model response');
    const cloud = parseAutonomousProgressPhase(
      'investigation_cloud_recovery reason=investigation_exhausted from=qwen3.8:27b-mtp-q4_K_M to=openai/gpt-5.6-sol',
    );
    expect(cloud.title).toBe('Recovering via the configured cloud model');
    expect(cloud.detail).toContain('To: openai/gpt-5.6-sol');
    expect(parseAutonomousProgressPhase('investigation_stop reason=turn_limit_exceeded').title)
      .toBe('Investigation stopped: allowance exhausted');
    expect(parseAutonomousProgressPhase('investigation_cloud_skipped reason=insufficient_evidence reads=0 unique_files=0').title)
      .toBe('Cloud recovery skipped: not enough investigation evidence');
    expect(parseAutonomousProgressPhase('investigation_transcript_compacted budget=7000 kept_reads=2 omitted_read_bodies=1').title)
      .toContain('Compacted investigation evidence');
  });

  it('falls back gracefully for phase strings unknown to this parser (forward/backward compatibility)', () => {
    const event = parseAutonomousProgressPhase('some_future_phase_not_yet_known extra=1');
    expect(event.kind).toBe('unknown');
    expect(event.title).toContain('some_future_phase_not_yet_known');
    expect(() => renderAutonomousProgressEventPlain(event)).not.toThrow();
  });

  it('does not leak raw error text unbounded for runtime_error phases', () => {
    const huge = 'x'.repeat(5000);
    const event = parseAutonomousProgressPhase(`runtime_error ${huge}`);
    expect(event.detail[0].length).toBeLessThan(320);
  });

  it('renders proposal repair progression cleanly without technical leak', () => {
    const needed = parseAutonomousProgressPhase('investigation_proposal_repair stage=needed code=operation_content_required');
    expect(needed.kind).toBe('proposal_repair');
    expect(needed.title).toBe('Proposal needed repair — Missing replacement content');
    expect(needed.detail).toContain('Reason: Missing replacement content');

    const attempted = parseAutonomousProgressPhase('investigation_proposal_repair stage=attempted');
    expect(attempted.title).toBe('Automatic repair attempted');

    const invalid = parseAutonomousProgressPhase('investigation_proposal_repair stage=invalid code=operation_content_required');
    expect(invalid.title).toBe('Repair still invalid');

    const stopped = parseAutonomousProgressPhase('investigation_stop reason=invalid_proposal');
    expect(stopped.title).toBe('Task stopped safely');

    const succeeded = parseAutonomousProgressPhase('investigation_proposal_repair stage=succeeded');
    expect(succeeded.title).toBe('Proposal repair succeeded');
  });

  it('renders lightweight proposal execution and mutation evidence in assistant language', () => {
    const lightweight = parseAutonomousProgressPhase('lightweight_proposal_execution tier=normal model=qwen3.8:27b');
    expect(lightweight.title).toBe('Reviewing the relevant files…');
    expect(lightweight.detail).toEqual(['Tier: normal', 'Model: qwen3.8:27b']);

    const mutationSingle = parseAutonomousProgressPhase('mutation_evidence_verified revision=1 changed=1 alreadySatisfied=false');
    expect(mutationSingle.title).toBe('✓ Updated 1 file');

    const mutationMultiple = parseAutonomousProgressPhase('mutation_evidence_verified revision=1 changed=3 alreadySatisfied=false');
    expect(mutationMultiple.title).toBe('✓ Updated 3 files');
  });
});
