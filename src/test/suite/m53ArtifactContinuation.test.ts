// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { assembleSaathTaskResult, terminalOutcomeForResult } from '../../ui/taskResultAssembly';
import { RecentArtifactBook, ambiguousReferentQuestion, buildArtifactPack, namesExplicitFile } from '../../ui/recentArtifacts';
import { AttachmentRetention, isBareResumeIntent } from '../../ui/attachmentRetention';
import { normalizeRepositoryContext } from '../../../core/domain/attemptContext';

const media = path.join(__dirname, '../../../media');

describe('M53 Saath Kar TaskResult / artifact surface', () => {
  let root: string;
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'kd-m53-'));
    fs.mkdirSync(path.join(root, 'uat-m51-multifile'));
    fs.writeFileSync(path.join(root, 'uat-m51-multifile', 'weather.html'), '<!doctype html><html><head><title>Weather</title></head><body>Sunny</body></html>');
  });
  afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });

  const evidence = (over: Record<string, unknown> = {}) => ({
    attemptId: 'att_1',
    outcome: 'completed' as const,
    model: 'qwen3-coder',
    mutations: [{ path: 'uat-m51-multifile/weather.html', ok: true, operation: 'create_file' }],
    validations: [],
    structuralChecks: [{ path: 'uat-m51-multifile/weather.html', ok: true, summary: 'Static HTML structure check passed' }],
    ...over,
  });

  it('a created HTML file becomes a real, disk-verified artifact with Open / Preview actions, and the structure check is not called a test pass', () => {
    const result = assembleSaathTaskResult(evidence(), { workspaceRoot: root })!;
    expect(result.status).toBe('completed');
    expect(result.changes).toEqual({ created: ['uat-m51-multifile/weather.html'], modified: [], deleted: [] });
    expect(result.artifacts).toHaveLength(1);
    expect(result.artifacts[0]).toMatchObject({ type: 'html', path: 'uat-m51-multifile/weather.html', title: 'weather.html' });
    expect(result.artifacts[0].hash).toMatch(/^[0-9a-f]{64}$/);
    expect(result.actions.map(action => action.kind)).toEqual(expect.arrayContaining(['preview', 'open-file']));
    // Not a test or build pass: validationStatus stays "none recorded"; the structure check is separate evidence.
    expect(result.validationStatus).toBe('none_recorded');
    expect(result.evidence.some(entry => /^structure check /.test(entry.subject) && entry.ok === true)).toBe(true);
    expect(result.origin).toMatchObject({ taskId: 'att_1', model: 'qwen3-coder' });
  });

  it('a real validation gate that passed is a passed validation; one that failed is not green', () => {
    const passed = assembleSaathTaskResult(evidence({ validations: [{ command: 'npm test', ok: true, exitCode: 0 }], structuralChecks: [] }), { workspaceRoot: root })!;
    expect(passed.validationStatus).toBe('passed');
    expect(passed.status).toBe('completed');
    const failed = assembleSaathTaskResult(evidence({ validations: [{ command: 'npm test', ok: false, exitCode: 1 }], structuralChecks: [] }), { workspaceRoot: root })!;
    expect(failed.validationStatus).toBe('failed');
    expect(failed.status).toBe('partial');
    expect(terminalOutcomeForResult(failed).outcome).toBe('failed');
  });

  it('a failed structure check downgrades a completed turn to partial', () => {
    const result = assembleSaathTaskResult(evidence({ structuralChecks: [{ path: 'uat-m51-multifile/weather.html', ok: false, summary: 'unterminated <script>' }] }), { workspaceRoot: root })!;
    expect(result.status).toBe('partial');
    expect(result.warnings?.join(' ')).toContain('Structure check failed');
  });

  it('a pure conversation (no mutation, no validation) has no card, and a recorded change whose file is missing is not claimed', () => {
    expect(assembleSaathTaskResult(evidence({ mutations: [], structuralChecks: [] }), { workspaceRoot: root })).toBeUndefined();
    const ghost = assembleSaathTaskResult(evidence({ mutations: [{ path: 'ghost.html', ok: true }], structuralChecks: [] }), { workspaceRoot: root })!;
    expect(ghost.artifacts).toEqual([]);
  });

  it('a denied or failed write is not an artifact', () => {
    const result = assembleSaathTaskResult(evidence({ mutations: [{ path: 'uat-m51-multifile/weather.html', ok: false }], structuralChecks: [] }), { workspaceRoot: root });
    expect(result).toBeUndefined();
  });
});

describe('M53 recent artifact referent continuation', () => {
  let root: string;
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'kd-m53-ref-'));
    fs.mkdirSync(path.join(root, 'uat-m51-multifile'));
    fs.writeFileSync(path.join(root, 'uat-m51-multifile', 'weather.html'), '<!doctype html>\n<html>\n<head><title>Weather</title></head>\n<body>Sunny</body>\n</html>\n');
  });
  afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });

  const saathResult = () => assembleSaathTaskResult({
    attemptId: 'att_1', outcome: 'completed',
    mutations: [{ path: 'uat-m51-multifile/weather.html', ok: true, operation: 'create_file' }], validations: [], structuralChecks: [],
  }, { workspaceRoot: root })!;

  it('regression: Saath creates weather.html -> "add a login page to this html" binds weather.html as the primary target', () => {
    const book = new RecentArtifactBook();
    book.recordResult('conv', 'att_1', 'saath_kar', saathResult());
    const resolution = book.resolve('conv', 'add a login page to this html');
    expect(resolution.status).toBe('bound');
    if (resolution.status !== 'bound') return;
    expect(resolution.artifact.path).toBe('uat-m51-multifile/weather.html');

    // The pack IS that file (no retrieval), whole, carrying the real path and marked complete for Core.
    const pack = buildArtifactPack({ workspaceRoot: root, artifact: resolution.artifact, phrase: resolution.phrase, budgetChars: 60_000 })!;
    expect(pack.selectedFiles).toEqual([expect.objectContaining({ path: 'uat-m51-multifile/weather.html', complete: true })]);
    expect(pack.prompt).toContain('uat-m51-multifile/weather.html');
    expect(pack.prompt).toContain('<body>Sunny</body>');
    expect(pack.prompt).not.toContain('OnboardingView');
    // Core accepts it as a frozen repository context (hash matches, bounded) and keeps the `complete` marker.
    const normalized = normalizeRepositoryContext(pack);
    expect(normalized.selectedFiles[0]).toMatchObject({ path: 'uat-m51-multifile/weather.html', complete: true });
  });

  it.each([
    'add a login page to this html',
    'modify it',
    'change that file to use a dark theme',
    'update the page so it shows a 5 day forecast',
    'open this html and fix the header',
    'make it responsive',
  ])('"%s" resolves to the unique recent artifact', (text) => {
    const book = new RecentArtifactBook();
    book.recordResult('conv', 'att_1', 'saath_kar', saathResult());
    expect(book.resolve('conv', text)).toMatchObject({ status: 'bound', artifact: { path: 'uat-m51-multifile/weather.html' } });
  });

  it('an explicit path, or a request that names no referent, is never rebound', () => {
    const book = new RecentArtifactBook();
    book.recordResult('conv', 'att_1', 'saath_kar', saathResult());
    expect(namesExplicitFile('add a login page to src/onboarding/OnboardingView.ts')).toBe(true);
    expect(book.resolve('conv', 'add a login page to src/onboarding/OnboardingView.ts').status).toBe('none');
    expect(book.resolve('conv', 'what is the capital of France?').status).toBe('none');
    expect(book.resolve('conv', 'explain how the router works').status).toBe('none');
  });

  it('genuine ambiguity (several files from the last task, no type to narrow by) asks which one; a type narrows it', () => {
    fs.writeFileSync(path.join(root, 'uat-m51-multifile', 'style.css'), 'body{}');
    const result = assembleSaathTaskResult({
      attemptId: 'att_2', outcome: 'completed',
      mutations: [{ path: 'uat-m51-multifile/weather.html', ok: true }, { path: 'uat-m51-multifile/style.css', ok: true }], validations: [], structuralChecks: [],
    }, { workspaceRoot: root })!;
    const book = new RecentArtifactBook();
    book.recordResult('conv', 'att_2', 'saath_kar', result);
    const ambiguous = book.resolve('conv', 'modify it');
    expect(ambiguous.status).toBe('ambiguous');
    if (ambiguous.status === 'ambiguous') expect(ambiguousReferentQuestion(ambiguous.candidates)).toContain('weather.html');
    expect(book.resolve('conv', 'add a login page to this html')).toMatchObject({ status: 'bound', artifact: { path: 'uat-m51-multifile/weather.html' } });
    expect(book.resolve('conv', 'make the stylesheet darker')).toMatchObject({ status: 'bound', artifact: { path: 'uat-m51-multifile/style.css' } });
  });

  it('a newer task supersedes an older one; a re-polled result is recorded once', () => {
    const book = new RecentArtifactBook();
    book.recordResult('conv', 'att_1', 'saath_kar', saathResult());
    book.recordResult('conv', 'att_1', 'saath_kar', saathResult());
    expect(book.list('conv')).toHaveLength(1);
    fs.writeFileSync(path.join(root, 'notes.md'), '# n');
    const next = assembleSaathTaskResult({ attemptId: 'att_3', outcome: 'completed', mutations: [{ path: 'notes.md', ok: true }], validations: [], structuralChecks: [] }, { workspaceRoot: root })!;
    book.recordResult('conv', 'att_3', 'saath_kar', next);
    expect(book.resolve('conv', 'modify it')).toMatchObject({ status: 'bound', artifact: { path: 'notes.md' } });
    // The html is still reachable by type.
    expect(book.resolve('conv', 'add a login page to this html')).toMatchObject({ status: 'bound', artifact: { path: 'uat-m51-multifile/weather.html' } });
  });

  it('New Chat clears the binding, History reopen does not reactivate it, and a deleted file is not a referent', () => {
    const book = new RecentArtifactBook();
    book.recordResult('conv', 'att_1', 'saath_kar', saathResult());
    book.recordResult('other', 'att_9', 'saath_kar', saathResult());
    book.clear('conv'); // History reopen of "conv"
    expect(book.resolve('conv', 'modify it').status).toBe('none');
    expect(book.resolve('other', 'modify it').status).toBe('bound');
    book.clear(); // New Chat
    expect(book.resolve('other', 'modify it').status).toBe('none');

    book.recordResult('conv2', 'att_1', 'saath_kar', saathResult());
    fs.rmSync(path.join(root, 'uat-m51-multifile', 'weather.html'));
    book.prune('conv2', relative => fs.existsSync(path.join(root, relative)));
    expect(book.resolve('conv2', 'modify it').status).toBe('none');
  });

  it('a file too large for the budget is packed as a clearly-marked head, not as complete', () => {
    const big = `${Array.from({ length: 800 }, (_, i) => `<p>row ${i + 1} ${'x'.repeat(60)}</p>`).join('\n')}\n`;
    fs.writeFileSync(path.join(root, 'uat-m51-multifile', 'big.html'), big);
    const pack = buildArtifactPack({
      workspaceRoot: root, phrase: 'this html', budgetChars: 8_000,
      artifact: { path: 'uat-m51-multifile/big.html', type: 'html', title: 'big.html', origin: { taskId: 't', surface: 'saath_kar' }, sequence: 1 },
    })!;
    expect(pack.selectedFiles[0].complete).toBe(false);
    expect(pack.prompt).toContain('Only lines 1-');
    expect(pack.prompt).toContain('startLine=');
    expect(pack.prompt.length).toBeLessThan(9_000);
    expect(normalizeRepositoryContext(pack).selectedFiles[0].complete).toBeUndefined();
  });

  it('refuses a path that escapes the workspace', () => {
    expect(buildArtifactPack({
      workspaceRoot: root, phrase: 'it', budgetChars: 10_000,
      artifact: { path: '../outside.txt', type: 'file', title: 'outside.txt', origin: { taskId: 't', surface: 'saath_kar' }, sequence: 1 },
    })).toBeUndefined();
  });
});

describe('M53 attachment persistence through a blocked turn', () => {
  it('a blocked image turn keeps its attachment; "resume" continues the SAME objective with the SAME attachment (no re-upload)', () => {
    const retention = new AttachmentRetention();
    retention.retain('conv', { text: 'What is the red object in this image?', attachmentIds: ['att-img-1'], reason: 'no vision-capable model' });
    for (const resume of ['resume', 'Resume', 'continue', 'retry', 'yes, continue', 'try again']) {
      const resolved = retention.resolve('conv', resume, []);
      expect(resolved).toMatchObject({ carried: true, text: 'What is the red object in this image?', attachmentIds: ['att-img-1'] });
    }
  });

  it('a different request does not silently inherit the old image; a new upload replaces it; the turn committing consumes it', () => {
    const retention = new AttachmentRetention();
    retention.retain('conv', { text: 'Describe this image', attachmentIds: ['att-img-1'], reason: 'blocked' });
    expect(retention.resolve('conv', 'what time is it in Tokyo?', [])).toMatchObject({ carried: false, attachmentIds: [] });
    expect(retention.resolve('conv', 'look at this one instead', ['att-img-2'])).toMatchObject({ carried: false, attachmentIds: ['att-img-2'] });
    expect(retention.peek('conv')).toBeUndefined();

    retention.retain('conv', { text: 'Describe this image', attachmentIds: ['att-img-3'], reason: 'blocked' });
    retention.consume('conv');
    expect(retention.resolve('conv', 'resume', [])).toMatchObject({ carried: false, attachmentIds: [] });
  });

  it('New Chat clears everything and History reopen does not reactivate a conversation\'s retention', () => {
    const retention = new AttachmentRetention();
    retention.retain('a', { text: 'x', attachmentIds: ['1'], reason: 'r' });
    retention.retain('b', { text: 'y', attachmentIds: ['2'], reason: 'r' });
    retention.clear('a');
    expect(retention.resolve('a', 'resume', []).carried).toBe(false);
    expect(retention.resolve('b', 'resume', []).carried).toBe(true);
    retention.clear();
    expect(retention.resolve('b', 'resume', []).carried).toBe(false);
  });

  it('only a bare resume intent counts', () => {
    expect(isBareResumeIntent('resume')).toBe(true);
    expect(isBareResumeIntent('Continue.')).toBe(true);
    expect(isBareResumeIntent('resume the work on the login page and also add tests')).toBe(false);
    expect(isBareResumeIntent('')).toBe(false);
  });
});

describe('M53 result card (webview)', () => {
  it('a Saath taskResult message renders the card with Open / Preview / Open in browser / Reveal / Copy path, inert until clicked', () => {
    document.body.innerHTML = '<div id="messages"></div>';
    const posted: Array<Record<string, any>> = [];
    (window as any).__ollamaAgentVsCodeApi = { postMessage: (m: Record<string, any>) => posted.push(m), getState: () => ({}), setState: () => undefined };
    // eslint-disable-next-line @typescript-eslint/no-implied-eval
    new Function(fs.readFileSync(path.join(media, 'chat-result-card.js'), 'utf8'))();
    const result = {
      status: 'completed', summary: 'Completed: 1 created, 0 modified, 0 deleted.', validationStatus: 'none_recorded', warnings: [],
      artifacts: [{ id: 'art-1', type: 'html', title: 'weather.html', path: 'uat-m51-multifile/weather.html', sizeBytes: 90, evidenceIds: [] }],
      evidence: [{ id: 'ev-1', kind: 'command_run', subject: 'structure check uat-m51-multifile/weather.html', summary: 'ok', ok: true }],
      validations: [], commands: [], changes: { created: ['uat-m51-multifile/weather.html'], modified: [], deleted: [] },
    };
    window.dispatchEvent(new MessageEvent('message', { data: { type: 'taskResult', taskId: 'att_1', taskResult: result } }));
    const card = document.querySelector('.kd-result-card')!;
    expect(posted).toEqual([]);
    expect(card.textContent).toContain('Completed');
    expect(card.textContent).toContain('Structure check passed (no test or build run)');
    expect(card.textContent).not.toContain('Validation passed');
    const buttons = [...card.querySelectorAll('button')];
    expect(buttons.map(b => b.textContent)).toEqual(['Open', 'Preview', 'Open in browser', 'Reveal', 'Copy path']);
    buttons[1].click();
    buttons[2].click();
    expect(posted).toEqual([
      { type: 'taskResultAction', action: 'preview', taskId: 'att_1', artifactId: 'art-1' },
      { type: 'taskResultAction', action: 'openInBrowser', taskId: 'att_1', artifactId: 'art-1' },
    ]);
  });
});
