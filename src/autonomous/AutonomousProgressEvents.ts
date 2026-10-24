/**
 * Typed, bounded progress-event model for M15 autonomous tasks. Production code
 * emits terse machine-readable phase strings (see M15AutonomousRuntime/
 * GovernedCodingExecutor); this module is the single place that parses those
 * strings into a structured event and the single place that renders a structured
 * event into a human-readable multi-line block. Never carries prompt text, file
 * contents, secrets, or unbounded error detail — only stage identity, counts,
 * paths, and durations already present in the terse phase string.
 */

export interface AutonomousProgressEvent {
  /** Stable machine-readable key for the event kind, e.g. "graph_stage_started". */
  kind: string;
  /** Short human-readable headline, e.g. "Stage 2/5 — Planner". */
  title: string;
  /** Bounded "Label: value" detail lines rendered indented under the title. */
  detail: string[];
}

const MAX_DETAIL_VALUE_LENGTH = 300;
const MAX_DETAIL_LINES = 12;

const STAGE_LABELS: Record<string, string> = {
  'repository-analyst': 'Repository Analyst',
  planner: 'Planner',
  implementer: 'Implementer',
  reviewer: 'Reviewer',
  validator: 'Validator',
};

const STAGE_ACTIVITY: Record<string, string> = {
  'repository-analyst': 'Reading the repository and selecting the files relevant to this task.',
  planner: 'Designing the smallest safe implementation plan.',
  implementer: 'Drafting the exact repository change as a structured proposal.',
  reviewer: 'Checking the proposal for scope, correctness, and risk.',
  validator: 'Producing the final proposal that the host can verify and execute.',
};

function bound(value: string): string {
  return value.length > MAX_DETAIL_VALUE_LENGTH ? `${value.slice(0, MAX_DETAIL_VALUE_LENGTH)}…` : value;
}

function stageLabel(stage: string): string {
  return STAGE_LABELS[stage] ?? stage;
}

function stageActivity(stage: string): string {
  return STAGE_ACTIVITY[stage] ?? 'Running this stage of the governed workflow.';
}

function yesNo(value: string | undefined): string {
  return value === 'true' ? 'yes' : 'no';
}

function reasonLabel(reason: string): string {
  switch (reason) {
    case 'target_exists': return 'target already exists';
    case 'target_missing': return 'target missing';
    case 'duplicate_target': return 'duplicate target path';
    default: return reason;
  }
}

function gateLabel(gate: string): string {
  switch (gate) {
    case 'proposal': return 'coding proposal';
    case 'execution':
    case 'mutation': return 'repository mutation';
    case 'delivery': return 'delivery';
    case 'graph_dispatch': return 'workflow dispatch';
    default: return gate;
  }
}

function extraApprovalDetails(extra: string | undefined): string[] {
  if (!extra) return [];
  const details: string[] = [];
  for (const token of extra.split(/\s+/)) {
    const separator = token.indexOf('=');
    if (separator <= 0) continue;
    const key = token.slice(0, separator);
    const value = token.slice(separator + 1);
    if (!value || key === 'proposalId' || key === 'requestId') continue;
    if (key === 'version') details.push(`Proposal version: ${bound(value)}`);
    else if (key === 'reason') details.push(`Reason: ${bound(value.replace(/_/g, ' '))}`);
    else if (key === 'elevated') details.push(`Elevated approval: ${yesNo(value)}`);
  }
  return details;
}

/** Parses one terse machine-readable phase/log string into a structured,
 * bounded progress event. Unknown strings degrade gracefully to a fallback
 * event carrying the raw (bounded) string as the title — this keeps the
 * renderer safe for phase strings from older task records or future additions. */
export function parseAutonomousProgressPhase(phase: string): AutonomousProgressEvent {
  const raw = bound(phase);

  let match: RegExpMatchArray | null;

  if (phase === 'preparing') {
    return { kind: 'preparing', title: 'Preparing an isolated workspace', detail: ['Checking task integrity and creating a governed Git worktree.'] };
  }
  if ((match = /^approval_auto_approved gate=(\S+) policy=(\S+)$/.exec(phase))) {
    return {
      kind: 'approval_auto_approved',
      title: 'Governance check passed',
      detail: [`Gate: ${gateLabel(match[1])}`, `Policy: ${match[2]}`, 'The autonomous workflow may start; write and delivery approvals are still required.'],
    };
  }
  // Task-Scoped Autonomy V1 — the task's own frozen Hands-off mode resolved
  // this ordinary gate itself, the instant it opened; no approval card was
  // ever shown for it. Rendered as a calm, completed-looking line — the same
  // shape as approval_auto_approved above — never as anything resembling a
  // pending "Approval required" card.
  if ((match = /^approval_auto_authorized gate=(\S+) policy=(\S+)(?:\s+id=(\S+))?$/.exec(phase))) {
    const label = gateLabel(match[1]);
    return {
      kind: 'approval_auto_authorized',
      title: `${label[0].toUpperCase()}${label.slice(1)} automatically authorized`,
      detail: ['Task was started in Hands-off mode; this ordinary approval was resolved automatically.'],
    };
  }
  if (phase === 'running') {
    return { kind: 'running', title: 'Governed workflow started', detail: ['KarkeDikha is working inside the isolated task worktree.'] };
  }
  if (phase.startsWith('investigation_turn ')) {
    return parseInvestigationTurnPhase(phase);
  }
  if ((match = /^investigation_recovery reason=(\S+) attempt=(\S+)$/.exec(phase))) {
    return {
      kind: 'investigation_recovery',
      title: 'Retrying an unusable model response',
      detail: [`Reason: ${bound(match[1])}`, `Attempt: ${match[2]}`],
    };
  }
  if ((match = /^investigation_cloud_recovery reason=(\S+) from=(\S+) to=(\S+)$/.exec(phase))) {
    return {
      kind: 'investigation_cloud_recovery',
      title: 'Recovering via the configured cloud model',
      detail: [`Reason: ${bound(match[1])}`, `From: ${bound(match[2])}`, `To: ${bound(match[3])}`],
    };
  }
  if ((match = /^investigation_transcript_compacted budget=(\S+) kept_reads=(\S+) omitted_read_bodies=(\S+)$/.exec(phase))) {
    return {
      kind: 'investigation_transcript_compacted',
      title: 'Compacted investigation evidence to fit the local context budget',
      detail: [`Budget: ${match[1]} chars`, `Kept reads: ${match[2]}`, `Omitted read bodies: ${match[3]}`],
    };
  }
  if ((match = /^investigation_cloud_skipped reason=(\S+) reads=(\S+) unique_files=(\S+)$/.exec(phase))) {
    return {
      kind: 'investigation_cloud_skipped',
      title: 'Cloud recovery skipped: not enough investigation evidence',
      detail: [`Reason: ${bound(match[1])}`, `Completed reads: ${match[2]}`, `Unique files: ${match[3]}`],
    };
  }
  if ((match = /^investigation_proposal_repair stage=(\S+)(?: code=(\S+))?$/.exec(phase))) {
    const [, stage, code] = match;
    const readableCode = code ? humanizeProposalErrorCode(code) : undefined;
    const detail: string[] = [];
    if (code) detail.push(`Reason: ${readableCode || code}`);
    const title = stage === 'needed'
      ? readableCode ? `Proposal needed repair — ${readableCode}` : 'Proposal needed repair'
      : stage === 'attempted'
      ? 'Automatic repair attempted'
      : stage === 'invalid'
      ? 'Repair still invalid'
      : stage === 'succeeded'
      ? 'Proposal repair succeeded'
      : 'Repairing proposal';
    return { kind: 'proposal_repair', title, detail };
  }
  if ((match = /^investigation_stop reason=(\S+)(?: errors=(.*))?$/.exec(phase))) {
    const detail = [`Stop reason: ${bound(match[1])}`];
    if (match[2]) detail.push(`Codes: ${bound(match[2])}`);
    return { kind: 'investigation_stop', title: investigationStopTitle(match[1]), detail };
  }
  if (phase === 'readiness_check') {
    return { kind: 'readiness_check', title: 'Checking repository safety', detail: ['Verifying the workspace, Git state, permissions, and execution readiness.'] };
  }
  if (phase === 'graph_execution') {
    return { kind: 'graph_execution', title: 'Starting the five-stage repository workflow', detail: ['Analysis, planning, implementation, review, and validation run sequentially.'] };
  }
  if ((match = /^graph_stage_started stage=(\S+) index=(\d+)\/(\d+) model=(\S+) provider=(\S+)$/.exec(phase))) {
    const [, stage, index, total, model, provider] = match;
    return {
      kind: 'graph_stage_started',
      title: `Stage ${index}/${total} — ${stageLabel(stage)}`,
      detail: [stageActivity(stage), `Provider: ${bound(provider)}`, `Model: ${bound(model)}`],
    };
  }
  if ((match = /^graph_stage_completed stage=(\S+) index=(\d+)\/(\d+) durationMs=(\d+)$/.exec(phase))) {
    const [, stage, index, total, durationMs] = match;
    return {
      kind: 'graph_stage_completed',
      title: `Stage ${index}/${total} — ${stageLabel(stage)} completed`,
      detail: [`Finished in ${(Number(durationMs) / 1000).toFixed(1)} s; handing the result to the next governed step.`],
    };
  }
  if ((match = /^graph_stage_(failed|cancelled|timed_out) stage=(\S+) index=(\d+)\/(\d+) durationMs=(\d+)$/.exec(phase))) {
    const [, outcome, stage, index, total, durationMs] = match;
    const label = outcome === 'timed_out' ? 'timed out' : outcome;
    return {
      kind: `graph_stage_${outcome}`,
      title: `Stage ${index}/${total} — ${stageLabel(stage)} ${label}`,
      detail: [`Duration: ${(Number(durationMs) / 1000).toFixed(1)} s`],
    };
  }
  if (phase === 'proposal_generated') {
    return {
      kind: 'proposal_generated',
      title: 'Structured proposal generated',
      detail: ['Checking its JSON shape, allowed paths, validation commands, and current Git snapshot.'],
    };
  }
  if ((match = /^proposal_operation_count operations=(\d+)$/.exec(phase))) {
    const count = Number(match[1]);
    return { kind: 'proposal_operation_count', title: 'Proposal scope identified', detail: [`${count} file operation${count === 1 ? '' : 's'} proposed.`] };
  }
  if ((match = /^proposal_validation_failed operation=(\d+)\/(\d+) action=(\S+) path=(.+?) reason=(\S+) mutation_started=(\S+)$/.exec(phase))) {
    const [, opIndex, opTotal, action, path, reason, mutationStarted] = match;
    return {
      kind: 'proposal_validation_failed',
      title: 'Proposal validation failed',
      detail: [
        `Operation: ${opIndex} of ${opTotal}`,
        `Action: ${action}`,
        `Path: ${bound(path)}`,
        `Reason: ${reasonLabel(reason)}`,
        `Mutation started: ${yesNo(mutationStarted)}`,
      ],
    };
  }
  if ((match = /^proposal_regeneration_started attempt=(\d+)\/(\d+)$/.exec(phase))) {
    return { kind: 'proposal_regeneration_started', title: `Repairing the proposal — attempt ${match[1]} of ${match[2]}`, detail: ['No repository mutation has started.'] };
  }
  if ((match = /^proposal_regenerated operations=(\d+)$/.exec(phase))) {
    return { kind: 'proposal_regenerated', title: 'Proposal repaired', detail: [`Operation count: ${match[1]}`] };
  }
  if (phase === 'proposal_validation_passed') {
    return { kind: 'proposal_validation_passed', title: 'Repaired proposal verified', detail: [] };
  }
  if ((match = /^proposal_regeneration_failed attempt=(\d+)\/(\d+)$/.exec(phase))) {
    return { kind: 'proposal_regeneration_failed', title: `Proposal repair failed — attempt ${match[1]} of ${match[2]}`, detail: [] };
  }
  if (phase === 'proposal_ready') {
    return { kind: 'proposal_ready', title: 'Proposal verified and ready for review', detail: ['Opening the coding-proposal approval gate in KarkeDikha.'] };
  }
  if ((match = /^approval_(requested|waiting|approved|rejected|expired|revision_requested|denied|interrupted) gate=(\S+) actor=(\S+)(?:\s+(.*))?$/.exec(phase))) {
    const [, state, gate, actor, extra] = match;
    const label = gateLabel(gate);
    const titles: Record<string, string> = {
      requested: `Approval requested for ${label}`,
      waiting: `Waiting for ${label} approval`,
      approved: `${label[0].toUpperCase()}${label.slice(1)} approved`,
      rejected: `${label[0].toUpperCase()}${label.slice(1)} rejected`,
      expired: `${label[0].toUpperCase()}${label.slice(1)} approval expired`,
      revision_requested: `Revision requested for ${label}`,
      denied: `${label[0].toUpperCase()}${label.slice(1)} denied`,
      interrupted: `${label[0].toUpperCase()}${label.slice(1)} approval interrupted`,
    };
    const detail = [`Actor: ${actor}`, ...extraApprovalDetails(extra)];
    // Task-Scoped Autonomy V1 — a hands-off task never shows a gate card for
    // its own runtime to click (see AgentPanel's surfaceProposalApproval/
    // surfaceMutationApproval/surfaceDeliveryApproval), so telling the user
    // to "review the visible gate card" here would describe UI that does not
    // exist. The approval_auto_authorized line above already reports the
    // actual resolution.
    if ((state === 'requested' || state === 'waiting') && actor !== 'hands_off_policy') {
      detail.push('Review the visible gate card; nothing will be changed by this gate until it is approved.');
    }
    return { kind: `approval_${state}`, title: titles[state], detail };
  }
  if ((match = /^lightweight_proposal_execution(?:\s+tier=(\S+))?(?:\s+model=(\S+))?$/.exec(phase))) {
    const [, tier, model] = match;
    const detail: string[] = [];
    if (tier) detail.push(`Tier: ${tier}`);
    if (model) detail.push(`Model: ${model}`);
    return {
      kind: 'lightweight_proposal_execution',
      title: 'Reviewing the relevant files…',
      detail,
    };
  }
  if (phase === 'mutating') {
    return { kind: 'mutating', title: 'Applying the approved repository change', detail: ['Writing only the approved paths inside the isolated worktree.'] };
  }
  if ((match = /^mutation_completed created=(\d+) modified=(\d+) deleted=(\d+)$/.exec(phase))) {
    const [, created, modified, deleted] = match;
    return {
      kind: 'mutation_completed',
      title: 'Repository change applied',
      detail: [`Files created: ${created}`, `Files modified: ${modified}`, `Files deleted: ${deleted}`],
    };
  }
  if ((match = /^mutation_evidence_verified(?:\s+revision=(\d+))?(?:\s+changed=(\d+))?(?:\s+alreadySatisfied=(\S+))?$/.exec(phase))) {
    const [, revision, changed, alreadySatisfied] = match;
    const count = changed ? Number(changed) : 0;
    const detail: string[] = [];
    if (revision) detail.push(`Revision: ${revision}`);
    if (changed) detail.push(`Changed paths: ${changed}`);
    if (alreadySatisfied) detail.push(`Already satisfied: ${alreadySatisfied}`);
    return {
      kind: 'mutation_evidence_verified',
      title: count === 1 ? '✓ Updated 1 file' : count > 1 ? `✓ Updated ${count} files` : '✓ Updated repository files',
      detail,
    };
  }
  if (phase === 'validating') {
    return { kind: 'validating', title: 'Preparing validation', detail: ['The isolated dependency snapshot and approved validation commands are being prepared.'] };
  }
  if ((match = /^validation_command_started index=(\d+)\/(\d+) command=(.+)$/.exec(phase))) {
    const [, index, total, command] = match;
    const boundedCommand = bound(command);
    const detail = /^npm test$/i.test(command)
      ? ['Running the complete Vitest suite in the isolated worktree. This is usually the longest validation step.']
      : /^npm run compile$/i.test(command)
        ? ['Compiling the extension source in the isolated worktree.']
        : ['Running this approved validation command in the isolated worktree.'];
    return {
      kind: 'validation_command_started',
      title: `Validation command ${index}/${total} — ${boundedCommand}`,
      detail,
    };
  }
  if ((match = /^validation_completed commands=(\d+) failed=(\d+)$/.exec(phase))) {
    const commandCount = Number(match[1]);
    const failed = Number(match[2]);
    return {
      kind: 'validation_completed',
      title: failed === 0 ? 'Validation passed' : 'Validation found failures',
      detail: [`Commands run: ${commandCount}`, `Failed: ${failed}`],
    };
  }
  if ((match = /^validation_repair_started cycle=(\d+)\/(\d+)$/.exec(phase))) {
    return {
      kind: 'validation_repair_started',
      title: `Repairing a failing validation check — cycle ${match[1]} of ${match[2]}`,
      detail: ['The repair is based on the real failing command and remains limited to the approved files and checks.'],
    };
  }
  if ((match = /^validation_repair_completed cycle=(\d+)\/(\d+) failed=(\d+)$/.exec(phase))) {
    return {
      kind: 'validation_repair_completed',
      title: Number(match[3]) === 0 ? 'Validation repair passed' : `Validation repair cycle ${match[1]} completed`,
      detail: [`Remaining failed checks: ${match[3]}`],
    };
  }
  if ((match = /^validation_repair_(unavailable|no_progress) cycle=(\d+)\/(\d+)$/.exec(phase))) {
    return {
      kind: `validation_repair_${match[1]}`,
      title: match[1] === 'no_progress' ? 'Validation repair stopped because it made no progress' : 'A safe validation repair was unavailable',
      detail: [`Repair cycle: ${match[2]} of ${match[3]}`],
    };
  }
  if (phase === 'waiting_for_delivery_approval') {
    return { kind: 'waiting_for_delivery_approval', title: 'Ready for delivery approval', detail: ['Validation and diff review passed. Commit, push, and draft-PR creation still require approval.'] };
  }
  if ((match = /^m16_gate_result status=(\S+) findings=(\d+)$/.exec(phase))) {
    const [, status, findings] = match;
    return {
      kind: 'm16_gate_result',
      title: status === 'passed' ? 'M16 quality gate passed' : `M16 quality gate: ${status}`,
      detail: [`Findings: ${findings}`],
    };
  }
  if ((match = /^blocked:(\S+?)(?: operation=(\d+)\/(\d+) path=(.+?) mutation_started=(\S+))?$/.exec(phase))) {
    const [, classification, opIndex, opTotal, path, mutationStarted] = match;
    const detail: string[] = [];
    if (opIndex && opTotal) detail.push(`Operation: ${opIndex} of ${opTotal}`);
    if (path) detail.push(`Path: ${bound(path)}`);
    if (mutationStarted) detail.push(`Mutation started: ${yesNo(mutationStarted)}`);
    return { kind: 'blocked', title: `Task blocked: ${classification}`, detail };
  }
  if ((match = /^cancelled:(\S+)$/.exec(phase))) {
    return { kind: 'cancelled', title: 'Task cancelled', detail: [`Reason: ${match[1]}`] };
  }
  if ((match = /^runtime_error (.*)$/.exec(phase))) {
    return { kind: 'runtime_error', title: 'Runtime error', detail: [bound(match[1])] };
  }

  // M42 recovery control plane: what the task-level controller decided and what will change next.
  if ((match = /^recovery_decision seq=(\d+) action=(\S+) cause=(\S+) subcode=(\S+)((?: \S+=\S+)*)$/.exec(phase))) {
    const extras = new Map<string, string>();
    for (const pair of match[5].trim().split(' ').filter(Boolean)) {
      const index = pair.indexOf('=');
      extras.set(pair.slice(0, index), pair.slice(index + 1));
    }
    const detail = [`Cause: ${bound(match[3])}${match[4] !== 'none' ? ` (${bound(match[4])})` : ''}`];
    if (extras.has('change')) detail.push(`What changes next: ${bound(extras.get('change')!.replace(/\+/g, ', ').replace(/_/g, ' '))}`);
    if (extras.has('model')) detail.push(`Model: ${bound(extras.get('model')!)}`);
    const terminal = extras.get('terminal');
    if (terminal) {
      return { kind: 'recovery_stopped', title: `Recovery stopped: ${terminalLabel(terminal)}`, detail };
    }
    return { kind: 'recovery_decision', title: recoveryActionTitle(match[2]), detail };
  }
  if ((match = /^recovery_resume_validation mutation_already_applied=true$/.exec(phase))) {
    return { kind: 'recovery_resume_validation', title: 'Resuming at validation', detail: ['The change is already in the isolated worktree; it will not be applied again.'] };
  }
  if ((match = /^recovery_stale_approval_rejected reason=(\S+)$/.exec(phase))) {
    return { kind: 'recovery_stale_approval_rejected', title: 'Earlier approval no longer applies', detail: [`Reason: ${bound(match[1])}`, 'The task contract changed after that approval, so a fresh proposal will be reviewed.'] };
  }
  if ((match = /^proposal_ungrounded paths=(.*)$/.exec(phase))) {
    return { kind: 'proposal_ungrounded', title: 'Proposal rejected: not grounded in current file content', detail: [`Files: ${bound(match[1])}`, 'No mutation has started.'] };
  }

  // Backward-compatible fallback: older/unknown phase strings (including task
  // records predating this module) render as a bare, bounded title with no detail.
  return { kind: 'unknown', title: raw, detail: [] };
}

/** Renders one structured event as a bounded, multi-line plain-text block,
 * matching the terminal/log-channel presentation. Caller supplies the timestamp
 * so tests are deterministic. */
export function renderAutonomousProgressEventPlain(event: AutonomousProgressEvent, timestamp: Date = new Date()): string {
  const time = formatLocalClock(timestamp);
  const detail = event.detail.slice(0, MAX_DETAIL_LINES);
  const lines = [`${time}  ${event.title}`, ...detail.map(line => `           ${line}`)];
  return lines.join('\n');
}

function formatLocalClock(timestamp: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(timestamp.getHours())}:${pad(timestamp.getMinutes())}:${pad(timestamp.getSeconds())}`;
}

function parseKeyedTokens(phase: string): Record<string, string> {
  const fields: Record<string, string> = {};
  const body = phase.replace(/^\S+\s*/, '');
  const queryMarker = /(^|\s)query=/;
  const queryMatch = queryMarker.exec(body);
  const main = queryMatch ? body.slice(0, queryMatch.index).trim() : body;
  if (queryMatch) {
    fields.query = body.slice(body.indexOf('query=') + 'query='.length);
  }
  for (const token of main.split(/\s+/).filter(Boolean)) {
    const separator = token.indexOf('=');
    if (separator <= 0) continue;
    fields[token.slice(0, separator)] = token.slice(separator + 1);
  }
  return fields;
}

function parseInvestigationTurnPhase(phase: string): AutonomousProgressEvent {
  const fields = parseKeyedTokens(phase);
  const action = fields.action || 'invalid_action';
  const requested = fields.requested || action;
  const completed = fields.completed;
  const remaining = fields.remaining;
  const reads = fields.reads;
  const uniqueFiles = fields.unique_files;
  const detail: string[] = [];
  if (requested && completed && requested !== completed) {
    detail.push(`Requested: ${requested}`, `Completed: ${completed}`);
  } else if (requested) {
    detail.push(`Requested: ${requested}`);
  }
  if (fields.path) detail.push(`Path: ${bound(fields.path)}`);
  if (fields.range) detail.push(`Range: ${fields.range}`);
  if (fields.delivered_chars) detail.push(`Delivered to model: ${fields.delivered_chars} chars`);
  if (fields.truncated === 'true') detail.push('Truncated: yes');
  if (fields.scope) detail.push(`Scope: ${bound(fields.scope)}`);
  if (fields.results) detail.push(`Results: ${fields.results}`);
  if (fields.error) detail.push(`Error: ${bound(fields.error)}`);
  if (fields.query) detail.push(`Query: ${bound(fields.query)}`);
  if (reads) detail.push(`Completed reads: ${reads}`);
  if (uniqueFiles) detail.push(`Unique files: ${uniqueFiles}`);
  if (remaining) detail.push(`Remaining investigation allowance: ${remaining}`);
  if (fields.phase) detail.push(`Phase: ${fields.phase}`);
  if (fields.recovery) detail.push(`Recovery: ${bound(fields.recovery)}`);
  if (fields.ok === 'false') detail.push('Completed: no');
  return {
    kind: `investigation_${action}`,
    title: investigationTurnTitle(action, fields),
    detail,
  };
}

function investigationTurnTitle(action: string, fields: Record<string, string>): string {
  switch (action) {
    case 'read_file':
      return fields.path
        ? `Reading ${bound(fields.path)}${fields.range ? ` (${fields.range})` : ''}`
        : 'Reading a repository file';
    case 'search':
      if (fields.ok === 'false') {
        return fields.query ? `Search failed for ${bound(fields.query)}` : 'Search failed';
      }
      return fields.query ? `Searching for ${bound(fields.query)}` : 'Searching the repository';
    case 'submit_proposal':
      return 'Submitting a coding proposal';
    case 'insufficient_context':
      return 'Investigation needs more context';
    case 'no_change_claim':
      return 'Investigation claims no change is needed';
    case 'invalid_action':
      return 'Investigation response was not usable';
    default:
      return `Investigation: ${bound(action)}`;
  }
}

function investigationStopTitle(reason: string): string {
  switch (reason) {
    case 'proposal': return 'Investigation produced a proposal';
    case 'insufficient_context': return 'Investigation stopped: more context needed';
    case 'no_change_claim': return 'Investigation stopped: no-change claim';
    case 'invalid_proposal': return 'Task stopped safely';
    case 'dispatch_failed': return 'Investigation stopped: unusable model response';
    case 'turn_limit_exceeded': return 'Investigation stopped: allowance exhausted';
    default: return `Investigation stopped: ${bound(reason)}`;
  }
}

function humanizeProposalErrorCode(code: string): string {
  switch (code) {
    case 'operation_content_required': return 'Missing replacement content';
    case 'validation_command_not_allowed': return 'Unsupported validation command';
    case 'path_rejected': return 'Target path not allowed';
    case 'duplicate_proposal_target': return 'Duplicate file operation';
    case 'invalid_json': return 'Malformed proposal format';
    case 'empty_operations': return 'No file operations proposed';
    default: return code.replace(/_/g, ' ');
  }
}

function recoveryActionTitle(action: string): string {
  switch (action) {
    case 'REINVESTIGATE': return 'Gathering missing evidence and re-investigating';
    case 'FORMAT_REPAIR': return 'Retrying with strict format guidance';
    case 'REPLAN': return 'Re-planning the approach';
    case 'VALIDATION_REPAIR': return 'Repairing the validation failure';
    case 'CHANGE_MODEL': return 'Switching to another permitted model';
    case 'RETRY_OPERATION': return 'Retrying after a transient problem';
    default: return `Recovery: ${action.toLowerCase().replace(/_/g, ' ')}`;
  }
}

function terminalLabel(terminalState: string): string {
  switch (terminalState) {
    case 'NO_PROGRESS': return 'no progress (the same attempt would repeat)';
    case 'BUDGET_EXHAUSTED': return 'budget exhausted';
    case 'NO_CAPABLE_MODEL': return 'no capable permitted model';
    case 'BLOCKED_RESUMABLE': return 'blocked, can be resumed';
    case 'WAITING_FOR_APPROVAL': return 'waiting for approval';
    case 'FAILED_TERMINAL': return 'failed';
    default: return terminalState.toLowerCase().replace(/_/g, ' ');
  }
}
