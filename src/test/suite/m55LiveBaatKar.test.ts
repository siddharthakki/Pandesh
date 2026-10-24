import { describe, expect, it, vi } from 'vitest';
import fsp from 'fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { AgentPanel } from '../../ui/AgentPanel';
import { CoreClient } from '../../core-client/CoreClient';
import { RepositoryIndex } from '../../context/RepositoryIndex';
import { openCoreDatabase } from '../../../core/db/openCore';
import { startApiServer } from '../../../core/api/server';
import { attachWsServer } from '../../../core/ws/server';
import { EventBroadcaster } from '../../../core/ws/broadcaster';
import { latestSequence } from '../../../core/domain/events';
import { generateToken } from '../../../core/auth/token';
import { OllamaModelBackend } from '../../../core/runtime/modelBackend';
import { CoreToolRunner } from '../../../core/runtime/toolRunner';
import { GovernedCapabilityRegistry, createWorkspaceCapabilityAdapter } from '../../../core/runtime/governedCapability';

const holder = vi.hoisted(() => ({ manager: undefined as unknown }));
vi.mock('../../extension', () => ({ getCoreManager: () => holder.manager }));

/**
 * M55 live acceptance. NOT a unit test: it drives the production conversation pipeline end to end —
 *   AgentPanel.sendToAgent (real host retrieval, model selection, Core submit)
 *   -> real CoreClient over HTTP/WS -> real in-process Core API + executor (Baat Kar, no tools)
 *   -> real local Ollama model.
 * Enabled only with KKD_M55_LIVE=1. Writes the transcript and the file-access trace to .tmp/m55-live/.
 */
const enabled = process.env.KKD_M55_LIVE === '1';
const MODEL = process.env.KKD_M55_MODEL || 'qwen3-coder:swift-27b';
const SOURCE_WORKSPACE = process.env.KKD_M55_WORKSPACE || 'C:/Projects/Events_Forms';
const OUT = path.join(process.cwd(), '.tmp', 'm55-live');

interface TurnRecord {
  scenario: string; prompt: string; activeEditor: string | null; answer: string; attemptStatus: string; failureReason?: string;
  contextFiles: string[]; contextTokens: number; contextPromptChars: number; contextHeaders: string[];
  fileOpens: string[]; toolInvocations: number; approvals: number; elapsedMs: number;
}
const records: TurnRecord[] = [];

describe.skipIf(!enabled)('M55 live Baat Kar workspace understanding (real pipeline, local model)', () => {
  async function boot() {
    const token = generateToken();
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'm55-live-core-'));
    const db = openCoreDatabase(path.join(dataDir, 'core.db')).db;
    const broadcaster = new EventBroadcaster();
    const api = await startApiServer({
      db, token, broadcaster, dataDir,
      coreInfo: () => ({ coreVersion: '0.1.0', apiVersion: 1, instanceId: 'm55-live', startedAt: new Date().toISOString(), nodeVersion: process.version, electronVersion: null, dataDir }),
      onShutdown: () => {},
      executorOptions: {
        backend: new OllamaModelBackend(), toolRunner: new CoreToolRunner(), defaultModel: MODEL,
        defaultWorkingDirectory: dataDir, dataDir,
        governedCapabilities: new GovernedCapabilityRegistry().register(createWorkspaceCapabilityAdapter()),
      },
    });
    const ws = attachWsServer({ httpServer: api.server, token, broadcaster, instanceId: 'm55-live', latestSequence: () => latestSequence(db) });
    const eventListeners: Array<(e: never) => void> = [];
    const tokenListeners: Array<(f: never) => void> = [];
    const client = new CoreClient({
      baseUrl: `http://127.0.0.1:${api.port}`, token, clientId: 'm55-live-client', clientVersion: '0.0.0-m55',
      onRuntimeEvent: e => eventListeners.forEach(l => l(e as never)),
      onRuntimeToken: f => tokenListeners.forEach(l => l(f as never)),
    });
    await client.start();
    const manager = {
      getClient: () => client,
      getStatus: () => ({ state: 'connected' as const }),
      onStatusChange: () => ({ dispose: () => undefined }),
      onRuntimeEvent: (l: (e: never) => void) => { eventListeners.push(l); return { dispose: () => undefined }; },
      onRuntimeToken: (l: (f: never) => void) => { tokenListeners.push(l); return { dispose: () => undefined }; },
    };
    holder.manager = manager;
    return { client, manager, db, async close() { await client.dispose?.(); ws.close(); await api.close(); db.close(); fs.rmSync(dataDir, { recursive: true, force: true }); } };
  }

  function newPanel(root: string, manager: unknown, active: string | null) {
    (vscode.window as unknown as { activeTextEditor?: unknown }).activeTextEditor = active
      ? { document: { uri: vscode.Uri.file(path.join(root, active)), fileName: active } } : undefined;
    const posted: Array<Record<string, unknown>> = [];
    const context = {
      subscriptions: [], extensionUri: vscode.Uri.file(process.cwd()),
      secrets: { get: async () => undefined, store: async () => undefined, delete: async () => undefined, onDidChange: () => ({ dispose: () => undefined }) },
      extension: { packageJSON: { scripts: {}, contributes: { commands: [] } } },
      globalState: { get: () => undefined, update: async () => undefined, keys: () => [] },
      workspaceState: { get: () => undefined, update: async () => undefined, keys: () => [] },
    } as unknown as vscode.ExtensionContext;
    const panel = new AgentPanel(context, root, true) as unknown as {
      bindCoreManager(m: unknown): void; resolveWebviewView(...a: unknown[]): void; sendToAgent(text: string, ids: string[], mode: string, model?: string): Promise<void>;
      workspaceIdentity: string;
    };
    const webview = { options: {}, html: '', cspSource: 'x', asWebviewUri: (u: unknown) => u, postMessage: (m: Record<string, unknown>) => { posted.push(m); return Promise.resolve(true); }, onDidReceiveMessage: () => ({ dispose: () => undefined }) };
    panel.resolveWebviewView({ webview, show: () => undefined, onDidDispose: () => ({ dispose: () => undefined }), visible: true }, {}, {});
    panel.bindCoreManager(manager);
    return { panel, posted };
  }

  const opened: string[] = [];
  const origOpen = fsp.open.bind(fsp);
  function traceFileOpens(on: boolean) {
    if (on) { (fsp as unknown as { open: unknown }).open = async (p: string, ...rest: unknown[]) => { opened.push(String(p)); return (origOpen as (...a: unknown[]) => unknown)(p, ...rest); }; }
    else (fsp as unknown as { open: unknown }).open = origOpen;
    syncBuiltinESMExports();
  }

  async function turn(env: Awaited<ReturnType<typeof boot>>, ui: ReturnType<typeof newPanel>, root: string, scenario: string, prompt: string, active: string | null) {
    opened.length = 0;
    traceFileOpens(true);
    const started = Date.now();
    await ui.panel.sendToAgent(prompt, [], 'chat', MODEL);
    traceFileOpens(false);
    const retrievalOpens = opened.filter(file => file.replace(/\\/g, '/').toLowerCase().startsWith(root.replace(/\\/g, '/').toLowerCase())).map(file => path.relative(root, file).replace(/\\/g, '/'));
    const ledger = await env.client.getWorkspaceConversationLedger(ui.panel.workspaceIdentity);
    const last = [...ledger.turns].reverse()[0];
    let attempt = await env.client.getAttempt(last.attemptId);
    const deadline = Date.now() + 15 * 60_000;
    while (!['completed', 'failed', 'cancelled'].includes(attempt.status) && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 750));
      attempt = await env.client.getAttempt(last.attemptId);
    }
    const { messages } = await env.client.listMessages(ledger.currentCoreConversationId as string);
    const answer = [...messages].reverse().find(message => message.role === 'assistant')?.content ?? '';
    const frozen = await env.client.getAttemptContext(last.attemptId);
    const pack = frozen.repositoryContext;
    const record: TurnRecord = {
      scenario, prompt, activeEditor: active, answer, attemptStatus: attempt.status, failureReason: attempt.failureReason ?? undefined,
      contextFiles: pack?.selectedFiles.map(file => file.path) ?? [], contextTokens: pack?.estimatedTokens ?? 0, contextPromptChars: pack?.prompt.length ?? 0,
      contextHeaders: (pack?.prompt ?? '').split(/\r?\n/).filter(line => line.startsWith('--- ')).map(line => line.slice(0, 160)),
      fileOpens: [...new Set(retrievalOpens)],
      toolInvocations: env.db.all('SELECT id FROM tool_invocations WHERE attemptId = ?', [last.attemptId]).length,
      approvals: env.db.all('SELECT id FROM approvals WHERE attemptId = ?', [last.attemptId]).length,
      elapsedMs: Date.now() - started,
    };
    records.push(record);
    fs.mkdirSync(OUT, { recursive: true });
    fs.writeFileSync(path.join(OUT, 'transcript.json'), JSON.stringify(records, null, 2));
    expect(record.attemptStatus).toBe('completed');
    expect(record.toolInvocations).toBe(0);
    expect(record.approvals).toBe(0);
    return { record, pack };
  }

  const copyFixture = (name: string, files: Record<string, string | Buffer>) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), `m55-live-${name}-`));
    for (const [rel, content] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true }); fs.writeFileSync(path.join(root, rel), content); }
    return root;
  };
  const eventForms = () => fs.readFileSync(path.join(SOURCE_WORKSPACE, 'event_forms.html'));

  it('S1 the reported failure: real Events_Forms workspace, 4 turns in one conversation, active editor on event_forms.html', async () => {
    const env = await boot();
    try {
      const ui = newPanel(SOURCE_WORKSPACE, env.manager, 'event_forms.html');
      const before = fs.statSync(path.join(SOURCE_WORKSPACE, 'event_forms.html')).mtimeMs;
      const t1 = await turn(env, ui, SOURCE_WORKSPACE, 'S1', 'How does this app work?', 'event_forms.html');
      expect(t1.record.contextFiles).toContain('event_forms.html');
      const t2 = await turn(env, ui, SOURCE_WORKSPACE, 'S1', 'check the html, iddentify functionalities', 'event_forms.html');
      expect(t2.record.contextFiles).toContain('event_forms.html');
      expect(t2.record.answer).not.toMatch(/paste|share (?:the|your) (?:html|code|file)/i);
      const t3 = await turn(env, ui, SOURCE_WORKSPACE, 'S1', 'where is the validation logic?', 'event_forms.html');
      expect(t3.pack?.prompt).toContain('Enter a valid email');
      const t4 = await turn(env, ui, SOURCE_WORKSPACE, 'S1', 'explain what happens when a guest submits the form', 'event_forms.html');
      expect(t4.pack?.prompt).toContain('function guestSubmit');
      expect(fs.statSync(path.join(SOURCE_WORKSPACE, 'event_forms.html')).mtimeMs).toBe(before);
    } finally { await env.close(); }
  }, 30 * 60_000);

  it('S2 active-editor context: "explain this file" with two HTML files, the editor is on the smaller one', async () => {
    const root = copyFixture('active', { 'event_forms.html': eventForms(), 'about.html': '<!doctype html><html><head><title>About Us</title></head><body><h1>About the Turnout team</h1><p>We make event forms.</p></body></html>' });
    const env = await boot();
    try {
      const ui = newPanel(root, env.manager, 'about.html');
      const t = await turn(env, ui, root, 'S2', 'explain this file', 'about.html');
      expect(t.record.contextFiles).toEqual(['about.html']);
      expect(t.record.answer).toMatch(/about/i);
    } finally { await env.close(); }
  }, 20 * 60_000);

  it('S3 missing / renamed file: the model must say the file does not exist, not invent it', async () => {
    const root = copyFixture('renamed', { 'event_forms_renamed.html': eventForms() });
    const env = await boot();
    try {
      const ui = newPanel(root, env.manager, null);
      const t = await turn(env, ui, root, 'S3', 'check event_forms.html and tell me what it does', null);
      expect(t.pack?.prompt).toContain('No file matching "event_forms.html" exists');
      expect(t.record.answer).toMatch(/event_forms_renamed\.html|does(?:n'|\s?no)t exist|not (?:found|exist)|no file/i);
    } finally { await env.close(); }
  }, 20 * 60_000);

  it('S4 stale index: a prebuilt repository index that predates the file must not block a direct read', async () => {
    const root = copyFixture('stale', { 'notes.txt': 'old' });
    await new RepositoryIndex(root).build(true);
    fs.writeFileSync(path.join(root, 'event_forms.html'), eventForms());
    await new Promise(resolve => setTimeout(resolve, 700));
    const env = await boot();
    try {
      const ui = newPanel(root, env.manager, null);
      const t = await turn(env, ui, root, 'S4', 'check event_forms.html and identify its functionalities', null);
      expect(t.record.contextFiles).toContain('event_forms.html');
    } finally { await env.close(); }
  }, 20 * 60_000);

  it('S5 multiple files: an HTML page with linked local JavaScript and CSS (plus a CDN script that must not be fetched)', async () => {
    const root = copyFixture('multi', {
      'index.html': '<!doctype html><html><head><title>RSVP</title><link rel="stylesheet" href="styles.css"><script src="https://cdn.example.com/x.js"></script></head><body><form id="rsvp"><input id="email"><button id="go">RSVP</button></form><script src="js/rsvp.js"></script></body></html>',
      'styles.css': 'form{max-width:480px}#go{background:#e4572e}\n',
      'js/rsvp.js': 'document.getElementById("go").addEventListener("click", function (e) {\n  e.preventDefault();\n  var email = document.getElementById("email").value;\n  if (!/^[^@\\s]+@[^@\\s]+$/.test(email)) { alert("Please enter a valid email"); return; }\n  localStorage.setItem("rsvp:" + email, new Date().toISOString());\n});\n',
    });
    const env = await boot();
    try {
      const ui = newPanel(root, env.manager, 'index.html');
      const t = await turn(env, ui, root, 'S5', 'check the html and identify the functionalities, including how the RSVP is validated and stored', 'index.html');
      expect(t.record.contextFiles).toEqual(expect.arrayContaining(['index.html', 'js/rsvp.js']));
      expect(t.record.answer).toMatch(/localStorage|local storage/i);
    } finally { await env.close(); }
  }, 20 * 60_000);

  it('S6 large HTML (~1.5 MB, script past the 600 KB read window): bounded, and says what was not read', async () => {
    const filler = Array.from({ length: 30_000 }, (_, i) => `.u${i}{margin:${i % 40}px;padding:${i % 9}px;color:#${((i * 7919) % 0xffffff).toString(16).padStart(6, '0')}}`).join('\n');
    const html = `<!doctype html><html><head><title>Huge</title><style>\n${filler}\n</style></head><body><script>\nfunction earlyInit(){document.title="early"}\n</script></body></html>`;
    const root = copyFixture('large', { 'huge.html': html });
    const env = await boot();
    try {
      const ui = newPanel(root, env.manager, 'huge.html');
      const t = await turn(env, ui, root, 'S6', 'check the html and identify functionalities', 'huge.html');
      expect(t.record.contextPromptChars).toBeLessThan(80_000);
      expect(t.pack?.prompt).toContain('only the first part of a larger file was read');
    } finally { await env.close(); }
  }, 20 * 60_000);
  it.skipIf(process.env.KKD_M55_FULL !== '1')('S7 end-to-end: understand -> inspect -> persistence -> copy -> refactor -> validate -> deliver, one conversation, approvals enforced', async () => {
    const crypto = await import('node:crypto');
    const sha = (file: string) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
    // The run happens in a pristine temp copy so earlier runs' leftovers in the user's real folder cannot pollute the baseline
    // and the real folder is never written to. SOURCE_WORKSPACE is only the read-only source of event_forms.html.
    const workspace = copyFixture('s7', { 'event_forms.html': eventForms() });
    const original = path.join(workspace, 'event_forms.html');
    const originalSha = sha(original);
    // Harness artifacts are runtime state the product keeps under `.ollama-agent/`. Every other path in the workspace
    // (dotfiles included) is a user-workspace file and is subject to the "no unexpected files" rule.
    const isHarnessArtifact = (rel: string) => rel === '.ollama-agent' || rel.startsWith('.ollama-agent/');
    const walk = (dir: string, prefix = ''): string[] => fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (isHarnessArtifact(rel)) return [];
      return entry.isDirectory() ? walk(path.join(dir, entry.name), rel) : [rel];
    });
    const harnessArtifacts = () => fs.existsSync(path.join(workspace, '.ollama-agent')) ? ['.ollama-agent/'] : [];
    const tree = () => new Map(walk(workspace).map(rel => [rel, sha(path.join(workspace, rel))] as const));
    const diffTree = (before: Map<string, string>, after: Map<string, string>) => ({
      added: [...after.keys()].filter(rel => !before.has(rel)),
      removed: [...before.keys()].filter(rel => !after.has(rel)),
      modified: [...after.keys()].filter(rel => before.has(rel) && before.get(rel) !== after.get(rel)),
    });
    const treeBefore = tree();
    let treePrev = treeBefore;
    let copyRel: string | null = null;
    const env = await boot();
    const steps: Array<Record<string, unknown>> = [];
    const approvalTrace: Array<Record<string, unknown>> = [];
    try {
      const ui = newPanel(workspace, env.manager, 'event_forms.html');
      const panel = ui.panel as unknown as {
        handleUserMessage(text: string, mode: string, ids: string[], conversationId: string, model?: string): Promise<void>;
        resolveModeChange(conversationId: string, decision: 'continue' | 'stay'): Promise<void>;
        conversationId: string;
      };
      const lastAttemptId = async () => {
        const ledger = await env.client.getWorkspaceConversationLedger(ui.panel.workspaceIdentity);
        return { ledger, last: [...ledger.turns].reverse()[0] as { attemptId: string } | undefined, count: ledger.turns.length };
      };
      // Settles the newest attempt, resolving every Core approval exactly as the UI's Approve button does.
      const settle = async (turnsBefore: number, label: string, decision: 'approved' | 'rejected' = 'approved') => {
        const deadline = Date.now() + 25 * 60_000;
        let attemptId: string | undefined;
        while (Date.now() < deadline) {
          const { ledger, last, count } = await lastAttemptId();
          if (count > turnsBefore && last) {
            attemptId = last.attemptId;
            const attempt = await env.client.getAttempt(last.attemptId);
            if (['completed', 'failed', 'cancelled'].includes(attempt.status)) return { attempt, ledger };
            if (attempt.status === 'waiting_for_approval') {
              const snapshot = await env.client.listCapabilityActions(ledger.currentCoreConversationId as string);
              for (const action of snapshot.actions.filter(item => item.actionable)) {
                approvalTrace.push({ step: label, tool: action.toolName, arguments: action.arguments, decision, at: new Date().toISOString() });
                await env.client.resolveCapabilityApproval(action.approvalId, {
                  resolution: decision, attemptId: action.attemptId, expectedAttemptRevision: action.expectedAttemptRevision,
                  expectedAttemptStatus: action.expectedAttemptStatus, requestedActionDigest: action.requestedActionDigest, frozenContextHash: action.frozenContextHash,
                });
              }
            }
          }
          await new Promise(resolve => setTimeout(resolve, 1000));
        }
        throw new Error(`step ${label} did not settle (attempt ${attemptId ?? 'none'})`);
      };
      // Real execution evidence for an attempt: the governed tool invocations Core recorded (tool, status, exit code, arguments).
      const toolEvidence = (attemptId: string) => env.db.all<{ toolName: string; status: string; exitCode: number | null; argsSummary: string }>(
        'SELECT toolName, status, exitCode, argsSummary FROM tool_invocations WHERE attemptId = ? ORDER BY startedAt', [attemptId],
      );
      const toolTrace = (attemptId: string) => env.db.all<{ metadata: string }>(
        "SELECT metadata FROM runtime_events WHERE eventType = 'capability_tool_invocation_completed' AND json_extract(metadata, '$.attemptId') = ?", [attemptId],
      ).map(row => { const m = JSON.parse(row.metadata); return `${m.toolName}:${m.status}`; });
      // S7 harness fix: the answer for a step is the assistant message APPENDED BY THAT STEP (seq above the floor taken before
      // the prompt was sent). Taking "the latest assistant message in the conversation" returned the previous step's answer
      // whenever a step failed or produced no reply, which made a failed step look like it had answered.
      const seqFloor = async (ledger: { currentCoreConversationId: unknown }) => {
        const { messages } = await env.client.listMessages(ledger.currentCoreConversationId as string);
        return messages.reduce((max, message) => Math.max(max, message.seq ?? 0), 0);
      };
      // A fresh response must belong to the CURRENT attempt: an assistant message above the floor whose model invocation was
      // made by this attempt. Wording is deliberately not compared with earlier answers; identical text is still fresh.
      const answerOf = async (ledger: { currentCoreConversationId: unknown }, floor: number, attemptId: string) => {
        const { messages } = await env.client.listMessages(ledger.currentCoreConversationId as string);
        const owned = new Set(env.db.all<{ id: string }>('SELECT id FROM model_invocations WHERE attemptId = ?', [attemptId]).map(row => row.id));
        return [...messages].reverse().find(message => message.role === 'assistant' && (message.seq ?? 0) > floor
          && typeof message.modelInvocationId === 'string' && owned.has(message.modelInvocationId))?.content ?? '';
      };
      const convId = () => panel.conversationId;
      const prompts: Array<[string, string]> = [
        ['1', 'How does this app work?'],
        ['2', 'What functionalities are implemented?'],
        ['3', 'Where is data saved?'],
        ['4', 'Make a new copy of event_forms.html.'],
        ['5', 'Format, organize and refactor the copy without changing the original.'],
        ['6', 'Validate the refactored application.'],
        ['7', 'Summarize the changes and show me the resulting file.'],
      ];
      for (const [label, prompt] of prompts) {
        const started = Date.now();
        const { count: before, ledger: ledgerBefore } = await lastAttemptId();
        const floor = ledgerBefore.currentCoreConversationId ? await seqFloor(ledgerBefore) : 0;
        const floorConversation = ledgerBefore.currentCoreConversationId;
        const mode = Number(label) <= 3 ? 'chat' : (Number(label) === 4 ? 'chat' : 'agent');
        opened.length = 0;
        await panel.handleUserMessage(prompt, mode, [], convId(), MODEL);
        let escalation: string | null = null;
        const gate = ui.posted.find(message => message.type === 'modeChangeRequired' && message.text === prompt);
        if (gate) {
          escalation = `${String(gate.from)} -> ${String(gate.to)}: ${String(gate.prompt)}`;
          await panel.resolveModeChange(convId(), 'continue');
        }
        const { attempt, ledger } = await settle(before, label);
        // A conversation switch (e.g. mode escalation) starts a fresh message sequence, so the floor only applies within one.
        const answer = await answerOf(ledger, ledger.currentCoreConversationId === floorConversation ? floor : 0, attempt.id);
        const record = {
          step: label, prompt, mode: gate ? 'baat_kar -> saath_kar (user continued)' : (mode === 'chat' ? 'baat_kar' : 'saath_kar'), escalation,
          attemptId: attempt.id, status: attempt.status, failureReason: attempt.failureReason ?? null,
          tools: toolTrace(attempt.id), toolEvidence: toolEvidence(attempt.id), approvalsThisStep: approvalTrace.filter(item => item.step === label),
          originalSha256Now: sha(original), elapsedMs: Date.now() - started, answer,
        };
        steps.push(record);
        fs.mkdirSync(OUT, { recursive: true });
        fs.writeFileSync(path.join(OUT, 's7-transcript.json'), JSON.stringify({ model: MODEL, workspace: SOURCE_WORKSPACE, originalSha256: originalSha, steps, approvalTrace }, null, 2));

        // Strict per-step acceptance (the transcript is written first so a failed assertion still leaves evidence).
        const stepNo = Number(label);
        const treeNow = tree();
        const change = diffTree(treePrev, treeNow);
        treePrev = treeNow;
        expect(record.status, `step ${label} status (${record.failureReason ?? 'no failure reason'})`).toBe('completed');
        expect(record.answer.trim().length, `step ${label}: no assistant response belonging to this attempt (${attempt.id})`).toBeGreaterThan(0);
        expect(sha(original), `step ${label} modified the original`).toBe(originalSha);
        expect(change.removed, `step ${label} removed workspace files`).toEqual([]);
        if (stepNo <= 3 || stepNo === 7) {
          if (stepNo <= 3) {
            expect(record.tools, `step ${label} is read-only understanding`).toEqual([]);
            expect(record.approvalsThisStep).toHaveLength(0);
          }
          expect(change, `step ${label} must not change the workspace`).toEqual({ added: [], removed: [], modified: [] });
        }
        if (stepNo === 4) {
          expect(record.approvalsThisStep.length, 'copy must be approval-gated').toBeGreaterThan(0);
          expect(change.added.length, `copy must create exactly one new workspace file, got ${JSON.stringify(change.added)}`).toBe(1);
          expect(change.modified).toEqual([]);
          copyRel = change.added[0];
          expect(treeNow.get(copyRel), 'fresh copy is byte-identical to the original').toBe(originalSha);
        }
        if (stepNo === 5) {
          expect(record.approvalsThisStep.length, 'refactor must be approval-gated').toBeGreaterThan(0);
          expect(change.added, 'refactor must not create any other workspace file').toEqual([]);
          expect(change.modified, 'refactor must change only the copy').toEqual([copyRel]);
          // Changed file CONTENT, not the answer text: differs from the original, keeps its behaviour markers, still parses.
          const copyText = fs.readFileSync(path.join(workspace, copyRel as string), 'utf8');
          const originalText = fs.readFileSync(original, 'utf8');
          expect(copyText, 'the refactored copy must differ from the original').not.toBe(originalText);
          for (const marker of ['function guestSubmit', 'Enter a valid email', 'localStorage']) {
            if (originalText.includes(marker)) expect(copyText, `refactor lost "${marker}" from the original`).toContain(marker);
          }
          const vm = await import('node:vm');
          const scripts = [...copyText.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi)].map(match => match[1]).filter(code => code.trim());
          expect(scripts.length, 'refactored copy lost its inline scripts').toBeGreaterThan(0);
          scripts.forEach((code, index) => { expect(() => new vm.Script(code, { filename: `${copyRel}#script${index}` }), `inline script ${index} of the refactored copy has a syntax error`).not.toThrow(); });
        }
        if (stepNo === 6) {
          // Validation must be proven by a command Core actually ran, not by words in the answer.
          const ran = record.toolEvidence.filter(item => item.toolName === 'run_command' && item.status === 'succeeded' && item.exitCode !== null);
          expect(ran.length, `validation step ran no command (tool evidence: ${JSON.stringify(record.toolEvidence)})`).toBeGreaterThan(0);
          expect(change.added, 'validation must not leave extra files in the user workspace').toEqual([]);
          expect(change.modified, 'validation must not modify the refactored copy').toEqual([]);
        }
        if (stepNo === 7) expect(record.answer, 'final summary must name the delivered file').toContain(path.basename(copyRel ?? ''));
      }
      const finalChange = diffTree(treeBefore, tree());
      fs.writeFileSync(path.join(OUT, 's7-filesystem.json'), JSON.stringify({
        workspace, originalSha256Before: originalSha, originalSha256After: sha(original),
        userWorkspaceChanges: finalChange, harnessArtifacts: harnessArtifacts(),
      }, null, 2));
      expect(sha(original)).toBe(originalSha);
      expect(finalChange.added, 'exactly one new file may be created in the user workspace').toEqual([copyRel]);
      expect(finalChange.modified).toEqual([]);
      expect(finalChange.removed).toEqual([]);
      // Authority: every consequential tool that ran needed a resolved approval, and none was refused by the security kernel.
      const consequentialRan = steps.flatMap(step => (step.tools as string[]).filter(tool => /^(run_command|propose_file_change|propose_text_edit):succeeded$/.test(tool)));
      expect(consequentialRan.length, 'consequential tools that ran vs approvals granted').toBeLessThanOrEqual(approvalTrace.length);
      const denied = env.db.all<{ n: number }>("SELECT COUNT(*) AS n FROM tool_invocations WHERE status = 'failed' AND evidence LIKE '%SecurityKernel authorization denied%'")[0]?.n ?? 0;
      expect(denied, 'no consequential call may have been refused by the security kernel during an approved flow').toBe(0);
    } finally { await env.close(); }
  }, 90 * 60_000);
});
