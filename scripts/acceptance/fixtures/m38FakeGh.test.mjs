import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ghFakeScript = path.join(__dirname, 'fakeGh', 'ghFake.mjs');

// Invoked exactly the way `core/index.ts`'s `testGithubExecutorOverride()`
// invokes it (`node <script> <args>`) — NOT via a PATH-scoped `gh` shim. A
// bare `execFile('gh', ...)` without a shell cannot reliably resolve a
// PATH-scoped `.cmd` fake on Windows (Win32 `CreateProcess` auto-appends
// `.exe` to an extensionless command and never falls back to `.cmd`/`.bat`
// without a shell, so any real `gh.exe` elsewhere on PATH wins regardless of
// directory order) — see the doc comment on `testGithubExecutorOverride`.
function run(args, dataDir) {
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      [ghFakeScript, ...args],
      { cwd: dataDir, env: { ...process.env, KARKEDIKHA_FAKE_GH_DATA_DIR: dataDir }, windowsHide: true },
      (err, stdout, stderr) => {
        const code = err && typeof err.code === 'number' ? err.code : err ? 1 : 0;
        resolve({ code, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') });
      },
    );
  });
}

function mutationCount(dataDir) {
  try {
    return JSON.parse(fs.readFileSync(path.join(dataDir, 'mutationCount.json'), 'utf8')).count ?? 0;
  } catch {
    return 0;
  }
}

test('fake gh: read behavior returns deterministic JSON with no mutation', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'm38-fake-gh-read-'));
  try {
    const result = await run(['issue', 'view', '5', '--repo', 'acme/widgets', '--json', 'number,title,body,state,url,comments'], dataDir);
    assert.equal(result.code, 0, result.stderr);
    const parsed = JSON.parse(result.stdout);
    assert.equal(parsed.number, 5);
    assert.deepEqual(parsed.comments, []);
    assert.equal(mutationCount(dataDir), 0);
    const calls = fs.readFileSync(path.join(dataDir, 'calls.log'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    assert.equal(calls.length, 1);
    assert.equal(calls[0].kind, 'issue_view');
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('fake gh: issue comment posts, increments the mutation counter exactly once, and a follow-up read sees it', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'm38-fake-gh-comment-'));
  try {
    assert.equal(mutationCount(dataDir), 0);

    const commentResult = await run(['issue', 'comment', '7', '--repo', 'acme/widgets', '--body', 'hello from the fixture'], dataDir);
    assert.equal(commentResult.code, 0, commentResult.stderr);
    assert.match(commentResult.stdout, /FIXTURE_GH_COMMENT_POSTED/);
    assert.equal(mutationCount(dataDir), 1);

    // A second, different mutating call increments again (no dedupe at this
    // layer — the real adapter's idempotency marker is what prevents a
    // duplicate post at the caller level; the fixture's job is only to
    // record that a mutation genuinely happened).
    await run(['issue', 'comment', '7', '--repo', 'acme/widgets', '--body', 'second comment'], dataDir);
    assert.equal(mutationCount(dataDir), 2);

    const readBack = await run(['issue', 'view', '7', '--repo', 'acme/widgets', '--json', 'comments'], dataDir);
    const parsed = JSON.parse(readBack.stdout);
    assert.deepEqual(parsed.comments.map((c) => c.body), ['hello from the fixture', 'second comment']);

    const calls = fs.readFileSync(path.join(dataDir, 'calls.log'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    assert.equal(calls.filter((c) => c.kind === 'issue_comment').length, 2);
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('fake gh: rejects an unexpected subcommand non-zero with no mutation', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'm38-fake-gh-reject-'));
  try {
    const result = await run(['repo', 'clone', 'acme/widgets'], dataDir);
    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /unexpected subcommand/);
    assert.equal(mutationCount(dataDir), 0);
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('fake gh: auth status supports the capability health probe', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'm38-fake-gh-auth-'));
  try {
    const result = await run(['auth', 'status'], dataDir);
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /Logged in/);
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});
