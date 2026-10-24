import * as path from 'path';

export interface StrictTaskScope {
  strict: boolean;
  restrictMutations: boolean;
  restrictCommands: boolean;
  allowedPaths: string[];
  allowedCommands: string[];
  exactFileContents: Record<string, string>;
}

export interface StrictTaskAction {
  toolName: string;
  paths: string[];
  command?: string;
  arguments: Record<string, unknown>;
  workspaceRoot: string;
  mutatesWorkspace: boolean;
}

function normalizePath(value: string): string {
  const normalized = value.replace(/\\/g, '/').replace(/^\.\//, '').replace(/^\/+/, '').replace(/\/+$/, '');
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

function normalizeCandidatePath(value: string, workspaceRoot: string): string {
  const relative = path.isAbsolute(value) ? path.relative(workspaceRoot, value) : value;
  return normalizePath(relative);
}

function normalizeCommand(value: string): string {
  return value.trim().replace(/\s+/g, ' ');
}

function unique(values: string[]): string[] {
  return [...new Set(values.map(value => value.trim()).filter(Boolean))];
}

export function hasStrictTaskScope(text: string): boolean {
  return /exactly one new file|do not modify any other file|do not run any other command|do not run any commands?|do not run commands?|use exactly this content|containing exactly/i.test(text);
}

export function extractStrictTaskScope(text: string): StrictTaskScope {
  const restrictMutations = /exactly one new file|do not modify any other file|use exactly this content|containing exactly/i.test(text);
  const restrictCommands = /do not run any other command|do not run any commands?|do not run commands?/i.test(text);
  const pathMatch =
    text.match(/(?:create|write)\s+exactly\s+one\s+(?:new\s+)?file\s*:\s*`?([^`\s]+)`?/i) ??
    text.match(/(?:create|write)\s+(?:a\s+)?(?:new\s+)?file\s+(?:named|called)\s+`?([^`\s,;:]+)`?/i);
  const allowedPath = pathMatch?.[1]?.replace(/[.,;]+$/, '');

  const commands: string[] = [];
  for (const match of text.matchAll(/\brun\s+`([^`\r\n]+)`/gi)) {
    commands.push(normalizeCommand(match[1]));
  }
  for (const match of text.matchAll(/\brun\s+(npm\s+run\s+[a-z0-9:_-]+)/gi)) {
    commands.push(normalizeCommand(match[1]));
  }

  let exactContent: string | undefined;
  const marker = /(?:use exactly this content|containing exactly(?: this content)?)\s*:/i.exec(text);
  if (marker) {
    const remainder = text.slice(marker.index + marker[0].length);
    const requirements =
      /(?:^|\n)\s*requirements\s*:/i.exec(remainder) ??
      /\s+requirements\s*:/i.exec(remainder) ??
      /\s+(?=do not modify any other file|do not run any commands?|do not run commands?|do not run any other command)/i.exec(remainder);
    exactContent = (requirements ? remainder.slice(0, requirements.index) : remainder).trim() || undefined;
  }

  const exactFileContents: Record<string, string> = {};
  if (allowedPath && exactContent !== undefined) {
    exactFileContents[normalizePath(allowedPath)] = exactContent;
  }

  return {
    strict: restrictMutations || restrictCommands,
    restrictMutations,
    restrictCommands,
    allowedPaths: allowedPath ? [allowedPath] : [],
    allowedCommands: unique(commands),
    exactFileContents,
  };
}

export function normalizeStrictPath(value: string): string {
  return normalizePath(value);
}

export function normalizeStrictCommand(value: string): string {
  return normalizeCommand(value);
}

export function normalizeStrictContent(value: string): string {
  return value.replace(/\r\n/g, '\n').replace(/\r/g, '\n').replace(/\n+$/, '');
}

export function canonicalizeStrictTaskArguments(
  scope: StrictTaskScope,
  toolName: string,
  args: Record<string, unknown>,
  workspaceRoot: string,
): Record<string, unknown> {
  if (!scope.strict || (toolName !== 'write_file' && toolName !== 'edit_file')) {
    return args;
  }
  if (toolName === 'edit_file' && args['strategy'] !== 'whole_file') {
    return args;
  }

  const candidate = typeof args['path'] === 'string' ? args['path'] : '';
  if (!candidate) { return args; }
  const normalized = normalizeCandidatePath(candidate, workspaceRoot);
  const exactContent = scope.exactFileContents[normalized];
  if (exactContent === undefined) { return args; }

  const canonicalPath = scope.allowedPaths.find(item => normalizePath(item) === normalized) ?? candidate;
  return { ...args, path: canonicalPath, content: exactContent };
}

export function evaluateStrictTaskAction(
  scope: StrictTaskScope,
  action: StrictTaskAction,
): string | undefined {
  if (!scope.strict) { return undefined; }

  if (action.toolName === 'run_command' && scope.restrictCommands) {
    const command = normalizeCommand(action.command ?? '');
    const allowed = scope.allowedCommands.map(normalizeCommand);
    if (!command || !allowed.includes(command)) {
      return allowed.length > 0
        ? `Command "${command || '(empty)'}" is outside the exact command scope. Allowed: ${allowed.join(', ')}.`
        : 'Commands are explicitly prohibited for this task.';
    }
  }

  if (!action.mutatesWorkspace || action.toolName === 'run_command' || !scope.restrictMutations) {
    return undefined;
  }
  if (scope.allowedPaths.length === 0) {
    return 'An exact file scope was requested, but no permitted target path could be determined.';
  }
  if (action.paths.length === 0) {
    return 'The mutation target could not be proven to match the exact file scope.';
  }

  const allowed = scope.allowedPaths.map(candidate => normalizePath(candidate));
  const candidates = action.paths.map(candidate => normalizeCandidatePath(candidate, action.workspaceRoot));
  const outside = candidates.filter(candidate => !allowed.includes(candidate));
  if (outside.length > 0) {
    return `Mutation is outside the exact file scope: ${outside.join(', ')}. Allowed: ${allowed.join(', ')}.`;
  }

  for (const candidate of candidates) {
    const expected = scope.exactFileContents[candidate];
    if (expected === undefined) { continue; }
    const wholeFileWrite = action.toolName === 'write_file'
      || (action.toolName === 'edit_file' && action.arguments['strategy'] === 'whole_file');
    if (!wholeFileWrite) {
      return `Exact content for ${candidate} requires a whole-file write.`;
    }
    const supplied = action.arguments['content'];
    if (typeof supplied !== 'string' || normalizeStrictContent(supplied) !== normalizeStrictContent(expected)) {
      return `Proposed content for ${candidate} does not exactly match the requested content.`;
    }
  }

  return undefined;
}
