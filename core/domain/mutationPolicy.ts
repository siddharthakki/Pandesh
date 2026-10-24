import { createHash } from 'node:crypto';
import { hasAffirmativeMutationIntent, isInspectionOrAdvisoryOnly } from './actionIntent';

/**
 * Runtime-level mutation policy, derived once from the ACCEPTED objective text
 * (the frozen `attempt_contexts.taskInput`) — never from prior conversation
 * state, composer mode, or a keyword match on the whole sentence.
 *
 * `denied` is established by explicit read-only wording ("Do not modify any
 * files", "read-only", "inspection only", ...) with no separate positive
 * mutation directive. Under `denied`:
 *   - no system nudge may claim a modification is required;
 *   - mutating tools are not exposed and, if a model names one anyway, the
 *     call is deterministically rejected with no approval created;
 *   - only non-mutating shell commands may run.
 *
 * A narrow constraint ("do not modify tests", "do not modify unrelated files")
 * is NOT an explicit read-only request and leaves the policy `allowed`.
 */
export type MutationPolicy = 'allowed' | 'denied';

const READ_ONLY_OBJECT = String.raw`(?:any |the |all )?(?:files?|anything|(?:the )?(?:workspace|repo(?:sitory)?|codebase|project)(?: files?)?)(?=\s*(?:[.,;:!?)]|$|\band\b|\bor\b))`;
const MUTATION_VERBS = String.raw`(?:modify|write|edit|change|create|delete|remove|rename|alter|touch|overwrite|update|patch)`;

const EXPLICIT_READ_ONLY_PATTERNS: RegExp[] = [
  /\bread[- ]only\b/i,
  /\binspection[- ]only\b/i,
  /\breport[- ]only\b/i,
  new RegExp(String.raw`\b(?:do not|don't|never|must not|mustn't)\s+(?:modify|write|edit|change|create|delete|remove|rename|alter|touch|overwrite|update|patch|make changes to)\s+${READ_ONLY_OBJECT}`, 'i'),
  new RegExp(String.raw`\bwithout\s+(?:modifying|changing|editing|writing to|touching|altering)\s+${READ_ONLY_OBJECT}`, 'i'),
  /\bwithout (?:making|applying) (?:any )?(?:changes|modifications|edits)\b/i,
  /\bno (?:workspace |file )?(?:changes|modifications|edits)\b/i,
  // "Suggest a patch but do not apply it": the change may be described, never applied.
  /\b(?:do not|don't|never|must not|mustn't)\s+apply\s+(?:it|them|this|that|any(?:thing)?|the\s+(?:patch|change|changes|fix|diff|edit|edits))\b/i,
];

const NEGATED_MUTATION_CLAUSE = new RegExp(
  String.raw`\b(?:do not|don't|never|must not|mustn't|without)\b[^.\n!?]{0,80}\b${MUTATION_VERBS}\b`,
  'gi',
);
const DIRECTIVE_VERBS = String.raw`(?:${MUTATION_VERBS}|add|implement|fix|move|refactor|install|commit|push|apply|replace|build)`;
// A verb coordinated with another verb ("the difference between create and update") names an operation, not an order.
const POSITIVE_MUTATION_DIRECTIVE = new RegExp(
  String.raw`(?:^|[\n.!?]\s*|(?<!\b${DIRECTIVE_VERBS}\s+)\b(?:and|then|also)\s+)(?:please\s+)?${DIRECTIVE_VERBS}\b`,
  'im',
);

export function deriveMutationPolicy(objectiveText: string | null | undefined): MutationPolicy {
  const text = String(objectiveText ?? '');
  // Discussion about a possible change (or an explicit request to inspect/diagnose) with no affirmative action
  // clause is read-only, whether or not the user also said "do not modify anything".
  if (isInspectionOrAdvisoryOnly(text)) return 'denied';
  if (!EXPLICIT_READ_ONLY_PATTERNS.some((pattern) => pattern.test(text))) return 'allowed';
  const withoutNegated = text.replace(NEGATED_MUTATION_CLAUSE, ' ');
  return POSITIVE_MUTATION_DIRECTIVE.test(withoutNegated) || hasAffirmativeMutationIntent(withoutNegated) ? 'allowed' : 'denied';
}

/** Stable short identity of the objective a policy was derived from — logged
 * with every policy decision so a proposal can be proven to belong to (or not
 * belong to) a specific objective without inference. */
export function objectiveHash(objectiveText: string): string {
  return createHash('sha256').update(objectiveText).digest('hex').slice(0, 16);
}

/** Tools that write, delete, rename, apply, commit or patch. Deliberately an
 * explicit deny set plus a verb heuristic so a future tool with such a name
 * fails closed under `denied`. */
const MUTATING_TOOL_NAMES = new Set([
  'propose_file_change', 'propose_text_edit', 'write_file', 'delete_file', 'rename_file',
  'apply_patch', 'apply_change', 'commit', 'git_commit', 'patch_file',
]);
const MUTATING_TOOL_VERB = /(?:^|_)(?:propose|write|delete|remove|rename|apply|commit|patch|edit|create|push|send|move)(?:_|$)/i;

export function isMutatingToolName(name: string): boolean {
  return MUTATING_TOOL_NAMES.has(name) || MUTATING_TOOL_VERB.test(name);
}

const READ_ONLY_PROGRAMS = new Set([
  'dir', 'ls', 'cat', 'type', 'head', 'tail', 'more', 'less', 'grep', 'rg', 'findstr', 'wc', 'pwd', 'cd', 'echo',
  'where', 'which', 'tree', 'stat', 'file', 'sort', 'uniq', 'cut', 'get-childitem', 'gci', 'get-content', 'gc',
  'select-string', 'sls', 'get-item', 'gi', 'get-location', 'test-path', 'measure-object', 'get-filehash',
]);
const GIT_READ_SUBCOMMANDS = new Set(['status', 'log', 'diff', 'show', 'ls-files', 'rev-parse', 'blame', 'shortlog', 'describe', 'grep', 'cat-file', 'ls-tree']);
const VERSION_ONLY = /^(?:node|npm|python3?|py|git|pnpm|yarn|tsc|java|go|rustc|cargo|dotnet)\s+(?:-v|--version|version)$/i;
const REDIRECTION = /(?:^|[^-\w])(?:\d?>>?|>\|)|\|\s*(?:tee|out-file|set-content|add-content)\b|\b(?:out-file|set-content|add-content|remove-item|new-item|copy-item|move-item|rename-item|clear-content)\b/i;
const FIND_MUTATING_FLAGS = /\s-(?:delete|exec|execdir|ok|fprint|fls)\b/i;

/**
 * Output redirection anywhere outside quotes. `echo x> a.txt` and `type a>b` write files exactly like `echo x > a.txt`:
 * a redirect needs no whitespace before it. Stream duplication (`2>&1`) and discards (`>nul`, `>/dev/null`) write
 * nothing; `->` and `=>` in unquoted arguments are not redirects.
 */
function hasOutputRedirection(command: string): boolean {
  const unquoted = command
    .replace(/"[^"]*"|'[^']*'/g, '""')
    .replace(/\d?>&\d/g, ' ')
    .replace(/\d?>>?\s*(?:nul|\/dev\/null)(?=$|[\s;&|)])/gi, ' ');
  return /(?<![-=])>/.test(unquoted) || REDIRECTION.test(unquoted);
}

/** Conservative allowlist: a command is non-mutating only when EVERY
 * `&&`/`;`/`|`-separated segment is a known read-only program (or a read-only
 * git subcommand / version probe) and nothing redirects output to a file. */
export function isNonMutatingShellCommand(command: string): boolean {
  const text = String(command ?? '').trim();
  if (!text || hasOutputRedirection(text) || /[`]|\$\(/.test(text)) return false;
  const segments = text.split(/&&|\|\||[;|\n]/).map((segment) => segment.trim()).filter(Boolean);
  if (segments.length === 0) return false;
  return segments.every((segment) => {
    if (VERSION_ONLY.test(segment)) return true;
    const tokens = segment.split(/\s+/);
    const program = (tokens[0] ?? '').replace(/^["']|["']$/g, '').replace(/\.(?:exe|cmd|bat)$/i, '').toLowerCase();
    if (program === 'git') {
      const sub = tokens.slice(1).find((token) => !token.startsWith('-'));
      if (sub === 'branch') return !tokens.slice(2).some((token) => /^-(?:d|D|m|M|c|C)$|^--(?:delete|move|copy)$/.test(token));
      return sub !== undefined && GIT_READ_SUBCOMMANDS.has(sub);
    }
    if (program === 'find') return !FIND_MUTATING_FLAGS.test(` ${segment}`);
    if (program === 'sort') return !/\s-o\b/i.test(segment);
    return READ_ONLY_PROGRAMS.has(program);
  });
}

const FILE_CHANGING_COMMAND = new RegExp(
  '(?:^|[;&|(\\n])\\s*(?:cmd(?:\\.exe)?\\s+/c\\s+)?(?:copy|xcopy|robocopy|move|ren|rename|del|erase|mkdir|md|rmdir|rd|cp|mv|rm|touch|tee|ln|mklink|attrib|icacls)\\b'
  + '|\\bgit\\s+(?:add|commit|mv|rm|apply|am|restore|checkout|switch|reset|merge|rebase|cherry-pick|stash|clean|pull|clone|init)\\b'
  + '|\\b(?:npm|pnpm|yarn|pip3?|cargo|dotnet)\\s+(?:install|i|add|ci|update|upgrade|uninstall|remove|restore)\\b'
  + '|\\bsed\\s+(?:-\\w*i|--in-place)\\b'
  + '|\\b(?:writeFile(?:Sync)?|appendFile(?:Sync)?|copyFile(?:Sync)?|cpSync|renameSync|mkdirSync|unlinkSync|rmSync|createWriteStream)\\b',
  'i',
);

const VALIDATION_ONLY_COMMAND = /^(?:node\s+(?:--check|-c|-e|-p|--eval|--print)\b|(?:npm|pnpm|yarn)\s+(?:test|run\s+(?:test|lint|build|check|typecheck)\b)|(?:npx\s+)?(?:tsc|eslint|vitest|jest|pytest|mocha|prettier\s+--check)\b|python3?\s+-m\s+(?:pytest|py_compile|unittest)\b|dotnet\s+(?:test|build)\b|cargo\s+(?:test|check|build)\b|go\s+(?:test|vet|build)\b)/i;

/**
 * Whether an executed shell command demonstrably changes files. Stricter than `!isNonMutatingShellCommand`, which only
 * means "not known to be read-only": `node --check x.js` or `npm test` are not on the read-only allowlist but prove
 * nothing was created or changed, so they must not satisfy a "make a copy" objective.
 */
export function isFileChangingShellCommand(command: string): boolean {
  const text = String(command ?? '').trim();
  if (!text) return false;
  if (hasOutputRedirection(text) || FILE_CHANGING_COMMAND.test(text)) return true;
  if (isNonMutatingShellCommand(text)) return false;
  // Unknown programs are assumed to change files (fail open for legitimate work), except known check/validation runs.
  const segments = text.split(/&&|\|\||[;|\n]/).map((segment) => segment.trim()).filter(Boolean);
  return !segments.every((segment) => VALIDATION_ONLY_COMMAND.test(segment));
}

export interface MutationPolicyVerdict {
  allowed: boolean;
  reason?: string;
}

/** State-changing capability tools beyond the workspace: process/service/task
 * control, drive mapping, external comments, memory writes, generation. Named
 * explicitly so they are denied even if an adapter misclassifies them; the
 * fail-closed rule below also catches any tool not listed here. */
const STATE_CHANGING_TOOL_NAMES = new Set([
  'system_kill_process', 'system_start_service', 'system_stop_service', 'system_set_scheduled_task_enabled',
  'connect_network_drive', 'disconnect_network_drive', 'github_comment_on_issue',
  'memory_remember', 'memory_forget', 'memory_resolve_contradiction', 'image_generate',
]);

/** Informational tools that adapters conservatively classify `consequential`
 * (they need approval for scope reasons) but that change no state. */
const INFORMATIONAL_TOOL_NAMES = new Set([
  'read_file', 'read_file_outside_workspace', 'list_directory_outside_workspace',
  'system_list_processes', 'system_hardware_telemetry', 'run_system_diagnostics', 'system_list_models', 'system_list_services', 'system_list_startup_items',
  'list_network_drives', 'github_read_issue', 'image_list_checkpoints', 'get_weather',
]);

/** Adapter risk classification, when the caller can supply one. */
export type ToolRiskLookup = (toolName: string) => 'read_only' | 'consequential' | undefined;

/**
 * Read-only means no state-changing capability at all — not merely no file
 * writes. Under `denied` a tool is allowed only when it is provably
 * informational; anything else (including unknown tools) fails closed.
 */
export function checkToolCallAgainstMutationPolicy(
  policy: MutationPolicy,
  call: { name: string; arguments: Record<string, unknown> },
  riskOf?: ToolRiskLookup,
): MutationPolicyVerdict {
  if (policy !== 'denied') return { allowed: true };
  if (call.name === 'run_command') {
    return isNonMutatingShellCommand(String(call.arguments.command ?? ''))
      ? { allowed: true }
      : { allowed: false, reason: 'this shell command is not on the non-mutating allowlist' };
  }
  if (STATE_CHANGING_TOOL_NAMES.has(call.name) || isMutatingToolName(call.name)) {
    return { allowed: false, reason: `'${call.name}' can change state on this machine or workspace` };
  }
  if (INFORMATIONAL_TOOL_NAMES.has(call.name) || riskOf?.(call.name) === 'read_only') return { allowed: true };
  return { allowed: false, reason: `'${call.name}' is not known to be read-only` };
}

/** Whether a tool is even offered to the model under a policy. `run_command`
 * stays exposed because each invocation is checked against the shell allowlist. */
export function isToolExposedUnderMutationPolicy(policy: MutationPolicy, toolName: string, riskOf?: ToolRiskLookup): boolean {
  if (policy !== 'denied' || toolName === 'run_command') return true;
  return checkToolCallAgainstMutationPolicy(policy, { name: toolName, arguments: {} }, riskOf).allowed;
}

export const MUTATION_DENIED_NOTICE =
  'Mutation policy for this objective: DENIED. The user explicitly asked for a read-only task. ' +
  'Do not change any state: no file writes, edits, deletes, renames, patches, commits or installs, ' +
  'and no killing processes, starting/stopping services, toggling scheduled tasks or changing configuration. ' +
  'Read, search, list and inspect status as needed, then answer directly.';
