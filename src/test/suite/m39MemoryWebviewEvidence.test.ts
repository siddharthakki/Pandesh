// @vitest-environment jsdom
//
// M39: drives the REAL production webview markup (media/chat.html) and the
// REAL production scripts (media/chat.js and the rest of chat.html's load
// chain) inside jsdom, exactly as `webviewApprovalReconciliation.test.ts`
// already does. No mock DOM and no stand-in renderer: the assertions below
// inspect the actual DOM the shipped webview produces for a governed memory
// approval card and for memory recall/impact/export evidence.
import { JSDOM } from 'jsdom';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { describe, expect, it } from 'vitest';

interface PostedMessage { type: string; [key: string]: unknown }

interface MountedWebview {
  window: JSDOM['window'];
  document: Document;
  posted: PostedMessage[];
  dispatch: (message: Record<string, unknown>) => void;
}

const CHAT_HTML_PATH = resolve(process.cwd(), 'media/chat.html');

const PRODUCTION_SCRIPT_FILES = [
  'chat.js',
  'chat-fixes.js',
  'chat-dashboard.js',
  'chat-operations.js',
  'chat-runtime-fixes.js',
  'chat-autonomous.js',
  'chat-sidebar-ui.js',
];

function mountWebview(): MountedWebview {
  const rawHtml = readFileSync(CHAT_HTML_PATH, 'utf8');
  const scripts = PRODUCTION_SCRIPT_FILES.map(file => readFileSync(resolve(process.cwd(), 'media', file), 'utf8'));

  const templated = rawHtml
    .replace(/{{cspSource}}/g, "'self'")
    .replace(/{{nonce}}/g, 'test-nonce')
    .replace(/{{cssUri}}/g, 'chat.css')
    .replace(/{{jsUri}}/g, 'chat.js')
    .replace(/{{modelName}}/g, 'test-model');

  const scriptsStart = templated.indexOf('<script nonce="test-nonce">');
  if (scriptsStart === -1) throw new Error('Could not locate chat.html bootstrap script block.');
  const head = templated.slice(0, scriptsStart);
  const inlineScripts = scripts.map(js => `<script nonce="test-nonce">${js}</script>`).join('\n    ');

  const html = `${head}
    <script nonce="test-nonce">
      (() => {
        const api = window.acquireVsCodeApi();
        Object.defineProperty(window, '__ollamaAgentVsCodeApi', { value: api, configurable: false, enumerable: false, writable: false });
      })();
    </script>
    ${inlineScripts}
  </body>
  </html>`;

  const posted: PostedMessage[] = [];
  const state: { value: Record<string, unknown> } = { value: {} };
  const dom = new JSDOM(html, {
    runScripts: 'dangerously',
    url: 'https://example-webview.invalid/',
    beforeParse(window) {
      (window as unknown as { acquireVsCodeApi: () => unknown }).acquireVsCodeApi = () => ({
        postMessage: (msg: PostedMessage) => { posted.push(msg); },
        getState: () => state.value,
        setState: (next: Record<string, unknown>) => { state.value = next; },
      });
    },
  });

  return {
    window: dom.window,
    document: dom.window.document,
    posted,
    dispatch: message => { dom.window.dispatchEvent(new dom.window.MessageEvent('message', { data: message })); },
  };
}

const REMEMBER_ARGUMENTS = {
  memoryType: 'semantic',
  scopeType: 'project',
  scopeId: 'Atlas',
  subject: 'authoritative memory store',
  predicate: 'is',
  value: 'SQLite',
  sensitivity: 'internal',
  affectedEntities: [
    { type: 'repository_file', canonicalKey: 'src/storage.ts' },
    { type: 'github_issue', canonicalKey: 'fixture/repository#39' },
    { type: 'product_record', canonicalKey: 'proj_atlas' },
  ],
};

function restoreMemoryApprovalCard(w: MountedWebview, overrides: Record<string, unknown> = {}): void {
  w.dispatch({
    type: 'restoreCapabilityApprovalCard',
    approvalId: 'appr_m39_1',
    attemptId: 'att_m39_1',
    toolName: 'memory_remember',
    description: REMEMBER_ARGUMENTS,
    expectedAttemptRevision: 3,
    expectedAttemptStatus: 'waiting_for_approval',
    requestedActionDigest: 'digest-m39-1',
    frozenContextHash: 'context-m39-1',
    resolved: false,
    ...overrides,
  });
}

const RECALL_RESULT = {
  output: JSON.stringify({
    recalledAt: '2026-07-27T10:00:00.000Z',
    entries: [
      {
        kind: 'unresolved_contradiction',
        memory: {
          id: 'mem_sqlite', subject: 'authoritative memory store', predicate: 'is', displayValue: 'SQLite',
          scopeType: 'project', scopeId: 'Atlas', sensitivity: 'internal', state: 'active', createdAt: '2026-07-27T09:00:00.000Z',
        },
        evidence: [{ id: 'mevi_1', sourceType: 'conversation_message', sourceMessageId: 'msg_1', sourceContentSha256: 'a'.repeat(64), createdAt: '2026-07-27T09:00:00.000Z' }],
        contradictions: [{ id: 'mcon_1', state: 'unresolved', earlierMemoryId: 'mem_sqlite', laterMemoryId: 'mem_postgres' }],
      },
      {
        kind: 'unresolved_contradiction',
        memory: {
          id: 'mem_postgres', subject: 'authoritative memory store', predicate: 'is', displayValue: 'PostgreSQL',
          scopeType: 'project', scopeId: 'Atlas', sensitivity: 'internal', state: 'active', createdAt: '2026-07-27T09:30:00.000Z',
        },
        evidence: [{ id: 'mevi_2', sourceType: 'conversation_message', sourceMessageId: 'msg_2', sourceContentSha256: 'b'.repeat(64), createdAt: '2026-07-27T09:30:00.000Z' }],
        contradictions: [{ id: 'mcon_1', state: 'unresolved', earlierMemoryId: 'mem_sqlite', laterMemoryId: 'mem_postgres' }],
      },
    ],
  }),
  resultCategory: 'memory_recall_succeeded',
};

describe('M39 production webview memory rendering (real chat.html + real chat.js)', () => {
  it('shows the exact proposed scope, sensitivity, fact and affected entities before approval, with exactly one actionable approval', () => {
    const w = mountWebview();
    restoreMemoryApprovalCard(w);

    const cards = w.document.querySelectorAll('.capability-approval-card');
    expect(cards).toHaveLength(1);
    const card = cards[0];
    expect(card.querySelector('strong')?.textContent).toBe('Remember this decision?');

    const proposal = card.querySelector('.memory-proposal') as HTMLElement;
    expect(proposal).toBeTruthy();
    const field = (name: string) => proposal.querySelector(`.memory-field[data-field="${name}"] .memory-field-value`)?.textContent;
    expect(field('scope')).toBe('project:Atlas');
    expect(field('sensitivity')).toBe('internal');
    expect(field('memoryType')).toBe('semantic');
    expect(field('fact')).toBe('authoritative memory store — is — SQLite');
    expect(field('affectedEntityCount')).toBe('3');
    const entityTypes = [...proposal.querySelectorAll('.memory-affected-entity')].map(node => (node as HTMLElement).dataset.entityType);
    expect(entityTypes).toEqual(['repository_file', 'github_issue', 'product_record']);

    // Exactly one actionable approval — one Approve and one Reject button.
    const buttons = [...card.querySelectorAll('.approval-buttons button')].map(node => node.textContent);
    expect(buttons).toEqual(['Approve', 'Reject']);
  });

  it('a duplicate restore for the same approval never creates a second card or a second set of actions', () => {
    const w = mountWebview();
    restoreMemoryApprovalCard(w);
    restoreMemoryApprovalCard(w);
    restoreMemoryApprovalCard(w);
    expect(w.document.querySelectorAll('.capability-approval-card')).toHaveLength(1);
    expect(w.document.querySelectorAll('.approval-buttons button')).toHaveLength(2);
    expect(w.document.querySelectorAll('.memory-proposal')).toHaveLength(1);
  });

  it('renders one exact-ID Saath Kar workspace mutation approval with visible Approve and Reject controls', () => {
    const w = mountWebview();
    restoreMemoryApprovalCard(w, {
      approvalId: 'appr_saath_workspace_1',
      attemptId: 'att_saath_anchor_1',
      toolName: 'run_command',
      description: { command: 'create note-saath.txt containing Hello from Saath Kar' },
      requestedActionDigest: 'digest-saath-workspace-1',
      frozenContextHash: 'context-saath-workspace-1',
    });

    const card = w.document.querySelector('#capability-approval-appr_saath_workspace_1') as HTMLElement;
    expect(card).toBeTruthy();
    expect(card.textContent).toContain('run_command');
    expect(card.textContent).toContain('note-saath.txt');
    const buttons = [...card.querySelectorAll('button')] as HTMLButtonElement[];
    expect(buttons.map(button => button.textContent)).toEqual(['Approve', 'Reject']);
    expect(buttons.map(button => button.dataset.approvalResponse)).toEqual(['approved', 'rejected']);
    const postedBeforeDecision = w.posted.length;
    buttons[1].click();

    expect(w.posted).toHaveLength(postedBeforeDecision + 1);
    expect(w.posted.at(-1)).toMatchObject({
      type: 'capabilityApprovalRestoredResponse',
      approvalId: 'appr_saath_workspace_1',
      attemptId: 'att_saath_anchor_1',
      toolName: 'run_command',
      requestedActionDigest: 'digest-saath-workspace-1',
      frozenContextHash: 'context-saath-workspace-1',
      resolution: 'rejected',
    });
  });

  it('keeps a second exact-write approval scrolled into the active viewport after composer layout growth', async () => {
    const w = mountWebview();
    const messages = w.document.getElementById('messages') as HTMLElement;
    let scrollHeight = 800;
    let scrollTop = 0;
    Object.defineProperty(messages, 'scrollHeight', { configurable: true, get: () => scrollHeight });
    Object.defineProperty(messages, 'scrollTop', {
      configurable: true,
      get: () => scrollTop,
      set: value => { scrollTop = Number(value); },
    });
    let scrolledTargetId = '';
    (w.window.HTMLElement.prototype as unknown as { scrollIntoView(options?: unknown): void }).scrollIntoView = function () {
      scrolledTargetId = (this as HTMLElement).id;
    };

    restoreMemoryApprovalCard(w, {
      approvalId: 'appr_saath_write_2',
      attemptId: 'att_saath_anchor_2',
      toolName: 'write_file',
      description: { path: 'note-saath.txt', content: 'Hello from Saath Kar' },
      requestedActionDigest: 'digest-saath-write-2',
      frozenContextHash: 'context-saath-write-2',
    });
    expect(scrollTop).toBe(800);
    expect(scrolledTargetId).toBe('capability-approval-appr_saath_write_2');
    expect(messages.style.scrollBehavior).toBe('auto');

    // Mirrors the everyday phase/recommendation composer growing after the
    // approval message is appended. The deferred production scroll must use
    // the new height, not leave the actions clipped at the old bottom.
    scrollHeight = 1200;
    await new Promise(resolve => w.window.setTimeout(resolve, 130));
    expect(scrollTop).toBe(1200);
    expect(messages.style.scrollBehavior).toBe('');

    const card = w.document.getElementById('capability-approval-appr_saath_write_2') as HTMLElement;
    expect([...card.querySelectorAll('button')].map(button => ({
      label: button.textContent,
      response: (button as HTMLButtonElement).dataset.approvalResponse,
    }))).toEqual([
      { label: 'Approve', response: 'approved' },
      { label: 'Reject', response: 'rejected' },
    ]);
  });

  it('a resolved restore disables the card and leaves no actionable memory approval', () => {
    const w = mountWebview();
    restoreMemoryApprovalCard(w);
    restoreMemoryApprovalCard(w, { resolved: true, outcome: 'succeeded' });
    const card = w.document.querySelector('.capability-approval-card') as HTMLElement;
    expect(card.classList.contains('resolved')).toBe(true);
    expect(card.querySelector('.approval-buttons')).toBeNull();
    expect(card.querySelector('strong')?.textContent).toBe('Governed action — completed');
  });

  it('renders recalled facts with evidence, scope, sensitivity, timestamp and unresolved contradictions', () => {
    const w = mountWebview();
    w.dispatch({ type: 'toolStart', toolName: 'memory_recall', args: { scopeType: 'project', scopeId: 'Atlas' } });
    w.dispatch({ type: 'toolResult', toolName: 'memory_recall', ok: true, result: RECALL_RESULT });

    const block = w.document.querySelector('.memory-evidence[data-tool-name="memory_recall"]') as HTMLElement;
    expect(block).toBeTruthy();
    expect(block.dataset.entryCount).toBe('2');
    const facts = [...block.querySelectorAll('.memory-fact')] as HTMLElement[];
    expect(facts.map(node => node.dataset.memoryId)).toEqual(['mem_sqlite', 'mem_postgres']);
    expect(facts[0].textContent).toContain('authoritative memory store — is — SQLite');
    expect(facts[1].textContent).toContain('authoritative memory store — is — PostgreSQL');
    for (const fact of facts) {
      expect(fact.textContent).toContain('project:Atlas');
      expect(fact.textContent).toContain('internal');
      expect(fact.querySelector('.memory-evidence-link')).toBeTruthy();
    }
    expect(facts[0].querySelector('.memory-evidence-link')?.getAttribute('data-source-hash')).toBe('a'.repeat(64));
    // Both evidence chains and the unresolved contradiction are visible.
    expect(block.querySelectorAll('.memory-evidence-link')).toHaveLength(2);
    expect(block.querySelectorAll('.memory-contradiction.unresolved')).toHaveLength(2);
  });

  it('renders impact results grouped with their relationship path and evidence count', () => {
    const w = mountWebview();
    w.dispatch({
      type: 'toolResult',
      toolName: 'memory_impact',
      ok: true,
      result: {
        output: JSON.stringify({
          originEntityId: 'kent_decision',
          entries: [
            { entity: { entityType: 'repository_file', canonicalKey: 'src/storage.ts' }, depth: 1, path: [{ relationshipType: 'affects' }], evidenceIds: ['mevi_1'] },
            { entity: { entityType: 'github_issue', canonicalKey: 'fixture/repository#39' }, depth: 1, path: [{ relationshipType: 'affects' }], evidenceIds: ['mevi_1'] },
            { entity: { entityType: 'product_record', canonicalKey: 'proj_atlas' }, depth: 1, path: [{ relationshipType: 'affects' }], evidenceIds: ['mevi_1'] },
          ],
        }),
      },
    });
    const block = w.document.querySelector('.memory-evidence[data-tool-name="memory_impact"]') as HTMLElement;
    expect(block).toBeTruthy();
    const entities = [...block.querySelectorAll('.memory-impact-entity')] as HTMLElement[];
    expect(entities.map(node => node.dataset.entityType)).toEqual(['repository_file', 'github_issue', 'product_record']);
    expect(entities.every(node => Number(node.dataset.evidenceCount) > 0)).toBe(true);
    expect(entities[0].textContent).toContain('affects');
  });

  it('renders an auditable export payload with its schema version', () => {
    const w = mountWebview();
    w.dispatch({
      type: 'toolResult',
      toolName: 'memory_export',
      ok: true,
      result: { output: JSON.stringify({ schemaVersion: 1, provenanceVersion: 1, memoryCount: 1, memories: [{ id: 'mem_sqlite', evidence: [{ sourceContentSha256: 'a'.repeat(64) }] }] }) },
    });
    const block = w.document.querySelector('.memory-evidence[data-tool-name="memory_export"]') as HTMLElement;
    expect(block).toBeTruthy();
    expect(block.dataset.schemaVersion).toBe('1');
    expect(block.dataset.memoryCount).toBe('1');
    expect(block.querySelector('.memory-export-json')?.textContent).toContain('mem_sqlite');
  });

  it('never renders a memory-evidence block for a non-memory tool or a failed memory call', () => {
    const w = mountWebview();
    w.dispatch({ type: 'toolResult', toolName: 'read_file', ok: true, result: { output: '{"entries":[]}' } });
    w.dispatch({ type: 'toolResult', toolName: 'memory_recall', ok: false, error: 'boom' });
    expect(w.document.querySelectorAll('.memory-evidence')).toHaveLength(0);
  });
});
