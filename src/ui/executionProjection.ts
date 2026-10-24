/**
 * Kaam ka Dhaaga — the ONE projection from real runtime events to what the user sees as current execution state.
 *
 * Every primary current-state surface (the Dhaaga thread, Operator Context, the status line, the composer cue and
 * the approval cue) consumes the `UIExecutionState` this reducer produces. It is a projection, not a state machine:
 * it never decides what happens, it only records what the runtime reported. It never reads model prose, and a
 * stage appears only after the corresponding real event happened.
 *
 * Pure (no VS Code, no clock except an injected one) so it is unit-testable and a restart can rebuild it.
 */
import { classifyCallKind } from '../../core/runtime/completionGate';
import { answerAsksUserToFetchRepoFiles } from '../repository/RepoEvidencePlans';

export type RunMode = 'baat_kar' | 'saath_kar' | 'karke_dikha';

export type StageId =
  | 'repo_scanning'
  | 'computing'
  | 'reading_files'
  | 'planning'
  | 'delegated'
  | 'coding'
  | 'building'
  | 'testing'
  | 'running_command'
  | 'reviewing'
  | 'waiting_approval'
  | 'change_required'
  | 'mode_started'
  | 'completed'
  | 'blocked'
  | 'needs_input'
  | 'failed'
  | 'cancelled';

export type NodeStatus = 'queued' | 'active' | 'done' | 'delegated' | 'waiting' | 'blocked' | 'failed' | 'cancelled';

export type RunPhase = 'running' | 'waiting_approval' | 'needs_mode_change' | 'completed' | 'blocked' | 'needs_input' | 'failed' | 'cancelled';

/**
 * How a run ended. COMPLETED means the user's requested objective was actually satisfied; BLOCKED means the work
 * finished but the requested information/result could not be obtained; NEEDS_INPUT means the next step is the user's.
 */
export type TerminalOutcome = 'completed' | 'blocked' | 'needs_input' | 'failed' | 'cancelled';

export interface DhaagaBranch {
  id: string;
  label: string;
  status: NodeStatus;
}

export interface DhaagaNode {
  id: string;
  stage: StageId;
  status: NodeStatus;
  title: string;
  subtitle: string;
  /** Compact useful facts (file names, counts, a short command) — never raw tool JSON. */
  facts: string[];
  /** Technical lines for "Show details" only. */
  details: string[];
  branches: DhaagaBranch[];
  /** Set on the waiting-for-approval node when the underlying approval is known. */
  approvalId?: string;
}

export interface UIExecutionState {
  runId: string;
  mode: RunMode;
  modeLabel: string;
  request: string;
  nodes: DhaagaNode[];
  currentNodeId: string | null;
  phase: RunPhase;
  /** True until the run reaches a terminal phase. */
  active: boolean;
  statusText: string;
  /** One compact live row, updated in place ('' when nothing is in flight). */
  live: string;
  /** Epoch ms the live row started, so the view can show elapsed time without new messages. */
  liveSince: number | null;
  pandaAsset: string;
  /** Bumps on every visible change so consumers can ignore stale snapshots. */
  revision: number;
}

export interface DhaagaPatch {
  state: Omit<UIExecutionState, 'nodes'>;
  /** Only the nodes that changed, keyed by stable id. */
  upserts: DhaagaNode[];
}

const MODE_LABELS: Record<RunMode, string> = {
  baat_kar: 'Baat Kar',
  saath_kar: 'Saath Kar',
  karke_dikha: 'Karke Dikha',
};

const STAGE_COPY: Record<StageId, { title: string; subtitle: string }> = {
  repo_scanning: { title: 'Repo dekh raha hoon...', subtitle: 'Scanning the repository' },
  computing: { title: 'Hisab kar raha hoon...', subtitle: 'Computing repository facts' },
  reading_files: { title: 'File padh raha hoon...', subtitle: 'Reading relevant files' },
  planning: { title: 'Soch raha hoon...', subtitle: 'Planning' },
  delegated: { title: 'Kaam baant raha hoon...', subtitle: 'Delegating parallel work' },
  coding: { title: 'Code kar raha hoon...', subtitle: 'Making changes' },
  building: { title: 'Build ho raha hai...', subtitle: 'Building the project' },
  testing: { title: 'Tests chala raha hoon...', subtitle: 'Running validation' },
  running_command: { title: 'Running command', subtitle: 'Running a command' },
  reviewing: { title: 'Review kar raha hoon...', subtitle: 'Reviewing changes' },
  waiting_approval: { title: 'Approval ka wait hai...', subtitle: 'Waiting for your approval' },
  change_required: { title: 'Change required', subtitle: 'This request needs file edits. Continue in Saath Kar?' },
  mode_started: { title: 'Saath Kar started', subtitle: 'Continuing the request with editing tools' },
  completed: { title: 'Ho gaya boss.', subtitle: 'Completed' },
  blocked: { title: 'Ruk gaya...', subtitle: 'Needs attention' },
  needs_input: { title: 'Aapka jawab chahiye...', subtitle: 'Needs your input' },
  failed: { title: 'Atak gaya.', subtitle: 'Stopped before finishing' },
  cancelled: { title: 'Rok diya.', subtitle: 'Cancelled' },
};

/** Stages each mode may show. Baat Kar is read-only conversation and never shows autonomous work stages. */
const ALLOWED_STAGES: Record<RunMode, ReadonlySet<StageId>> = {
  baat_kar: new Set<StageId>(['repo_scanning', 'computing', 'reading_files', 'planning', 'change_required', 'completed', 'blocked', 'needs_input', 'failed', 'cancelled']),
  saath_kar: new Set<StageId>(['repo_scanning', 'computing', 'reading_files', 'planning', 'coding', 'building', 'testing', 'running_command', 'reviewing', 'waiting_approval', 'mode_started', 'completed', 'blocked', 'needs_input', 'failed', 'cancelled']),
  karke_dikha: new Set<StageId>(['repo_scanning', 'computing', 'reading_files', 'planning', 'delegated', 'coding', 'building', 'testing', 'running_command', 'reviewing', 'waiting_approval', 'mode_started', 'completed', 'blocked', 'needs_input', 'failed', 'cancelled']),
};

const PANDA_FOR_STAGE: Record<StageId, string> = {
  repo_scanning: 'action-searching.webp',
  computing: 'action-thinking.webp',
  reading_files: 'action-reading.webp',
  planning: 'action-thinking.webp',
  delegated: 'action-delegating.webp',
  coding: 'action-coding.webp',
  building: 'action-building.webp',
  testing: 'action-testing.webp',
  running_command: 'mascot-working.webp',
  reviewing: 'action-reviewing.webp',
  waiting_approval: 'action-approval.webp',
  change_required: 'action-approval.webp',
  mode_started: 'mascot-working.webp',
  completed: 'mascot-done.webp',
  blocked: 'action-blocked.webp',
  needs_input: 'action-approval.webp',
  failed: 'action-failed.webp',
  cancelled: 'action-failed.webp',
};

/** Stages whose consecutive events fold into one node (many reads are one "File padh raha hoon..." step). */
const MERGEABLE: ReadonlySet<StageId> = new Set<StageId>(['repo_scanning', 'reading_files']);
const MAX_FACTS = 4;
const MAX_REQUEST_CHARS = 140;

type CommandStage = 'repo_scanning' | 'reading_files' | 'building' | 'testing' | 'running_command';

const READ_COMMAND = /^(?:type|cat|bat|head|tail|more|less|get-content|gc|sed|awk)$/i;
const SCAN_COMMAND = /^(?:dir|ls|ll|tree|find|findstr|rg|ag|grep|egrep|fgrep|select-string|sls|get-childitem|gci|where|which|wc|stat)$/i;
const SCAN_GIT = /^git\s+(?:ls-files|status|diff|log|show|grep|branch|ls-tree|rev-parse)\b/i;
const TEST_COMMAND = /^(?:(?:npm|yarn|pnpm|bun)\s+(?:run\s+)?(?:test|lint|typecheck|check|e2e)\S*|(?:npx\s+|pnpm\s+exec\s+|yarn\s+)?(?:vitest|jest|mocha|pytest|py\.test|phpunit|rspec|ctest|eslint|ruff|mypy)\b.*|python3?\s+-m\s+(?:pytest|unittest)\b.*|dotnet\s+test\b.*|cargo\s+(?:test|clippy)\b.*|go\s+(?:test|vet)\b.*|mvn\s+(?:\S+\s+)*test\b.*|gradlew?\s+(?:\S+\s+)*test\b.*)/i;
const BUILD_COMMAND = /^(?:(?:npm|yarn|pnpm|bun)\s+(?:run\s+)?(?:build|compile|bundle|package|dist|prepublish)\S*|(?:npx\s+|pnpm\s+exec\s+)?(?:tsc|esbuild|webpack|rollup|vite\s+build|msbuild|make|nmake)\b.*|dotnet\s+(?:build|publish|pack)\b.*|cargo\s+(?:build|check)\b.*|go\s+build\b.*|mvn\s+(?:\S+\s+)*(?:package|compile|install|verify)\b.*|gradlew?\s+(?:\S+\s+)*(?:build|assemble)\b.*|cmake\s+--build\b.*)/i;
const SETUP_SEGMENT = /^(?:cd|pushd|popd|set|setlocal|echo|chcp|cls|export)\b/i;

const COMMAND_PRIORITY: Record<CommandStage, number> = { testing: 4, building: 3, repo_scanning: 2, reading_files: 1, running_command: 0 };

/**
 * Cheap deterministic classification of a shell command into what it actually does. It is not a shell parser:
 * it splits on command separators, ignores navigation/setup segments, classifies each segment by its leading
 * words, and keeps the most significant. Anything unrecognised is a generic "Running command", never "Building".
 */
export function classifyCommandStage(command: string): CommandStage {
  const segments = String(command ?? '')
    .split(/&&|\|\||;|\r?\n/)
    .map((segment) => segment.split('|')[0].trim().replace(/^[@(]+/, '').replace(/^(?:cmd(?:\.exe)?\s+\/c\s+|powershell(?:\.exe)?\s+(?:-\w+\s+)*)/i, '').replace(/^["']|["']$/g, ''))
    .filter((segment) => segment && !SETUP_SEGMENT.test(segment));
  let best: CommandStage = 'running_command';
  for (const segment of segments) {
    const head = (/^\S+/.exec(segment)?.[0] ?? '').replace(/^.*[\\/]/, '').replace(/\.(?:exe|cmd|bat)$/i, '');
    let kind: CommandStage = 'running_command';
    if (TEST_COMMAND.test(segment)) kind = 'testing';
    else if (BUILD_COMMAND.test(segment)) kind = 'building';
    else if (SCAN_COMMAND.test(head) || SCAN_GIT.test(segment)) kind = 'repo_scanning';
    else if (READ_COMMAND.test(head)) kind = 'reading_files';
    if (COMMAND_PRIORITY[kind] > COMMAND_PRIORITY[best] || (best === 'running_command' && kind !== 'running_command')) best = kind;
  }
  return best;
}

export function compactRequest(text: string): string {
  const single = String(text ?? '').replace(/\s+/g, ' ').trim();
  return single.length > MAX_REQUEST_CHARS ? `${single.slice(0, MAX_REQUEST_CHARS - 1).trimEnd()}…` : single;
}

function baseName(path: string): string {
  const parts = String(path ?? '').split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? String(path ?? '');
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/** A short, human command label for a validation/build fact — never a payload. */
function compactCommand(command: string): string {
  const single = command.replace(/\s+/g, ' ').trim();
  return single.length > 60 ? `${single.slice(0, 59).trimEnd()}…` : single;
}

/** What stage a real tool call belongs to, from its name and arguments alone. */
export function stageForTool(toolName: string, args: Record<string, unknown>): StageId {
  if (toolName === 'read_file') return 'reading_files';
  if (toolName === 'propose_text_edit' || toolName === 'propose_file_change') return 'coding';
  if (toolName === 'workspace_validation') return 'testing';
  if (toolName === 'run_command' || toolName === 'run_check') return classifyCommandStage(str(args['command'] ?? args['cmd']));
  const kind = classifyCallKind(toolName, args, false);
  if (kind === 'discovery') return 'repo_scanning';
  return 'reading_files';
}

export class ExecutionProjection {
  private readonly state: UIExecutionState;
  private readonly nodes = new Map<string, DhaagaNode>();
  private readonly order: string[] = [];
  private readonly callNodes = new Map<string, string>();
  private seq = 0;
  private readonly now: () => number;
  private readonly changed = new Set<string>();

  constructor(input: { runId: string; mode: RunMode; request: string; now?: () => number }) {
    this.now = input.now ?? Date.now;
    this.state = {
      runId: input.runId,
      mode: input.mode,
      modeLabel: MODE_LABELS[input.mode],
      request: compactRequest(input.request),
      nodes: [],
      currentNodeId: null,
      phase: 'running',
      active: true,
      statusText: 'Starting',
      live: '',
      liveSince: null,
      pandaAsset: 'mascot-working.webp',
      revision: 0,
    };
  }

  /** Full snapshot (new subscriber or restored webview). */
  snapshot(): UIExecutionState {
    return { ...this.state, nodes: this.order.map((id) => this.clone(this.nodes.get(id)!)) };
  }

  // ── Real events ──────────────────────────────────────────────────────────

  /** The host's repository context pack reached the model: a real scan and read happened. */
  repositoryEvidence(paths: readonly string[], workspaceName?: string): DhaagaPatch | null {
    if (paths.length === 0) return null;
    if (workspaceName) this.touchStage('repo_scanning', { fact: workspaceName, status: 'done' });
    this.touchStage('repo_scanning', { fact: `${paths.length} relevant file${paths.length === 1 ? '' : 's'} found`, status: 'done' });
    for (const path of paths.slice(0, MAX_FACTS)) this.touchStage('reading_files', { fact: baseName(path), status: 'done' });
    if (paths.length > MAX_FACTS) this.touchStage('reading_files', { fact: `+${paths.length - MAX_FACTS} more`, status: 'done' });
    this.settleLive();
    return this.flush();
  }

  /**
   * The host COMPUTED the answer (counts, sizes, rankings) instead of reading files. Only what really happened is shown:
   * how many projects were recognised and what was computed. No file was read, so no "reading files" step exists.
   */
  repositoryFacts(summary: { recognised?: number; computing?: string }): DhaagaPatch | null {
    if (summary.recognised !== undefined) this.touchStage('repo_scanning', { fact: `${summary.recognised.toLocaleString('en-US')} project${summary.recognised === 1 ? '' : 's'} recognised`, status: 'done' });
    if (summary.computing) this.touchStage('computing', { fact: summary.computing, status: 'done' });
    this.settleLive();
    return this.flush();
  }

  toolStarted(callId: string, toolName: string, args: Record<string, unknown>): DhaagaPatch | null {
    const stage = stageForTool(toolName, args);
    if (!ALLOWED_STAGES[this.state.mode].has(stage)) return null;
    const command = str(args['command'] ?? args['cmd']);
    const path = str(args['path']);
    let fact = '';
    let live = '';
    if (stage === 'reading_files') {
      fact = path ? baseName(path) : command ? compactCommand(command) : '';
      const start = args['startLine'] ?? args['start_line'];
      const end = args['endLine'] ?? args['end_line'];
      live = `Reading ${fact || 'a file'}${start !== undefined && end !== undefined ? ` · lines ${String(start)}–${String(end)}` : ''}`;
    } else if (stage === 'repo_scanning') {
      fact = command ? compactCommand(command) : '';
      live = 'Searching the repository';
    } else if (stage === 'running_command') {
      fact = command ? compactCommand(command) : '';
      live = 'Running command';
    } else if (stage === 'coding') {
      fact = path ? `${baseName(path)} change proposed` : '';
      live = `Editing ${path ? baseName(path) : 'files'}`;
    } else if (stage === 'building' || stage === 'testing') {
      fact = command ? compactCommand(command) : '';
      live = stage === 'building' ? 'Building the project' : 'Running tests';
    }
    const id = this.touchStage(stage, {
      fact,
      status: 'active',
      detail: `${toolName} ${compactDetail(args)}`,
    });
    if (id) this.callNodes.set(callId, id);
    this.setLive(live, this.now());
    return this.flush();
  }

  toolFinished(callId: string | undefined, toolName: string, ok: boolean, evidence: Record<string, unknown> = {}, args: Record<string, unknown> = {}): DhaagaPatch | null {
    const nodeId = (callId ? this.callNodes.get(callId) : undefined) ?? this.latestNodeFor(stageForTool(toolName, args)) ?? this.touchStage(stageForTool(toolName, args), { status: 'active' });
    if (callId) this.callNodes.delete(callId);
    const node = nodeId ? this.nodes.get(nodeId) : undefined;
    if (!node) return null;
    const output = str(evidence['output']) || str(evidence['summary']);
    const exitCode = typeof evidence['exitCode'] === 'number' ? (evidence['exitCode'] as number) : undefined;
    if (node.stage === 'coding') {
      const path = str(args['path']) || str(evidence['path']);
      const label = path ? baseName(path) : '';
      this.replaceFact(node, /change proposed$/, ok ? `${label || 'File'} updated` : `${label || 'File'} change failed`);
      if (!ok) node.status = 'failed';
    } else if (node.stage === 'testing' || node.stage === 'building') {
      const passed = /(\d+)\s+(?:tests?\s+)?passed/i.exec(output);
      const failed = /(\d+)\s+(?:tests?\s+)?failed/i.exec(output);
      if (ok && passed) this.addFact(node, `${passed[1]} tests passed`);
      else if (!ok) this.addFact(node, failed ? `${failed[1]} tests failed` : `Failed${exitCode !== undefined ? ` (exit ${exitCode})` : ''}`);
      else if (node.stage === 'building') this.addFact(node, 'Build succeeded');
      if (!ok) node.status = 'failed';
    } else if (!ok) {
      this.addFact(node, 'Could not complete');
    }
    if (node.status === 'active') node.status = ok || node.stage === 'reading_files' || node.stage === 'repo_scanning' ? 'done' : 'failed';
    if (output) node.details.push(trimDetail(output));
    this.changed.add(node.id);
    this.settleLive();
    this.refreshCurrent();
    return this.flush();
  }

  /** The model produced output. Creates the planning step once, otherwise only the live row changes. */
  modelActivity(): DhaagaPatch | null {
    const hasPlanning = this.order.some((id) => this.nodes.get(id)?.stage === 'planning');
    const hasWork = this.order.some((id) => ['coding', 'building', 'testing', 'delegated'].includes(this.nodes.get(id)?.stage ?? ''));
    if (!hasPlanning && !hasWork) this.touchStage('planning', { status: 'active' });
    if (this.state.live === '' || this.state.live === 'Thinking') this.setLive('Thinking', this.state.liveSince ?? this.now());
    return this.flush();
  }

  approvalRequested(info: { approvalId?: string; toolName?: string; path?: string } = {}): DhaagaPatch | null {
    if (this.state.phase === 'waiting_approval') return null;
    this.completeActive();
    const id = this.touchStage('waiting_approval', { status: 'waiting', forceNew: true });
    const node = id ? this.nodes.get(id) : undefined;
    if (node) {
      if (info.approvalId) node.approvalId = info.approvalId;
      node.facts = ['Review required'];
    }
    this.state.phase = 'waiting_approval';
    this.settleLive();
    this.refreshCurrent();
    return this.flush();
  }

  approvalSettled(outcome: 'approved' | 'rejected' | 'unknown' = 'unknown'): DhaagaPatch | null {
    if (this.state.phase !== 'waiting_approval') return null;
    const node = [...this.order].reverse().map((id) => this.nodes.get(id)!).find((candidate) => candidate.stage === 'waiting_approval');
    if (node) {
      node.status = 'done';
      node.facts = [outcome === 'approved' ? 'Approved' : outcome === 'rejected' ? 'Not approved' : 'Decision recorded'];
      this.changed.add(node.id);
    }
    this.state.phase = 'running';
    this.refreshCurrent();
    return this.flush();
  }

  /** Baat Kar stopped before mutation: the request needs editing tools and the user must confirm the mode. */
  modeChangeRequired(): DhaagaPatch | null {
    this.completeActive();
    const id = this.touchStage('change_required', { status: 'waiting', forceNew: true });
    if (id) this.nodes.get(id)!.facts = ['Continue in Saath Kar?'];
    this.state.phase = 'needs_mode_change';
    this.settleLive();
    this.refreshCurrent();
    return this.flush();
  }

  /** The user confirmed: the same thread continues as Saath Kar and says so. */
  modeChanged(to: RunMode): DhaagaPatch | null {
    const pending = [...this.order].reverse().map((id) => this.nodes.get(id)!).find((node) => node.stage === 'change_required');
    if (pending) {
      pending.status = 'done';
      pending.facts = ['Confirmed'];
      this.changed.add(pending.id);
    }
    this.state.mode = to;
    this.state.modeLabel = MODE_LABELS[to];
    this.state.phase = 'running';
    this.state.active = true;
    this.touchStage('mode_started', { status: 'done', forceNew: true });
    this.refreshCurrent();
    return this.flush();
  }

  /** The user chose to stay in Baat Kar: the same thread continues as read-only conversation. */
  modeChangeDeclined(): DhaagaPatch | null {
    const pending = [...this.order].reverse().map((id) => this.nodes.get(id)!).find((node) => node.stage === 'change_required');
    if (pending) {
      pending.status = 'done';
      pending.facts = ['Staying in Baat Kar'];
      this.changed.add(pending.id);
    }
    this.state.phase = 'running';
    this.refreshCurrent();
    return this.flush();
  }

  /**
   * Karke Dikha: one typed autonomous progress event (kind from parseAutonomousProgressPhase). The graph stages are
   * the runtime's own delegated workers and are the only source of branches; nothing here is inferred from prose.
   */
  autonomousProgress(kind: string, title: string, detail: readonly string[] = []): DhaagaPatch | null {
    const fact = compactRequest(title).slice(0, 80);
    switch (kind) {
      case 'readiness_check':
        this.touchStage('repo_scanning', { status: 'active', fact: 'Checking repository safety' });
        break;
      case 'investigation_read_file':
        this.touchStage('reading_files', { status: 'active', fact: compactRequest(detail[0] ?? title).slice(0, 60) });
        break;
      case 'investigation_search':
        this.touchStage('repo_scanning', { status: 'active', fact: 'Searching the repository' });
        break;
      case 'graph_execution':
        this.touchStage('planning', { status: 'active', fact: 'Five-stage repository workflow' });
        break;
      case 'graph_stage_started':
      case 'graph_stage_completed':
      case 'graph_stage_failed':
      case 'graph_stage_cancelled':
      case 'graph_stage_timed_out': {
        const label = fact.replace(/^(?:starting|started|completed|finished|stage)\s*[:\-–]?\s*/i, '') || kind;
        const status: NodeStatus = kind === 'graph_stage_started' ? 'active' : kind === 'graph_stage_completed' ? 'done' : kind === 'graph_stage_cancelled' ? 'cancelled' : 'failed';
        return this.branch('Parallel work', { id: label.toLowerCase(), label, status });
      }
      case 'proposal_generated':
      case 'proposal_operation_count':
      case 'proposal_regeneration_started':
      case 'proposal_regenerated':
      case 'mutating':
        this.touchStage('coding', { status: 'active', fact: kind === 'proposal_operation_count' ? fact : undefined });
        break;
      case 'mutation_completed':
        this.touchStage('coding', { status: 'done', fact: 'Changes applied' });
        break;
      case 'proposal_validation_failed':
      case 'proposal_validation_passed':
      case 'proposal_ready':
      case 'm16_gate_result':
        this.touchStage('reviewing', { status: kind === 'proposal_validation_failed' ? 'failed' : 'active' });
        break;
      case 'approval_requested':
      case 'approval_waiting':
      case 'waiting_for_delivery_approval':
        return this.approvalRequested();
      case 'approval_approved':
      case 'approval_auto_approved':
      case 'approval_auto_authorized':
        return this.approvalSettled('approved');
      case 'approval_rejected':
      case 'approval_expired':
        return this.approvalSettled('rejected');
      case 'validating':
      case 'validation_command_started':
        this.touchStage('testing', { status: 'active', fact: kind === 'validation_command_started' ? fact : undefined });
        break;
      case 'validation_completed': {
        const match = /(\d+) failed|failed=(\d+)/i.exec(detail.join(' ') + ' ' + title);
        const failed = Number(match?.[1] ?? match?.[2] ?? 0);
        this.touchStage('testing', { status: failed > 0 ? 'failed' : 'done', fact: failed > 0 ? `${failed} check${failed === 1 ? '' : 's'} failed` : 'Validation passed' });
        break;
      }
      case 'blocked':
      case 'runtime_error':
        return this.terminal('failed', title);
      case 'cancelled':
        return this.terminal('cancelled');
      default:
        return null;
    }
    this.settleLive();
    return this.flush();
  }

  /** Karke Dikha only: independently tracked parallel work under a delegating parent. */
  branch(parentLabel: string, branch: DhaagaBranch): DhaagaPatch | null {
    if (!ALLOWED_STAGES[this.state.mode].has('delegated')) return null;
    let parentId = this.latestNodeFor('delegated');
    if (!parentId) {
      this.completeActive();
      parentId = this.touchStage('delegated', { status: 'delegated', forceNew: true, fact: parentLabel });
    }
    const parent = parentId ? this.nodes.get(parentId) : undefined;
    if (!parent) return null;
    const existing = parent.branches.find((candidate) => candidate.id === branch.id);
    if (existing) {
      existing.status = branch.status;
      existing.label = branch.label;
    } else {
      parent.branches.push({ ...branch });
    }
    parent.status = parent.branches.every((candidate) => candidate.status === 'done') ? 'done' : 'delegated';
    this.changed.add(parent.id);
    this.refreshCurrent();
    return this.flush();
  }

  terminal(outcome: TerminalOutcome, detail?: string): DhaagaPatch | null {
    if (!this.state.active) return null;
    // Work that finished before a blocked / needs-input ending really finished; only failure and cancellation interrupt it.
    const finished = outcome === 'completed' || outcome === 'blocked' || outcome === 'needs_input';
    for (const node of this.nodes.values()) {
      if (node.status === 'active' || node.status === 'delegated') {
        node.status = finished ? 'done' : outcome === 'cancelled' ? 'cancelled' : node.status === 'active' ? 'failed' : node.status;
        for (const branch of node.branches) if (branch.status === 'active') branch.status = finished ? 'done' : outcome === 'cancelled' ? 'cancelled' : 'failed';
        this.changed.add(node.id);
      }
      if (finished && node.status === 'waiting') {
        node.status = 'done';
        this.changed.add(node.id);
      }
    }
    const stage: StageId = outcome;
    const id = this.touchStage(stage, { status: outcome === 'completed' ? 'done' : outcome === 'cancelled' ? 'cancelled' : outcome === 'blocked' ? 'blocked' : outcome === 'needs_input' ? 'waiting' : 'failed', forceNew: true });
    if (id && detail && outcome !== 'cancelled') this.nodes.get(id)!.facts = [compactRequest(detail).slice(0, 120)];
    this.state.phase = outcome;
    this.state.active = false;
    this.settleLive();
    this.refreshCurrent();
    return this.flush();
  }

  // ── Internals ────────────────────────────────────────────────────────────

  private touchStage(stage: StageId, input: { status: NodeStatus; fact?: string; detail?: string; forceNew?: boolean }): string | undefined {
    if (!ALLOWED_STAGES[this.state.mode].has(stage)) return undefined;
    const last = this.order.length > 0 ? this.nodes.get(this.order[this.order.length - 1]) : undefined;
    let node: DhaagaNode | undefined;
    if (!input.forceNew && last && last.stage === stage && MERGEABLE.has(stage)) node = last;
    if (!node) {
      if (input.status === 'active') this.completeActive();
      this.seq += 1;
      const copy = STAGE_COPY[stage];
      node = { id: `${stage}-${this.seq}`, stage, status: input.status, title: copy.title, subtitle: copy.subtitle, facts: [], details: [], branches: [] };
      this.nodes.set(node.id, node);
      this.order.push(node.id);
    } else if (node.status === 'done' && input.status === 'active') {
      node.status = 'active';
    }
    if (input.fact) this.addFact(node, input.fact);
    if (input.detail) node.details.push(trimDetail(input.detail));
    this.changed.add(node.id);
    this.refreshCurrent();
    return node.id;
  }

  private addFact(node: DhaagaNode, fact: string): void {
    if (!fact || node.facts.includes(fact)) return;
    if (node.facts.length >= MAX_FACTS) {
      const more = node.facts.findIndex((candidate) => /^\+\d+ more$/.test(candidate));
      if (more >= 0) node.facts[more] = `+${Number(/\d+/.exec(node.facts[more])![0]) + 1} more`;
      else node.facts.push('+1 more');
    } else {
      node.facts.push(fact);
    }
    this.changed.add(node.id);
  }

  private replaceFact(node: DhaagaNode, pattern: RegExp, next: string): void {
    const index = node.facts.findIndex((fact) => pattern.test(fact));
    if (index >= 0) node.facts[index] = next;
    else this.addFact(node, next);
    this.changed.add(node.id);
  }

  private completeActive(): void {
    for (const node of this.nodes.values()) {
      if (node.status === 'active') {
        node.status = 'done';
        this.changed.add(node.id);
      }
    }
  }

  private latestNodeFor(stage: StageId): string | undefined {
    for (let i = this.order.length - 1; i >= 0; i--) if (this.nodes.get(this.order[i])?.stage === stage) return this.order[i];
    return undefined;
  }

  private setLive(text: string, since: number | null): void {
    if (this.state.live === text) return;
    this.state.live = text;
    this.state.liveSince = text ? since : null;
    this.liveChanged = true;
  }

  private liveChanged = false;

  private settleLive(): void {
    if (this.state.live === '') return;
    this.state.live = '';
    this.state.liveSince = null;
    this.liveChanged = true;
  }

  /** Exactly one node is current: the active one, else the waiting/delegated one, else the latest. */
  private refreshCurrent(): void {
    const nodes = this.order.map((id) => this.nodes.get(id)!);
    const current = [...nodes].reverse().find((node) => node.status === 'active')
      ?? [...nodes].reverse().find((node) => node.status === 'waiting' || node.status === 'delegated')
      ?? nodes[nodes.length - 1];
    this.state.currentNodeId = current?.id ?? null;
    if (!current) return;
    this.state.pandaAsset = PANDA_FOR_STAGE[current.stage];
    this.state.statusText = !this.state.active
      ? STAGE_COPY[current.stage].subtitle
      : this.state.phase === 'waiting_approval'
        ? 'Waiting for your approval'
        : this.state.phase === 'needs_mode_change'
          ? 'Waiting for your decision'
          : current.status === 'active' || current.status === 'delegated'
            ? current.subtitle
            : 'Working';
  }

  private flush(): DhaagaPatch | null {
    if (this.changed.size === 0 && !this.liveChanged) return null;
    this.state.revision += 1;
    const upserts = [...this.changed].map((id) => this.nodes.get(id)).filter((node): node is DhaagaNode => Boolean(node)).map((node) => this.clone(node));
    this.changed.clear();
    this.liveChanged = false;
    const { nodes: _omit, ...rest } = this.state;
    void _omit;
    return { state: { ...rest }, upserts };
  }

  private clone(node: DhaagaNode): DhaagaNode {
    return { ...node, facts: [...node.facts], details: [...node.details], branches: node.branches.map((branch) => ({ ...branch })) };
  }
}

/**
 * A repository turn the runtime calls "completed" can still be a refusal: the model answered "I have no tools to list
 * directories" or "could not determine it" and told the user to run a command. That is not the user's objective being
 * satisfied. This is a narrow, conservative guard on the FINAL answer of a repository turn only: it recognises the model
 * stating it lacks access/tools/evidence (or handing the work back to the user) near the start of a short answer. It does
 * not fire for ordinary answers that merely mention a limitation inside real content.
 */
export function answerIsEvidenceRefusal(answer: string): boolean {
  const text = String(answer ?? '').trim();
  if (!text) return false;
  const head = text.slice(0, 420);
  const inability = /\b(?:i|we)\s+(?:do not|don't|cannot|can't|can not|couldn't|could not|am unable to|'m unable to|am not able to|have no|had no)\s+(?:have\s+)?(?:access|tools?|way|ability|run|execute|list|determine|count|measure|verify|see|view|browse|inspect|read|compute|calculate)\b/i;
  const noEvidence = /\b(?:could not|couldn't|cannot|can't|unable to) (?:determine|compute|calculate|find out|tell)\b|\b(?:evidence|context|information) (?:contained|contains|has|had|includes?) no\b|\bno (?:size )?metrics\b|\b(?:does not|doesn't|did not|didn't) (?:contain|include|provide|have)\b[^.\n]{0,40}\b(?:metrics?|size|counts?|information|data)\b/i;
  const handBack = /\b(?:please|you (?:can|could|may|should|will need to|'ll need to)|try to|simply|just)\b[^.\n]{0,80}\b(?:run|execute|use|open)\b[^.\n]{0,80}\b(?:powershell|command prompt|cmd|terminal|shell|command|get-childitem|dir|ls|tree|find)\b/i;
  if (handBack.test(text.slice(0, 900))) return true;
  return text.length <= 900 && (inability.test(head) || noEvidence.test(head));
}

/**
 * How a runtime-"completed" turn really ended. Host-known facts decide first (a clarification was needed, the host's own
 * computation failed); otherwise a Baat Kar repository turn whose final answer is an evidence/tool refusal is blocked.
 * Only an answer that satisfies the request is COMPLETED.
 */
export function classifyTerminalOutcome(input: {
  hostOutcome?: 'completed' | 'needs_input' | 'blocked';
  measured?: string;
  /** The host's bounded retrieval ended with insufficient evidence (reason). The objective was not satisfied, however fluent the answer. */
  evidenceGap?: string;
  baatKarRepositoryTurn: boolean;
  answer: string;
}): { outcome: TerminalOutcome; detail?: string } {
  if (input.hostOutcome === 'needs_input') return { outcome: 'needs_input', detail: 'Waiting for your answer' };
  if (input.hostOutcome === 'blocked') return { outcome: 'blocked', detail: input.measured ?? 'Could not complete the request' };
  if (input.baatKarRepositoryTurn && input.evidenceGap) return { outcome: 'blocked', detail: `Implementation evidence was incomplete: ${input.evidenceGap}` };
  // Handing retrieval back to the user ("paste the file") is not a completed answer when the host has workspace access.
  if (input.baatKarRepositoryTurn && (answerIsEvidenceRefusal(input.answer) || answerAsksUserToFetchRepoFiles(input.answer))) {
    return { outcome: 'blocked', detail: 'The repository information needed was not obtained' };
  }
  return { outcome: 'completed', ...(input.measured ? { detail: input.measured } : {}) };
}

function compactDetail(args: Record<string, unknown>): string {
  try {
    return JSON.stringify(args).slice(0, 400);
  } catch {
    return '';
  }
}

function trimDetail(text: string): string {
  return text.length > 800 ? `${text.slice(0, 800)}…` : text;
}
