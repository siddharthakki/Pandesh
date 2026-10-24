#!/usr/bin/env node
/**
 * M38 — fake `gh` fixture logic.
 *
 * Invoked via the PATH-scoped `gh.cmd` wrapper in this directory, standing
 * in for the real `gh` binary `core/runtime/githubCapability.ts`'s
 * `defaultExecutor` shells out to (`execFile('gh', args, ...)`). Supports
 * exactly the subcommands that adapter issues:
 *   - `auth status`                                     (health probe)
 *   - `issue view <n> --repo <r> --json <fields>`        (read / dedupe check)
 *   - `issue comment <n> --repo <r> --body <text>`       (the one mutation)
 * Anything else exits non-zero with a clear stderr message. State (a
 * mutation counter and the posted comments, so a second identical
 * `issue view --json comments` call sees prior mutations) is persisted
 * under `KARKEDIKHA_FAKE_GH_DATA_DIR`, since every invocation is a fresh
 * process with no shared memory.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

const args = process.argv.slice(2);
const dataDir = process.env.KARKEDIKHA_FAKE_GH_DATA_DIR;

function fail(message) {
  process.stderr.write(`fake gh: ${message}\n`);
  process.exit(1);
}

if (!dataDir) fail('KARKEDIKHA_FAKE_GH_DATA_DIR is not set');
fs.mkdirSync(dataDir, { recursive: true });

const callsLogPath = path.join(dataDir, 'calls.log');
const mutationCountPath = path.join(dataDir, 'mutationCount.json');

function appendCallLog(entry) {
  fs.appendFileSync(callsLogPath, `${JSON.stringify({ ...entry, argv: args, at: new Date().toISOString() })}\n`, 'utf8');
}

function readMutationCount() {
  try {
    return JSON.parse(fs.readFileSync(mutationCountPath, 'utf8')).count ?? 0;
  } catch {
    return 0;
  }
}

function writeMutationCount(count) {
  fs.writeFileSync(mutationCountPath, JSON.stringify({ count }), 'utf8');
}

function commentsFilePath(repository, number) {
  const safeRepo = repository.replace(/[^a-zA-Z0-9_-]/g, '_');
  return path.join(dataDir, `comments-${safeRepo}-${number}.json`);
}

function readComments(repository, number) {
  try {
    return JSON.parse(fs.readFileSync(commentsFilePath(repository, number), 'utf8'));
  } catch {
    return [];
  }
}

function writeComments(repository, number, comments) {
  fs.writeFileSync(commentsFilePath(repository, number), JSON.stringify(comments), 'utf8');
}

function flag(name) {
  const idx = args.indexOf(name);
  return idx === -1 ? undefined : args[idx + 1];
}

if (args[0] === 'auth' && args[1] === 'status') {
  appendCallLog({ kind: 'auth_status' });
  process.stdout.write('Logged in to github.com as m38-fixture-user\n');
  process.exit(0);
}

if (args[0] === 'issue' && args[1] === 'view') {
  const number = Number(args[2]);
  const repository = flag('--repo');
  const jsonFields = flag('--json');
  if (!Number.isInteger(number) || number <= 0 || !repository || !jsonFields) {
    appendCallLog({ kind: 'rejected', reason: 'issue view missing number/--repo/--json' });
    fail(`unexpected 'issue view' invocation: ${args.join(' ')}`);
  }
  appendCallLog({ kind: 'issue_view', number, repository, jsonFields });
  const comments = readComments(repository, number).map((body, index) => ({ id: index + 1, body }));
  const fields = jsonFields.split(',');
  const full = {
    number,
    title: `Fixture issue ${number}`,
    body: 'Fixture issue body used by the M38 Core-only smoke.',
    state: 'open',
    url: `https://github.com/${repository}/issues/${number}`,
    comments,
  };
  const filtered = Object.fromEntries(fields.map((field) => [field, full[field]]).filter(([, value]) => value !== undefined));
  process.stdout.write(`${JSON.stringify(filtered)}\n`);
  process.exit(0);
}

if (args[0] === 'issue' && args[1] === 'comment') {
  const number = Number(args[2]);
  const repository = flag('--repo');
  const body = flag('--body');
  if (!Number.isInteger(number) || number <= 0 || !repository || !body) {
    appendCallLog({ kind: 'rejected', reason: 'issue comment missing number/--repo/--body' });
    fail(`unexpected 'issue comment' invocation: ${args.join(' ')}`);
  }
  const comments = readComments(repository, number);
  comments.push(body);
  writeComments(repository, number, comments);
  const count = readMutationCount() + 1;
  writeMutationCount(count);
  appendCallLog({ kind: 'issue_comment', number, repository, bodyLength: body.length, mutationCountAfter: count });
  process.stdout.write(`https://github.com/${repository}/issues/${number}#issuecomment-${comments.length} FIXTURE_GH_COMMENT_POSTED\n`);
  process.exit(0);
}

appendCallLog({ kind: 'rejected', reason: 'unknown subcommand' });
fail(`unexpected subcommand: ${args.join(' ')}`);
