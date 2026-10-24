import * as crypto from 'crypto';
import { spawn } from 'child_process';
import { createSanitizedChildEnvironment } from '../../core/security/childEnvironment';
import * as fs from 'fs';
import * as fsp from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { Config } from '../config/Config';
import { CODING_PROPOSAL_VERSION, CodingValidationCommand, normalizeRelativePath, validateRelativeWorkspacePath } from './CodingProposal';
import { HostBoundCodingFileOperation, HostBoundCodingProposal, sha256 } from './WorkspaceMutation';
import { TransactionJournal } from './TransactionJournal';
import { isGeneratedArtifactPath } from './GeneratedArtifactPolicy';
import { UNBORN_HEAD_COMMIT } from '../orchestration/WorktreeManager';
import { GIT_REPOSITORY_UNAVAILABLE, gitPrerequisiteMessage } from './GitPrerequisites';

export { TransactionJournal } from './TransactionJournal';

export const FORGE_EXECUTION_READINESS_VERSION = 1 as const;
export const FORGE_MUTATION_CONTRACT_VERSION = 2 as const;
export const FORGE_VALIDATION_CONTRACT_VERSION = 2 as const;
export const FORGE_APPROVAL_ENVELOPE_VERSION = 1 as const;

export type FailureClassification =
  | 'workspace_mode_rejected'
  | 'workspace_untrusted'
  | 'uri_scheme_rejected'
  | 'git_repository_unavailable'
  | 'git_state_changed'
  | 'dirty_document_blocked'
  | 'workspace_lease_held'
  | 'path_policy_rejected'
  | 'runtime_provenance_rejected'
  | 'validation_semantics_changed'
  | 'approval_replay_rejected'
  | 'validation_side_effect_detected'
  | 'transaction_recovery_required'
  | 'provider_identity_mismatch'
  | 'tool_identity_stale';

export interface ForgeExecutionIssue {
  code: FailureClassification | 'warning';
  message: string;
  path?: string;
}

export interface WorkspaceIdentity {
  workspaceRoot: string;
  uriScheme: string;
  trusted: boolean;
  gitRoot?: string;
  gitCommonDir?: string;
  worktreeIdentity?: string;
  branch?: string;
  head?: string;
  detachedHead: boolean;
}

export interface ForgeExecutionReadinessResult {
  version: typeof FORGE_EXECUTION_READINESS_VERSION;
  checkedAt: string;
  extensionBuild: string;
  contracts: {
    proposal: typeof CODING_PROPOSAL_VERSION;
    mutation: typeof FORGE_MUTATION_CONTRACT_VERSION;
    validation: typeof FORGE_VALIDATION_CONTRACT_VERSION;
  };
  workspace: WorkspaceIdentity;
  editor: { dirtyTargetPaths: string[]; dirtyUnrelatedPaths: string[] };
  lease: { state: 'free' | 'held' | 'stale' | 'unknown'; ownerRunId?: string };
  runtime: RuntimeProvenance;
  pathPolicy: { supported: true; platform: NodeJS.Platform };
  transactionRecovery: { state: 'clean' | 'recovery_required'; journalPath?: string };
  processContainment: { available: boolean; strategy: 'taskkill-tree' | 'process-group' };
  networkPolicy: NetworkPolicy;
  blockingFailures: ForgeExecutionIssue[];
  warnings: ForgeExecutionIssue[];
}

export type NetworkPolicy =
  | { kind: 'network_denied' }
  | { kind: 'localhost_only' }
  | { kind: 'approved_domains'; domains: string[] };

export interface RuntimeProvenance {
  nodePath?: string;
  nodeVersion: string;
  nodeFingerprint?: string;
  packageJsonFingerprint?: string;
  lockfile?: { path: string; fingerprint: string };
  typescriptEntry?: string;
  vitestEntry?: string;
  rejected: boolean;
  warnings: string[];
}

export class ForgeExecutionReadiness {
  constructor(
    private readonly workspaceRoot: string,
    private readonly options: ForgeExecutionReadinessOptions = {},
  ) {}

  async check(targetPaths: readonly string[] = []): Promise<ForgeExecutionReadinessResult> {
    const checkedAt = (this.options.now ?? (() => new Date().toISOString()))();
    const workspace = await inspectWorkspaceIdentity(this.workspaceRoot, this.options);
    const editor = inspectDirtyDocuments(this.workspaceRoot, targetPaths, this.options.dirtyDocuments ?? []);
    const lease = await WorkspaceMutationLease.peek(this.workspaceRoot);
    const runtime = inspectRuntimeProvenance(this.workspaceRoot);
    const transactionRecovery = await TransactionJournal.recoveryState(this.workspaceRoot);
    const blockingFailures: ForgeExecutionIssue[] = [];
    const warnings: ForgeExecutionIssue[] = [];
    if (!workspace.trusted) blockingFailures.push({ code: 'workspace_untrusted', message: 'Workspace must be trusted before Forge can mutate files.' });
    if (workspace.uriScheme !== 'file') blockingFailures.push({ code: 'uri_scheme_rejected', message: 'Forge mutation supports only file: workspaces.' });
    // Repository presence only. Git author identity is deliberately NOT a
    // readiness prerequisite: it is needed solely to create the delivery
    // commit and is checked at delivery time.
    if (!workspace.gitRoot || !workspace.head) blockingFailures.push({ code: GIT_REPOSITORY_UNAVAILABLE, message: gitPrerequisiteMessage(GIT_REPOSITORY_UNAVAILABLE) });
    for (const blocked of editor.dirtyTargetPaths) {
      blockingFailures.push({ code: 'dirty_document_blocked', path: blocked, message: `Save or close ${blocked} before running Forge.` });
    }
    if (lease.state === 'held') blockingFailures.push({ code: 'workspace_lease_held', message: 'Another Forge execution owns the workspace lease.', path: lease.ownerRunId });
    if (runtime.rejected) blockingFailures.push({ code: 'runtime_provenance_rejected', message: 'Validation runtime provenance is not acceptable.' });
    if (transactionRecovery.state === 'recovery_required') blockingFailures.push({ code: 'transaction_recovery_required', message: 'An incomplete Forge transaction journal must be recovered first.' });
    for (const dirty of editor.dirtyUnrelatedPaths) warnings.push({ code: 'warning', path: dirty, message: `Unrelated dirty document: ${dirty}` });
    for (const warning of runtime.warnings) warnings.push({ code: 'warning', message: warning });
    return {
      version: FORGE_EXECUTION_READINESS_VERSION,
      checkedAt,
      extensionBuild: sanitizeBounded(this.options.extensionBuild ?? 'dev'),
      contracts: { proposal: CODING_PROPOSAL_VERSION, mutation: FORGE_MUTATION_CONTRACT_VERSION, validation: FORGE_VALIDATION_CONTRACT_VERSION },
      workspace,
      editor,
      lease,
      runtime,
      pathPolicy: { supported: true, platform: process.platform },
      transactionRecovery,
      processContainment: { available: true, strategy: process.platform === 'win32' ? 'taskkill-tree' : 'process-group' },
      networkPolicy: { kind: 'network_denied' },
      blockingFailures,
      warnings,
    };
  }
}

export interface ForgeExecutionReadinessOptions {
  workspaceFolders?: readonly { uri: { scheme: string; fsPath: string } }[];
  trusted?: boolean;
  dirtyDocuments?: readonly { uri: { scheme: string; fsPath: string }; isDirty: boolean; isUntitled?: boolean }[];
  extensionBuild?: string;
  now?: () => string;
}

export class WorkspaceMutationLease {
  private heartbeat?: NodeJS.Timeout;

  private constructor(private readonly leasePath: string, private readonly runId: string) {}

  static async acquire(workspaceRoot: string, runId: string, extensionBuild: string, ttlMs = 30_000): Promise<WorkspaceMutationLease> {
    const leasePath = leaseFilePath(workspaceRoot);
    await fsp.mkdir(path.dirname(leasePath), { recursive: true });
    const now = Date.now();
    const existing = await readJsonFile<LeaseRecord>(leasePath);
    if (existing && existing.expiresAt > now && existing.runId !== runId) {
      throw new Error('workspace_lease_held');
    }
    const record: LeaseRecord = { runId, pid: process.pid, extensionBuild: sanitizeBounded(extensionBuild), acquiredAt: now, heartbeatAt: now, expiresAt: now + ttlMs };
    await writeJsonNoOverwriteNewer(leasePath, record, existing?.runId);
    const lease = new WorkspaceMutationLease(leasePath, runId);
    lease.heartbeat = setInterval(() => {
      void readJsonFile<LeaseRecord>(leasePath).then(current => {
        if (current?.runId === runId) {
          const heartbeatAt = Date.now();
          return fsp.writeFile(leasePath, JSON.stringify({ ...current, heartbeatAt, expiresAt: heartbeatAt + ttlMs }), { mode: 0o600 });
        }
        return undefined;
      }).catch(() => undefined);
    }, Math.max(1000, Math.floor(ttlMs / 3)));
    return lease;
  }

  static async peek(workspaceRoot: string): Promise<{ state: 'free' | 'held' | 'stale' | 'unknown'; ownerRunId?: string }> {
    const record = await readJsonFile<LeaseRecord>(leaseFilePath(workspaceRoot));
    if (!record) return { state: 'free' };
    return record.expiresAt > Date.now() ? { state: 'held', ownerRunId: sanitizeBounded(record.runId) } : { state: 'stale', ownerRunId: sanitizeBounded(record.runId) };
  }

  async release(): Promise<void> {
    if (this.heartbeat) clearInterval(this.heartbeat);
    const current = await readJsonFile<LeaseRecord>(this.leasePath);
    if (current?.runId === this.runId) {
      await fsp.rm(this.leasePath, { force: true });
    }
  }
}

export interface ApprovalEnvelope {
  version: typeof FORGE_APPROVAL_ENVELOPE_VERSION;
  nonce: string;
  runId: string;
  proposalHash: string;
  workspace: WorkspaceIdentity;
  extensionBuild: string;
  contracts: ForgeExecutionReadinessResult['contracts'];
  permissionProfile: 'normal';
  provider: { type: string; model: string; baseUrl: string };
  operations: Array<{ type: string; path: string; reason: string; contentHash?: string; snapshot: HostBoundCodingFileOperation['snapshot']; sensitive: SensitivePathClassification }>;
  validation: BoundValidationCommand[];
  networkPolicy: NetworkPolicy;
  resourceLimits: { timeoutMs: number; outputBytes: number; mutationBytes: number };
  elevatedConfirmationRequired: boolean;
  expiresAt: string;
  used: boolean;
}

export interface BoundValidationCommand {
  kind: CodingValidationCommand['kind'];
  args: readonly string[];
  script?: string;
  packageJsonFingerprint?: string;
  scriptBodyHash?: string;
  preScriptBodyHash?: string;
  postScriptBodyHash?: string;
}

export class ApprovalEnvelopeService {
  private used = new Set<string>();

  create(proposal: HostBoundCodingProposal, readiness: ForgeExecutionReadinessResult, runId: string): ApprovalEnvelope {
    if (readiness.blockingFailures.length > 0) {
      throw new Error('readiness_blocked');
    }
    const validation = proposal.validationCommands.map(command => bindValidationCommand(command, this.workspacePackage(readiness.workspace.workspaceRoot)));
    const operations = proposal.operations.map(operation => ({
      type: operation.type,
      path: sanitizePathForDisplay(operation.path),
      reason: sanitizeBounded(operation.reason),
      contentHash: operation.content === undefined ? undefined : sha256(Buffer.from(operation.content, 'utf8')),
      snapshot: operation.snapshot,
      sensitive: classifySensitivePath(operation.path),
    }));
    const elevatedConfirmationRequired = operations.some(operation => operation.sensitive.requiresElevation);
    const envelope: ApprovalEnvelope = {
      version: FORGE_APPROVAL_ENVELOPE_VERSION,
      nonce: crypto.randomBytes(16).toString('hex'),
      runId,
      proposalHash: stableHash({ operations, validation }),
      workspace: readiness.workspace,
      extensionBuild: readiness.extensionBuild,
      contracts: readiness.contracts,
      permissionProfile: 'normal',
      provider: { type: Config.getProviderType(), model: Config.getCodingModel(), baseUrl: Config.getApiBase() },
      operations,
      validation,
      networkPolicy: readiness.networkPolicy,
      resourceLimits: { timeoutMs: Config.getCommandTimeoutMs(), outputBytes: 12_000, mutationBytes: proposal.limits.totalBytes },
      elevatedConfirmationRequired,
      expiresAt: new Date(Date.now() + 10 * 60_000).toISOString(),
      used: false,
    };
    return envelope;
  }

  consume(envelope: ApprovalEnvelope, readiness: ForgeExecutionReadinessResult): void {
    if (this.used.has(envelope.nonce) || envelope.used) throw new Error('approval_replay_rejected');
    if (Date.parse(envelope.expiresAt) <= Date.now()) throw new Error('approval_expired');
    if (envelope.workspace.head !== readiness.workspace.head || envelope.workspace.branch !== readiness.workspace.branch) throw new Error('git_state_changed');
    this.used.add(envelope.nonce);
    envelope.used = true;
  }

  private workspacePackage(workspaceRoot: string): Record<string, unknown> {
    return readPackageJson(workspaceRoot);
  }
}

export interface SensitivePathClassification {
  category: string;
  requiresElevation: boolean;
  blocked: boolean;
}

export function classifySensitivePath(relativePath: string): SensitivePathClassification {
  const normalized = normalizeRelativePath(relativePath).toLowerCase();
  if (normalized.startsWith('.git/')) return { category: 'git_metadata', requiresElevation: false, blocked: true };
  if (/^\.env/.test(normalized) || ['.npmrc', '.pypirc'].includes(normalized) || normalized.includes('credentials') || /\.(pem|key)$/.test(normalized)) {
    return { category: 'secret_material', requiresElevation: false, blocked: true };
  }
  if (normalized === 'package.json' || /(^|\/)(package-lock|npm-shrinkwrap|yarn\.lock|pnpm-lock\.yaml|bun\.lockb)$/.test(normalized)) {
    return { category: 'package_manifest', requiresElevation: true, blocked: false };
  }
  if (normalized.startsWith('.github/workflows/') || normalized.startsWith('scripts/') || normalized === 'dockerfile' || normalized.startsWith('.forge/')) {
    return { category: 'execution_policy', requiresElevation: true, blocked: false };
  }
  if (normalized === '.vscode/tasks.json' || normalized === '.vscode/launch.json') {
    return { category: 'editor_execution', requiresElevation: true, blocked: false };
  }
  return { category: 'normal', requiresElevation: false, blocked: false };
}

export function validateHardenedRelativePath(relativePath: string): string | undefined {
  const base = validateRelativeWorkspacePath(relativePath);
  if (base) return base;
  if (/^(\\\\|\/\/)/.test(relativePath) || relativePath.startsWith('\\\\?\\') || relativePath.startsWith('\\\\.\\')) return 'device_or_unc_path_rejected';
  if (relativePath.includes(':')) return 'alternate_data_stream_rejected';
  const segments = normalizeRelativePath(relativePath).split('/');
  const seen = new Set<string>();
  for (const segment of segments) {
    if (!segment || segment.endsWith(' ') || segment.endsWith('.')) return 'ambiguous_windows_path_rejected';
    if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i.test(segment)) return 'reserved_windows_name_rejected';
    const normalized = segment.normalize('NFC').toLowerCase();
    if (seen.has(normalized)) return 'unicode_or_case_collision_rejected';
    seen.add(normalized);
  }
  return undefined;
}

export interface TextEncodingBinding {
  encoding: 'utf8' | 'utf8-bom';
  eol: 'lf' | 'crlf' | 'mixed' | 'none';
  finalNewline: boolean;
  sha256: string;
}

export function bindTextEncoding(buffer: Buffer): TextEncodingBinding {
  if (buffer.length >= 2 && ((buffer[0] === 0xff && buffer[1] === 0xfe) || (buffer[0] === 0xfe && buffer[1] === 0xff))) throw new Error('utf16_rejected');
  if (buffer.includes(0)) throw new Error('binary_content_rejected');
  const encoding = buffer.length >= 3 && buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf ? 'utf8-bom' : 'utf8';
  const text = buffer.toString('utf8');
  if (text.includes('\uFFFD')) throw new Error('unknown_encoding_rejected');
  const hasLf = /(?<!\r)\n/.test(text);
  const hasCrlf = /\r\n/.test(text);
  const eol = hasLf && hasCrlf ? 'mixed' : hasCrlf ? 'crlf' : hasLf ? 'lf' : 'none';
  return { encoding, eol, finalNewline: text.endsWith('\n'), sha256: sha256(buffer) };
}

export function minimalValidationEnvironment(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return createSanitizedChildEnvironment(source, { FORGE_NETWORK_POLICY: 'network_denied' });
}

export class ValidationSideEffectDetector {
  private before = new Map<string, string>();

  constructor(private readonly workspaceRoot: string, private readonly allowedPaths: readonly string[]) {}

  async capture(): Promise<void> {
    this.before = await fingerprintTree(this.workspaceRoot);
  }

  async detect(): Promise<string[]> {
    const after = await fingerprintTree(this.workspaceRoot);
    const changed: string[] = [];
    for (const [file, hash] of after) {
      if (this.before.get(file) !== hash && !this.allowedPaths.includes(file) && !isAllowedGeneratedPath(file)) changed.push(file);
    }
    for (const file of this.before.keys()) {
      if (!after.has(file) && !this.allowedPaths.includes(file) && !isAllowedGeneratedPath(file)) changed.push(file);
    }
    return changed.sort();
  }
}

export function bindToolIdentity(tool: { id: string; version: string; descriptor: unknown; inputSchema: unknown; outputSchema: unknown; mutatesWorkspace?: boolean }): Record<string, string | boolean> {
  return {
    id: tool.id,
    version: tool.version,
    descriptorHash: stableHash(tool.descriptor),
    inputSchemaHash: stableHash(tool.inputSchema),
    outputSchemaHash: stableHash(tool.outputSchema),
    mutatesWorkspace: tool.mutatesWorkspace === true,
  };
}

export function bindProviderIdentity(providerType: string, baseUrl: string, model: string): { ok: boolean; providerType: string; baseUrl: string; model: string; reason?: string } {
  let parsed: URL;
  try {
    parsed = new URL(baseUrl);
  } catch {
    return { ok: false, providerType, baseUrl: sanitizeBounded(baseUrl), model: sanitizeBounded(model), reason: 'provider_endpoint_invalid' };
  }
  const localhost = parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1' || parsed.hostname === '::1';
  if (providerType === 'ollama' && !localhost) {
    return { ok: false, providerType, baseUrl: parsed.origin, model: sanitizeBounded(model), reason: 'provider_identity_mismatch' };
  }
  return { ok: true, providerType, baseUrl: parsed.origin, model: sanitizeBounded(model) };
}

function pathsEqualForTrust(a: string, b: string): boolean {
  const normalize = (value: string): string => path.resolve(value).replace(/[\\/]+$/, '');
  const left = normalize(a);
  const right = normalize(b);
  return process.platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right;
}

async function inspectWorkspaceIdentity(workspaceRoot: string, options: ForgeExecutionReadiness['options']): Promise<WorkspaceIdentity> {
  const folders = options.workspaceFolders;
  const uriScheme = folders?.[0]?.uri.scheme ?? 'file';
  const trusted = options.trusted ?? true;
  const root = await fsp.realpath(workspaceRoot).catch(() => path.resolve(workspaceRoot));
  const gitRoot = await git(root, ['rev-parse', '--show-toplevel']);
  const gitCommonDir = await git(root, ['rev-parse', '--git-common-dir']);
  const head = await git(root, ['rev-parse', 'HEAD']);
  const branch = await git(root, ['branch', '--show-current']);
  // M44.1: a multi-root VS Code workspace is no longer treated as inherently
  // untrusted. Execution still targets exactly one root per mission; trust is
  // evaluated against *that* root being a genuine, recognized workspace
  // folder, not against how many other folders happen to be open alongside it.
  const targetIsRecognizedFolder = !folders || folders.length === 0
    || folders.some(folder => pathsEqualForTrust(folder.uri.fsPath, root));
  return {
    workspaceRoot: root,
    uriScheme,
    trusted: trusted && targetIsRecognizedFolder,
    gitRoot: gitRoot ? path.resolve(root, gitRoot) : undefined,
    gitCommonDir: gitCommonDir ? path.resolve(root, gitCommonDir) : undefined,
    worktreeIdentity: gitCommonDir ? stableHash(path.resolve(root, gitCommonDir)) : undefined,
    branch: branch || undefined,
    // An unborn HEAD (fresh `git init`, no first commit yet) is a supported
    // governed greenfield base, never a missing identity: it is represented by
    // the deterministic all-zeros marker so the readiness gate and approval
    // envelopes bind to a stable value instead of silently treating a real git
    // repository as "no HEAD". A non-Git folder still reports no head at all
    // and is rejected by the readiness gate's gitRoot requirement.
    head: head ?? (gitRoot ? UNBORN_HEAD_COMMIT : undefined),
    detachedHead: !branch && Boolean(head),
  };
}

function inspectDirtyDocuments(workspaceRoot: string, targetPaths: readonly string[], documents: readonly { uri: { scheme: string; fsPath: string }; isDirty: boolean; isUntitled?: boolean }[]): ForgeExecutionReadinessResult['editor'] {
  const targets = new Set(targetPaths.map(p => normalizeRelativePath(p).toLowerCase()));
  const dirtyTargetPaths: string[] = [];
  const dirtyUnrelatedPaths: string[] = [];
  for (const document of documents) {
    if (!document.isDirty && !document.isUntitled) continue;
    const relative = normalizeRelativePath(path.relative(workspaceRoot, document.uri.fsPath));
    if (relative.startsWith('..')) continue;
    if (targets.has(relative.toLowerCase())) dirtyTargetPaths.push(relative);
    else dirtyUnrelatedPaths.push(relative);
  }
  return { dirtyTargetPaths: dirtyTargetPaths.sort(), dirtyUnrelatedPaths: dirtyUnrelatedPaths.sort() };
}

/**
 * The extension host's own `process.execPath` is VS Code's Electron binary
 * (Code.exe) on every desktop install — it is never a plain Node runtime, so
 * checking it directly would reject validation provenance unconditionally.
 * Validation commands are actually spawned against a real Node resolved from
 * PATH (see ValidationRunner's node resolution), so provenance is checked
 * against that same resolved executable instead.
 */
function resolveSystemNodePath(): string | undefined {
  const envPath = process.env.PATH ?? '';
  const candidates = envPath.split(path.delimiter).filter(Boolean);
  for (const entry of candidates) {
    const nodePath = path.join(entry, process.platform === 'win32' ? 'node.exe' : 'node');
    const base = path.basename(nodePath).toLowerCase();
    if ((base === 'node.exe' || base === 'node') && fs.existsSync(nodePath) && !nodePath.toLowerCase().includes(`${path.sep}vscode${path.sep}`)) {
      return nodePath;
    }
  }
  return undefined;
}

function inspectRuntimeProvenance(workspaceRoot: string): RuntimeProvenance {
  const nodePath = resolveSystemNodePath() ?? process.execPath;
  const warnings: string[] = [];
  const lower = nodePath.toLowerCase();
  const rejected = /code(\.exe)?$/.test(path.basename(lower)) || lower.includes(`${path.sep}microsoft vs code${path.sep}`);
  const packageJson = path.join(workspaceRoot, 'package.json');
  const lockfiles = ['package-lock.json', 'npm-shrinkwrap.json', 'pnpm-lock.yaml', 'yarn.lock', 'bun.lockb'];
  const lockfile = lockfiles.map(file => path.join(workspaceRoot, file)).find(fs.existsSync);
  const runtime: RuntimeProvenance = {
    nodePath,
    nodeVersion: process.version,
    nodeFingerprint: fingerprintFileSync(nodePath),
    packageJsonFingerprint: fingerprintFileSync(packageJson),
    lockfile: lockfile ? { path: path.basename(lockfile), fingerprint: fingerprintFileSync(lockfile) ?? '' } : undefined,
    typescriptEntry: existing(path.join(workspaceRoot, 'node_modules', 'typescript', 'bin', 'tsc')),
    vitestEntry: existing(path.join(workspaceRoot, 'node_modules', 'vitest', 'vitest.mjs')),
    rejected,
    warnings,
  };
  if (!runtime.typescriptEntry) warnings.push('Workspace-local TypeScript was not found.');
  if (!runtime.vitestEntry) warnings.push('Workspace-local Vitest was not found.');
  return runtime;
}

function bindValidationCommand(command: CodingValidationCommand, pkg: Record<string, unknown>): BoundValidationCommand {
  const scripts = typeof pkg.scripts === 'object' && pkg.scripts !== null ? pkg.scripts as Record<string, unknown> : {};
  const script = command.kind === 'npm-script' ? command.script : command.kind === 'npm-test' ? 'test' : undefined;
  const body = script && typeof scripts[script] === 'string' ? scripts[script] : undefined;
  const pre = script && typeof scripts[`pre${script}`] === 'string' ? scripts[`pre${script}`] : undefined;
  const post = script && typeof scripts[`post${script}`] === 'string' ? scripts[`post${script}`] : undefined;
  return {
    kind: command.kind,
    args: command.args ?? [],
    script,
    packageJsonFingerprint: stableHash(pkg),
    scriptBodyHash: body ? stableHash(body) : undefined,
    preScriptBodyHash: pre ? stableHash(pre) : undefined,
    postScriptBodyHash: post ? stableHash(post) : undefined,
  };
}

function readPackageJson(workspaceRoot: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(workspaceRoot, 'package.json'), 'utf8')) as unknown;
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

function git(cwd: string, args: string[]): Promise<string | undefined> {
  return new Promise(resolve => {
    const child = spawn('git', ['-c', 'core.hooksPath=', '-c', 'filter.lfs.process=', ...args], {
      cwd,
      shell: false,
      windowsHide: true,
      env: minimalValidationEnvironment(),
    });
    let output = '';
    child.stdout.on('data', data => { output = (output + String(data)).slice(-4000); });
    child.on('error', () => resolve(undefined));
    child.on('close', code => resolve(code === 0 ? output.trim() : undefined));
  });
}

function leaseFilePath(workspaceRoot: string): string {
  return path.join(os.tmpdir(), 'ollama-agent-forge', stableHash(path.resolve(workspaceRoot)).slice(7, 23), 'mutation-lease.json');
}

interface LeaseRecord { runId: string; pid: number; extensionBuild: string; acquiredAt: number; heartbeatAt: number; expiresAt: number }

async function readJsonFile<T>(filePath: string): Promise<T | undefined> {
  try {
    return JSON.parse(await fsp.readFile(filePath, 'utf8')) as T;
  } catch {
    return undefined;
  }
}

async function writeJsonNoOverwriteNewer(filePath: string, record: LeaseRecord, replaceRunId?: string): Promise<void> {
  const current = await readJsonFile<LeaseRecord>(filePath);
  if (current && current.expiresAt > Date.now() && current.runId !== replaceRunId && current.runId !== record.runId) {
    throw new Error('workspace_lease_held');
  }
  await fsp.writeFile(filePath, JSON.stringify(record), { mode: 0o600 });
}

function stableHash(value: unknown): string {
  return `sha256:${crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex')}`;
}

function fingerprintFileSync(filePath: string): string | undefined {
  try {
    return sha256(fs.readFileSync(filePath));
  } catch {
    return undefined;
  }
}

async function fingerprintTree(root: string): Promise<Map<string, string>> {
  const result = new Map<string, string>();
  async function walk(dir: string): Promise<void> {
    const entries = await fsp.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (['.git', 'node_modules', 'out'].includes(entry.name)) continue;
      const absolute = path.join(dir, entry.name);
      const relative = normalizeRelativePath(path.relative(root, absolute));
      if (entry.isDirectory()) await walk(absolute);
      else if (entry.isFile()) result.set(relative, sha256(await fsp.readFile(absolute)));
    }
  }
  await walk(root);
  return result;
}

function isAllowedGeneratedPath(relativePath: string): boolean {
  return isGeneratedArtifactPath(relativePath);
}

function existing(filePath: string): string | undefined {
  return fs.existsSync(filePath) ? filePath : undefined;
}

function sanitizeBounded(value: string): string {
  return value.replace(/\x1b\[[0-9;]*m/g, '').replace(/[\u0000-\u001f\u007f]/g, '?').slice(0, 500);
}

function sanitizePathForDisplay(value: string): string {
  return sanitizeBounded(value.normalize('NFC'));
}
