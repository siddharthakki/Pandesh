/**
 * Core-owned fail-closed policy for governed workspace actions.
 *
 * Host classifiers and client `approved` resolutions are advisory. This module
 * is the authority: compound commands are split and evaluated as individual
 * operations, and package install, network, browser install, credential access,
 * git push, parent-directory traversal, and outside-repository writes are denied
 * unless the frozen task envelope explicitly authorizes them. Invented absolute
 * reads are deferred to repository path recovery instead of being denied here.
 */
import * as path from 'node:path';
import { isHostOwnedSearchPath } from './missionHostPaths';
import { resolveBrowserTargetUrl } from './browserHostPolicy';

export const CORE_POLICY_ACTOR = 'core:policy';

export interface CommandPolicyEnvelope {
  workspaceRoot: string;
  pushAuthorized: boolean;
  networkAuthorized: boolean;
  installAuthorized: boolean;
  browserInstallAuthorized?: boolean;
}

export type PolicyDecision = 'allow' | 'deny';

export interface GovernedActionPolicyResult {
  decision: PolicyDecision;
  reason: string;
  requestedCommand?: string;
  requestedPath?: string;
  normalizedArguments: Record<string, unknown>;
}

const PACKAGE_MANAGERS = new Set(['npm', 'npx', 'pnpm', 'yarn', 'pip', 'pip3']);
const INSTALL_SUBCOMMANDS = new Set(['install', 'i', 'ci', 'add', 'init', 'publish']);
const GIT_NETWORK_SUBCOMMANDS = new Set(['push', 'remote', 'fetch', 'pull', 'clone']);
const SHELL_INTERPRETERS = new Set(['powershell', 'pwsh']);
const NETWORK_PROGRAMS = new Set(['curl', 'wget', 'bitsadmin', 'msiexec', 'certutil']);
const BROWSER_INSTALL_RE = /\b(puppeteer(?:-core)?|playwright|chromium|chromedriver|edgedriver|google-chrome|msedge)\b/i;
const CREDENTIAL_RE = /\b(credentials\.env|\.netrc|id_rsa|cmdkey|aws\s+configure|get-credential)\b/i;

export function defaultCommandPolicyEnvelope(workspaceRoot: string): CommandPolicyEnvelope {
  return {
    workspaceRoot,
    pushAuthorized: false,
    networkAuthorized: false,
    installAuthorized: false,
    browserInstallAuthorized: false,
  };
}

export function isInsideWorkspace(workspaceRoot: string, target: string): boolean {
  const root = path.resolve(workspaceRoot);
  const resolved = path.resolve(target);
  const relative = path.relative(root, resolved);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

export function hasParentDirectorySegment(value: string): boolean {
  return /(^|[\\/])\.\.([\\/]|$)/.test(value);
}

export function isAbsolutePathToken(token: string): boolean {
  const trimmed = token.trim().replace(/^['"]|['"]$/g, '');
  if (!trimmed) return false;
  if (/^[a-zA-Z]:[\\/]/.test(trimmed)) return true;
  if (trimmed.startsWith('\\\\')) return true;
  if (process.platform !== 'win32' && trimmed.startsWith('/')) return true;
  return false;
}

/** Splits `&&`, `||`, `|`, `&`, `;`, and newlines without breaking quoted strings. */
export function splitCompoundCommand(command: string): string[] {
  const parts: string[] = [];
  let current = '';
  let quote: string | null = null;
  for (let i = 0; i < command.length; i++) {
    const ch = command[i];
    if (quote) {
      current += ch;
      if (ch === quote && command[i - 1] !== '\\') quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      current += ch;
      continue;
    }
    const rest = command.slice(i);
    if (rest.startsWith('&&') || rest.startsWith('||')) {
      if (current.trim()) parts.push(current.trim());
      current = '';
      i += 1;
      continue;
    }
    if (ch === '|' || ch === '&' || ch === ';' || ch === '\n') {
      if (current.trim()) parts.push(current.trim());
      current = '';
      continue;
    }
    current += ch;
  }
  if (current.trim()) parts.push(current.trim());
  return parts;
}

export function coerceCommandArgument(raw: unknown): string {
  if (Array.isArray(raw)) return raw.map((part) => String(part)).join(' ');
  return raw === undefined || raw === null ? '' : String(raw);
}

function stripWrappingQuotes(value: string): string {
  const trimmed = value.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"') && trimmed.length >= 2)
    || (trimmed.startsWith("'") && trimmed.endsWith("'") && trimmed.length >= 2)
  ) {
    return trimmed.slice(1, -1).trim();
  }
  return trimmed;
}

function unwrapShellWrapper(command: string): string {
  let current = command.trim();
  for (let i = 0; i < 3; i++) {
    const match = current.match(/^(?:cmd(?:\.exe)?)\s+(?:\/d\s+)?(?:\/s\s+)?\/c\s+(.+)$/i);
    if (!match) break;
    current = stripWrappingQuotes(match[1]);
  }
  return current;
}

function tokenize(command: string): string[] {
  const tokens: string[] = [];
  let current = '';
  let quote: string | null = null;
  for (let i = 0; i < command.length; i++) {
    const ch = command[i];
    if (quote) {
      if (ch === quote && command[i - 1] !== '\\') quote = null;
      else current += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (/\s/.test(ch)) {
      if (current) {
        tokens.push(current);
        current = '';
      }
      continue;
    }
    current += ch;
  }
  if (current) tokens.push(current);
  return tokens;
}

function programBaseName(token: string | undefined): string {
  if (!token) return '';
  const normalized = token.replace(/\\/g, '/').split('/').pop() ?? token;
  return normalized.replace(/\.(exe|cmd|bat)$/i, '').toLowerCase();
}

function deny(
  reason: string,
  extra: Partial<GovernedActionPolicyResult> = {},
): GovernedActionPolicyResult {
  return {
    decision: 'deny',
    reason,
    normalizedArguments: extra.normalizedArguments ?? {},
    requestedCommand: extra.requestedCommand,
    requestedPath: extra.requestedPath,
  };
}

function allow(extra: Partial<GovernedActionPolicyResult> = {}): GovernedActionPolicyResult {
  return {
    decision: 'allow',
    reason: extra.reason ?? 'action is not intrinsically forbidden by Core policy',
    normalizedArguments: extra.normalizedArguments ?? {},
    requestedCommand: extra.requestedCommand,
    requestedPath: extra.requestedPath,
  };
}

function isInstallCommand(program: string, tokens: string[]): boolean {
  if (PACKAGE_MANAGERS.has(program)) {
    const sub = (tokens[1] ?? '').toLowerCase();
    if (INSTALL_SUBCOMMANDS.has(sub)) return true;
  }
  if (program === 'python' || program === 'python3' || program === 'py') {
    return tokens.some((token, index) => (
      token.toLowerCase() === 'pip' && (tokens[index + 1] ?? '').toLowerCase() === 'install'
    ));
  }
  return false;
}

function isBrowserInstallCommand(command: string, program: string, tokens: string[]): boolean {
  if (!BROWSER_INSTALL_RE.test(command)) return false;
  if (isInstallCommand(program, tokens)) return true;
  if (program === 'npx' && /\binstall\b/i.test(command)) return true;
  return false;
}

function commandTargetsOutsideWorkspace(command: string, workspaceRoot: string): boolean {
  if (hasParentDirectorySegment(command)) return true;
  for (const token of tokenize(command)) {
    if (!isAbsolutePathToken(token)) continue;
    if (!isInsideWorkspace(workspaceRoot, token)) return true;
  }
  return false;
}

function evaluateCommandSegment(
  segment: string,
  envelope: CommandPolicyEnvelope,
): GovernedActionPolicyResult {
  const trimmed = segment.trim();
  if (!trimmed) return allow({ reason: 'empty segment' });
  const tokens = tokenize(trimmed);
  const program = programBaseName(tokens[0]);

  if (SHELL_INTERPRETERS.has(program) || /\bpowershell(?:\.exe)?\b/i.test(trimmed)) {
    return deny('powershell is not authorized by the task envelope', { requestedCommand: trimmed });
  }
  if (NETWORK_PROGRAMS.has(program) || /\binvoke-webrequest\b|\binvoke-restmethod\b|\bstart\s+https?:/i.test(trimmed)) {
    if (!envelope.networkAuthorized) {
      return deny('network command is not authorized by the task envelope', { requestedCommand: trimmed });
    }
  }
  if (program === 'git') {
    const sub = (tokens[1] ?? '').toLowerCase();
    if (sub === 'push' || tokens.some((token) => token.toLowerCase() === 'push')) {
      if (!envelope.pushAuthorized) {
        return deny('git push is not authorized by the task envelope', { requestedCommand: trimmed });
      }
    } else if (GIT_NETWORK_SUBCOMMANDS.has(sub) && !envelope.networkAuthorized) {
      return deny('network git command is not authorized by the task envelope', { requestedCommand: trimmed });
    }
  }
  if (isInstallCommand(program, tokens) && !envelope.installAuthorized) {
    if (isBrowserInstallCommand(trimmed, program, tokens) && !envelope.browserInstallAuthorized) {
      return deny('browser installation is not authorized by the task envelope', { requestedCommand: trimmed });
    }
    return deny('package installation is not authorized by the task envelope', { requestedCommand: trimmed });
  }
  if (isBrowserInstallCommand(trimmed, program, tokens) && !envelope.browserInstallAuthorized && !envelope.installAuthorized) {
    return deny('browser installation is not authorized by the task envelope', { requestedCommand: trimmed });
  }
  if (CREDENTIAL_RE.test(trimmed)) {
    return deny('credential access is not authorized by the task envelope', { requestedCommand: trimmed });
  }
  if (commandTargetsOutsideWorkspace(trimmed, envelope.workspaceRoot)) {
    return deny('command targets a path outside the selected repository', { requestedCommand: trimmed });
  }
  return allow({ requestedCommand: trimmed, normalizedArguments: { command: trimmed } });
}

export function evaluateRunCommand(
  command: string,
  envelope: CommandPolicyEnvelope,
): GovernedActionPolicyResult {
  const trimmed = command.trim();
  const normalizedArguments = { command: trimmed.replace(/\s+/g, ' ') };
  if (!trimmed) {
    return deny('empty command', { requestedCommand: '', normalizedArguments });
  }
  const segments = splitCompoundCommand(trimmed);
  if (segments.length === 0) {
    return deny('empty command', { requestedCommand: trimmed, normalizedArguments });
  }
  for (const segment of segments) {
    const unwrapped = unwrapShellWrapper(segment);
    if (unwrapped !== segment.trim()) {
      const nested = evaluateRunCommand(unwrapped, envelope);
      if (nested.decision === 'deny') {
        return deny(nested.reason, { requestedCommand: trimmed, normalizedArguments });
      }
      continue;
    }
    const result = evaluateCommandSegment(unwrapped, envelope);
    if (result.decision === 'deny') {
      return deny(result.reason, { requestedCommand: trimmed, normalizedArguments });
    }
  }
  return allow({ requestedCommand: trimmed, normalizedArguments });
}

function evaluateRequestedPath(
  requestedPath: string,
  envelope: CommandPolicyEnvelope,
  options?: { allowOutsideAbsoluteRecovery?: boolean },
): GovernedActionPolicyResult {
  const trimmed = requestedPath.trim();
  const normalizedArguments = { path: trimmed };
  if (!trimmed) return deny('empty path', { requestedPath: '', normalizedArguments });
  if (isHostOwnedSearchPath(trimmed)) {
    return deny('host-owned path is not available for model investigation', { requestedPath: trimmed, normalizedArguments });
  }
  if (hasParentDirectorySegment(trimmed)) {
    return deny('parent-directory path is not authorized', { requestedPath: trimmed, normalizedArguments });
  }
  if (isAbsolutePathToken(trimmed)) {
    if (options?.allowOutsideAbsoluteRecovery) {
      return allow({
        requestedPath: trimmed,
        normalizedArguments,
        reason: 'absolute path deferred to repository recovery',
      });
    }
    return deny('absolute path is not authorized; use a repository-relative path', {
      requestedPath: trimmed,
      normalizedArguments,
    });
  }
  const resolved = path.resolve(envelope.workspaceRoot, trimmed);
  if (!isInsideWorkspace(envelope.workspaceRoot, resolved)) {
    return deny('path is outside the selected repository', { requestedPath: trimmed, normalizedArguments });
  }
  return allow({ requestedPath: trimmed, normalizedArguments });
}

const WORKSPACE_TOOLS = new Set(['run_command', 'read_file', 'propose_file_change', 'propose_text_edit', 'inspect_page']);

/**
 * A live browser target: an http(s) page on a host the browser is allowed to
 * open. The host rule is the same one the browser capability enforces, so the
 * policy can never approve a page the browser would refuse (and vice versa).
 */
function evaluateRequestedUrl(rawUrl: string): GovernedActionPolicyResult {
  const trimmed = String(rawUrl ?? '').trim();
  const normalizedArguments = { url: trimmed };
  const resolved = resolveBrowserTargetUrl(trimmed);
  if (!resolved.ok) {
    return deny(resolved.reason, { normalizedArguments });
  }
  return allow({ reason: `live page on the authorized host '${resolved.host}'`, normalizedArguments });
}

export function evaluateGovernedAction(input: {
  toolName: string;
  arguments: Record<string, unknown>;
  envelope: CommandPolicyEnvelope;
}): GovernedActionPolicyResult {
  if (!WORKSPACE_TOOLS.has(input.toolName)) {
    return allow({
      reason: 'non-workspace capability is not subject to workspace command policy',
      normalizedArguments: input.arguments,
    });
  }
  if (input.toolName === 'run_command') {
    return evaluateRunCommand(coerceCommandArgument(input.arguments.command), input.envelope);
  }
  // `inspect_page` addresses a workspace file OR a live page on this machine.
  // A URL is governed by the browser host rule, not by the repository path
  // rule (a URL is not a path, and an empty path is not a denial reason).
  if (input.toolName === 'inspect_page' && String(input.arguments.url ?? '').trim()) {
    const urlResult = evaluateRequestedUrl(String(input.arguments.url ?? ''));
    if (urlResult.decision === 'deny') return urlResult;
    return {
      ...urlResult,
      normalizedArguments: { ...urlResult.normalizedArguments, ...(input.arguments.steps ? { stepCount: Array.isArray(input.arguments.steps) ? input.arguments.steps.length : 0 } : {}) },
    };
  }
  const requestedPath = String(input.arguments.path ?? '');
  const pathResult = evaluateRequestedPath(requestedPath, input.envelope, {
    allowOutsideAbsoluteRecovery: input.toolName === 'read_file',
  });
  return {
    ...pathResult,
    normalizedArguments: {
      ...pathResult.normalizedArguments,
      ...(typeof input.arguments.content === 'string'
        ? { content: `<${Buffer.byteLength(input.arguments.content, 'utf8')} bytes>` }
        : {}),
    },
  };
}

export function envelopeFromApprovalSummary(
  summary: Record<string, unknown>,
  fallbackWorkspaceRoot: string,
): CommandPolicyEnvelope {
  return {
    workspaceRoot: typeof summary.workspaceRoot === 'string' && summary.workspaceRoot.trim()
      ? summary.workspaceRoot
      : fallbackWorkspaceRoot,
    pushAuthorized: summary.pushAuthorized === true,
    networkAuthorized: summary.networkAuthorized === true,
    installAuthorized: summary.installAuthorized === true,
    browserInstallAuthorized: summary.browserInstallAuthorized === true,
  };
}
