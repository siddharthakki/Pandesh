/**
 * M39 — deterministic packaged-acceptance fixtures for memory and knowledge
 * intelligence.
 *
 * Same shape and discipline as `m38ScriptedOllamaFixture.mjs`: an
 * Ollama-compatible HTTP fixture whose every response is a pure function of
 * the request body, so the packaged scenario's assertions never depend on
 * live-model judgement. Each Saath Kar turn is selected by the exact user
 * prompt the scenario sends; the tool call for that turn is then chosen from
 * how many `role: 'tool'` messages Core has already appended (one per
 * completed tool call — see `core/runtime/executor.ts`).
 *
 * Runtime identifiers (memory ids, contradiction ids) are never injected by
 * the harness: the fixture reads them out of the read-only `memory_recall`
 * tool result Core itself fed back into the conversation, which is exactly
 * how a real model would obtain them.
 */
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

export const M39_FIXTURE_MODEL = 'm39-memory-fixture';

export const M39_PROJECT = 'Atlas';
export const M39_SUBJECT = 'authoritative memory store';
export const M39_PREDICATE = 'is';
export const M39_FIRST_VALUE = 'SQLite';
export const M39_SECOND_VALUE = 'PostgreSQL';
export const M39_REPOSITORY_FILE = 'src/storage.ts';
export const M39_GITHUB_ISSUE = 'fixture/repository#39';
/** A fixture-only credential shape. Never a real secret; used to prove that
 * an unauthorized restricted memory writes nothing and leaks nothing. */
export const M39_FIXTURE_TOKEN = 'ghp_M39FIXTUREtokenAAAAAAAAAAAAAAAAAAAA';

export const M39_STORAGE_FILE_CONTENT = `// Atlas storage adapter (M39 packaged acceptance fixture).
export interface StorageAdapter {
  read(key: string): Promise<string | null>;
  write(key: string, value: string): Promise<void>;
}
`;

/** Every prompt the packaged scenario sends, and the turn each one selects. */
export const M39_PROMPTS = Object.freeze({
  rememberSqlite: `For project ${M39_PROJECT}, use ${M39_FIRST_VALUE} as the authoritative memory store. Please remember this decision.`,
  recallFirst: `What storage decision was made for project ${M39_PROJECT}?`,
  rememberPostgres: `For project ${M39_PROJECT}, use ${M39_SECOND_VALUE} as the authoritative memory store. Please remember this decision.`,
  recallBoth: `Ask again: what storage decision is recorded for project ${M39_PROJECT}?`,
  resolveContradiction: `Resolve the contradiction for project ${M39_PROJECT} preferring the later decision.`,
  impact: `What does the current ${M39_PROJECT} storage decision affect?`,
  export: `Export the auditable memory record for project ${M39_PROJECT}.`,
  forget: `Forget the current authoritative ${M39_PROJECT} storage decision.`,
  recallAfterForget: `Which storage decisions are still active for project ${M39_PROJECT}?`,
  redispatchRemember: `Retry: for project ${M39_PROJECT}, use ${M39_FIRST_VALUE} as the authoritative memory store. Please remember this decision.`,
  restrictedSecret: `Remember the ${M39_PROJECT} deploy credential ${M39_FIXTURE_TOKEN} as a restricted memory.`,
});

export const M39_ANSWERS = Object.freeze({
  remembered: 'M39-ANSWER: the decision is now durably remembered with its evidence.',
  recalled: 'M39-ANSWER: the recalled decision is shown above with its evidence.',
  resolved: 'M39-ANSWER: the contradiction is resolved by explicit policy; both records are preserved.',
  impact: 'M39-ANSWER: the affected files, issues and product records are listed above.',
  exported: 'M39-ANSWER: the auditable memory export is shown above.',
  forgotten: 'M39-ANSWER: the memory is forgotten and is no longer active.',
  denied: 'M39-ANSWER: nothing was remembered because the action was not approved.',
});

/** Builds the disposable repository the scenario points VS Code at. */
export function writeM39Repository(root) {
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  fs.writeFileSync(path.join(root, M39_REPOSITORY_FILE), M39_STORAGE_FILE_CONTENT, 'utf8');
  fs.writeFileSync(
    path.join(root, 'README.md'),
    `# ${M39_PROJECT}\n\nDisposable M39 packaged-acceptance workspace.\nGoverned issue reference: ${M39_GITHUB_ISSUE}\n`,
    'utf8',
  );
  return { storageFile: path.join(root, M39_REPOSITORY_FILE) };
}

function lastUserPrompt(messages) {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]?.role === 'user') return String(messages[index].content ?? '');
  }
  return '';
}

/**
 * Core wraps every tool result as `[<toolName>] <formatted output>`, where the
 * governed-capability formatting also prefixes an `exit=<code>` line (see
 * `RuntimeExecutor.formatGovernedResult`). Parse the JSON body from the first
 * `{` rather than assuming a fixed prefix.
 */
export function toolResultPayload(message, toolName) {
  const text = String(message?.content ?? '');
  if (!text.startsWith(`[${toolName}]`)) return null;
  const start = text.indexOf('{');
  if (start === -1) return null;
  try {
    return JSON.parse(text.slice(start));
  } catch {
    return null;
  }
}

function affectedEntities(productRecordKey) {
  return [
    { type: 'repository_file', canonicalKey: M39_REPOSITORY_FILE, relationship: 'affects' },
    { type: 'github_issue', canonicalKey: M39_GITHUB_ISSUE, relationship: 'affects' },
    { type: 'product_record', canonicalKey: productRecordKey, relationship: 'affects' },
  ];
}

function rememberCall(value, productRecordKey) {
  return {
    name: 'memory_remember',
    arguments: {
      memoryType: 'semantic',
      scopeType: 'project',
      scopeId: M39_PROJECT,
      subject: M39_SUBJECT,
      predicate: M39_PREDICATE,
      value,
      sensitivity: 'internal',
      affectedEntities: affectedEntities(productRecordKey),
    },
  };
}

const RECALL_CALL = {
  name: 'memory_recall',
  arguments: { scopeType: 'project', scopeId: M39_PROJECT },
};

/**
 * Pure decision function. Returns `{ content, toolCall }` or `{ error }` —
 * never a guess. Exported so it is unit-testable without HTTP.
 */
export function computeM39Response(body, { productRecordKey = M39_PROJECT } = {}) {
  const messages = Array.isArray(body?.messages) ? body.messages : [];
  const toolMessages = messages.filter((message) => message?.role === 'tool');
  const n = toolMessages.length;
  const prompt = lastUserPrompt(messages);
  if (!prompt) return { error: '/api/chat request carried no user message' };

  const isPrompt = (key) => prompt.includes(M39_PROMPTS[key]);

  // --- single-tool turns -------------------------------------------------
  if (isPrompt('rememberSqlite') || isPrompt('redispatchRemember')) {
    if (n === 0) return { content: 'Proposing a durable memory write.', toolCall: rememberCall(M39_FIRST_VALUE, productRecordKey) };
    if (n === 1) return { content: M39_ANSWERS.remembered, toolCall: null };
    return { error: `unexpected tool turn ${n} for a remember prompt` };
  }
  if (isPrompt('rememberPostgres')) {
    if (n === 0) return { content: 'Proposing a durable memory write.', toolCall: rememberCall(M39_SECOND_VALUE, productRecordKey) };
    if (n === 1) return { content: M39_ANSWERS.remembered, toolCall: null };
    return { error: `unexpected tool turn ${n} for the PostgreSQL remember prompt` };
  }
  if (isPrompt('recallFirst') || isPrompt('recallBoth') || isPrompt('recallAfterForget')) {
    if (n === 0) return { content: 'Recalling durable memory.', toolCall: RECALL_CALL };
    if (n === 1) return { content: M39_ANSWERS.recalled, toolCall: null };
    return { error: `unexpected tool turn ${n} for a recall prompt` };
  }
  if (isPrompt('export')) {
    if (n === 0) return { content: 'Exporting the auditable memory record.', toolCall: { name: 'memory_export', arguments: { scopeType: 'project', scopeId: M39_PROJECT } } };
    if (n === 1) return { content: M39_ANSWERS.exported, toolCall: null };
    return { error: `unexpected tool turn ${n} for the export prompt` };
  }
  if (isPrompt('restrictedSecret')) {
    if (n === 0) {
      return {
        content: 'Proposing a restricted memory write.',
        toolCall: {
          name: 'memory_remember',
          arguments: {
            memoryType: 'semantic', scopeType: 'project', scopeId: M39_PROJECT,
            subject: 'deploy credential', predicate: 'is',
            value: `deploy with ${M39_FIXTURE_TOKEN}`, sensitivity: 'restricted',
          },
        },
      };
    }
    if (n === 1) return { content: M39_ANSWERS.denied, toolCall: null };
    return { error: `unexpected tool turn ${n} for the restricted prompt` };
  }

  // --- recall-then-act turns --------------------------------------------
  // The runtime id is read out of Core's own recall result, exactly as a real
  // model would — never injected by the harness.
  if (isPrompt('resolveContradiction')) {
    if (n === 0) return { content: 'Reading the current memory state first.', toolCall: RECALL_CALL };
    if (n === 1) {
      const recall = toolResultPayload(toolMessages[0], 'memory_recall');
      const contradictionId = recall?.entries
        ?.flatMap((entry) => entry.contradictions ?? [])
        .find((contradiction) => contradiction.state === 'unresolved')?.id;
      if (!contradictionId) return { error: `no unresolved contradiction found in the recall result: ${String(toolMessages[0]?.content ?? '').slice(0, 300)}` };
      return {
        content: 'Resolving the contradiction with an explicit policy.',
        toolCall: { name: 'memory_resolve_contradiction', arguments: { contradictionId, policy: 'prefer_later' } },
      };
    }
    if (n === 2) return { content: M39_ANSWERS.resolved, toolCall: null };
    return { error: `unexpected tool turn ${n} for the resolve prompt` };
  }
  if (isPrompt('impact')) {
    if (n === 0) return { content: 'Reading the current memory state first.', toolCall: RECALL_CALL };
    if (n === 1) {
      const recall = toolResultPayload(toolMessages[0], 'memory_recall');
      const memoryId = recall?.entries?.find((entry) => entry.memory?.state === 'active')?.memory?.id;
      if (!memoryId) return { error: `no active memory found in the recall result: ${String(toolMessages[0]?.content ?? '').slice(0, 300)}` };
      return { content: 'Analyzing what this decision affects.', toolCall: { name: 'memory_impact', arguments: { memoryId } } };
    }
    if (n === 2) return { content: M39_ANSWERS.impact, toolCall: null };
    return { error: `unexpected tool turn ${n} for the impact prompt` };
  }
  if (isPrompt('forget')) {
    if (n === 0) return { content: 'Reading the current memory state first.', toolCall: RECALL_CALL };
    if (n === 1) {
      const recall = toolResultPayload(toolMessages[0], 'memory_recall');
      const memoryId = recall?.entries?.find((entry) => entry.memory?.state === 'active')?.memory?.id;
      if (!memoryId) return { error: `no active memory found in the recall result: ${String(toolMessages[0]?.content ?? '').slice(0, 300)}` };
      return { content: 'Proposing a governed forget.', toolCall: { name: 'memory_forget', arguments: { memoryId } } };
    }
    if (n === 2) return { content: M39_ANSWERS.forgotten, toolCall: null };
    return { error: `unexpected tool turn ${n} for the forget prompt` };
  }

  return { error: `unrecognized M39 prompt: ${prompt.slice(0, 160)}` };
}

export async function startDeterministicM39MemoryFixture({ model = M39_FIXTURE_MODEL, logFilePath, productRecordKey } = {}) {
  const requestLog = [];
  let closedAt = null;
  let currentProductRecordKey = productRecordKey ?? M39_PROJECT;

  function appendLog(entry) {
    requestLog.push(entry);
    if (logFilePath) {
      try { fs.appendFileSync(logFilePath, `${JSON.stringify(entry)}\n`, 'utf8'); } catch { /* evidence logging is best-effort */ }
    }
  }

  const server = http.createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const rawBody = Buffer.concat(chunks).toString('utf8');

    if (request.method === 'GET' && request.url === '/health') {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ ready: true, requests: requestLog.length }));
      return;
    }
    if (request.method === 'GET' && request.url?.startsWith('/api/tags')) {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ models: [{ name: model, model }] }));
      return;
    }
    if (request.method === 'POST' && request.url?.startsWith('/api/chat')) {
      let body = null;
      try { body = rawBody ? JSON.parse(rawBody) : null; } catch {
        appendLog({ capturedAt: new Date().toISOString(), error: 'request body was not valid JSON' });
        response.writeHead(400, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ error: 'invalid_request' }));
        return;
      }
      const outcome = computeM39Response(body, { productRecordKey: currentProductRecordKey });
      appendLog({
        capturedAt: new Date().toISOString(),
        toolMessageCount: Array.isArray(body?.messages) ? body.messages.filter((m) => m?.role === 'tool').length : 0,
        prompt: lastUserPrompt(Array.isArray(body?.messages) ? body.messages : []).slice(0, 160),
        toolCall: outcome.toolCall?.name ?? null,
        outcomeError: outcome.error ?? null,
      });
      if (outcome.error) {
        response.writeHead(409, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ error: 'unexpected_m39_sequence', detail: outcome.error }));
        return;
      }
      response.writeHead(200, { 'content-type': 'application/x-ndjson' });
      response.end(`${JSON.stringify({
        model,
        message: {
          role: 'assistant',
          content: outcome.content,
          ...(outcome.toolCall ? { tool_calls: [{ function: { name: outcome.toolCall.name, arguments: outcome.toolCall.arguments } }] } : {}),
        },
        done: true,
        prompt_eval_count: 1,
        eval_count: 1,
      })}\n`);
      return;
    }

    response.writeHead(404, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ error: 'not_found' }));
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('deterministic M39 memory fixture did not bind a TCP port');

  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    model,
    requestLog,
    /** The Core product record the scenario resolved through real product UI. */
    setProductRecordKey: (key) => { currentProductRecordKey = key; },
    violations: () => requestLog.filter((entry) => entry.outcomeError).map((entry) => entry.outcomeError),
    snapshot: () => ({
      chatRequests: requestLog.length,
      violations: requestLog.filter((entry) => entry.outcomeError).length,
      toolCalls: requestLog.filter((entry) => entry.toolCall).map((entry) => entry.toolCall),
      closedAt,
    }),
    close: () => new Promise((resolve) => {
      server.closeAllConnections?.();
      server.close(() => { closedAt = new Date().toISOString(); resolve(); });
    }),
  };
}

/** Explicit model-role settings so AgentPanel's real model-selection resolves
 * to this fixture model for every role (mirrors m38's fixtureModelSettings). */
export function m39FixtureModelSettings(ollamaBaseUrl) {
  return {
    'ollama-agent.apiBase': ollamaBaseUrl,
    'ollama-agent.model': M39_FIXTURE_MODEL,
    'ollama-agent.chatModel': M39_FIXTURE_MODEL,
    'ollama-agent.agentModel': M39_FIXTURE_MODEL,
    'ollama-agent.codingModel': M39_FIXTURE_MODEL,
    'ollama-agent.editModel': M39_FIXTURE_MODEL,
    'ollama-agent.reviewerModel': M39_FIXTURE_MODEL,
    'ollama-agent.codingFallbackModel': M39_FIXTURE_MODEL,
  };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const fixture = await startDeterministicM39MemoryFixture({ logFilePath: process.env.M39_FIXTURE_LOG_PATH });
  // eslint-disable-next-line no-console
  console.log(`[m39-memory-fixture] listening on ${fixture.baseUrl}`);
  const shutdown = async () => { await fixture.close(); process.exit(0); };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}
