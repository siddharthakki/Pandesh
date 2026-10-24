import * as fs from 'node:fs';
import * as http from 'node:http';
import * as path from 'node:path';

// Use registry-known capable identities so the acceptance transport exercises
// production selection policy instead of relying on unknown-model inference.
// The fixture endpoint still supplies all output deterministically.
export const M34_FIXTURE_MODEL = 'qwen3-coder:30b';
export const M34_STRONG_FIXTURE_MODEL = 'qwen2.5-coder:32b';
export const M34_RECOVERY_MARKER = '[M34_RECOVERY]';
export const M34_REPAIR_MARKER = '[M34_REPAIR]';
export const M34_RETRY_MARKER = '[M34_RETRY]';

/**
 * Keep packaged real-model acceptance explicit and aligned with the same role
 * configuration the product uses for capability-aware selection. In
 * particular, an autocomplete-only model must never be made to look like a
 * capable chat or repository model merely to make dogfood faster.
 */
export function realModelRoleSettings(chatModel, codingModel) {
  return Object.freeze({
    'ollama-agent.model': chatModel,
    'ollama-agent.chatModel': chatModel,
    'ollama-agent.agentModel': codingModel,
    'ollama-agent.codingModel': codingModel,
    'ollama-agent.editModel': codingModel,
    'ollama-agent.reviewerModel': codingModel,
    'ollama-agent.codingFallbackModel': chatModel,
  });
}

function writeFile(root, relativePath, content) {
  const destination = path.join(root, ...relativePath.split('/'));
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.writeFileSync(destination, content, 'utf8');
}

/**
 * A small real repository defect for the stochastic quality scenario. The
 * baseline test intentionally fails until parsePort rejects mixed numeric
 * input such as "8080oops". Git initialization remains the runner's job.
 */
export function writeM34RealworkRepository(root) {
  writeFile(root, 'package.json', `${JSON.stringify({
    name: 'm34-realwork-fixture',
    private: true,
    type: 'module',
    scripts: { test: 'node --test' },
  }, null, 2)}\n`);
  writeFile(root, 'src/parsePort.js', [
    'export function parsePort(value) {',
    '  const parsed = Number.parseInt(value, 10);',
    "  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) throw new Error('invalid port');",
    '  return parsed;',
    '}',
    '',
  ].join('\n'));
  writeFile(root, 'test/parsePort.test.js', [
    "import assert from 'node:assert/strict';",
    "import test from 'node:test';",
    "import { parsePort } from '../src/parsePort.js';",
    '',
    "test('accepts a valid port', () => assert.equal(parsePort('8080'), 8080));",
    "test('rejects mixed numeric input', () => assert.throws(() => parsePort('8080oops'), /invalid port/));",
    "test('rejects values outside the TCP range', () => assert.throws(() => parsePort('70000'), /invalid port/));",
    '',
  ].join('\n'));
  return Object.freeze({
    task: 'Fix parsePort so it accepts only a complete decimal port number, then run the tests.',
    intendedFiles: Object.freeze(['src/parsePort.js']),
    validationCommand: 'npm test',
  });
}

/** Baseline passes; the fixture model's first proposal breaks the assertion. */
export function writeM34RepairRepository(root) {
  writeFile(root, 'package.json', `${JSON.stringify({
    name: 'm34-repair-fixture',
    private: true,
    type: 'module',
    scripts: { test: 'node --test' },
  }, null, 2)}\n`);
  writeFile(root, 'src/formatGreeting.js', [
    'export function formatGreeting(name) {',
    "  return `Hello, ${String(name).trim()}!`;",
    '}',
    '',
  ].join('\n'));
  writeFile(root, 'test/formatGreeting.test.js', [
    "import assert from 'node:assert/strict';",
    "import test from 'node:test';",
    "import { formatGreeting } from '../src/formatGreeting.js';",
    '',
    "test('trims the name and preserves punctuation', () => {",
    "  assert.equal(formatGreeting('  Panda  '), 'Hello, Panda!');",
    '});',
    '',
  ].join('\n'));
  return Object.freeze({
    task: `Refactor formatGreeting without changing its tested behavior. ${M34_REPAIR_MARKER}`,
    intendedFiles: Object.freeze(['src/formatGreeting.js']),
    validationCommand: 'npm test',
  });
}

function proposal({ summary, content }) {
  return JSON.stringify({
    version: 1,
    taskSummary: summary,
    operations: [{
      type: 'replace',
      path: 'src/formatGreeting.js',
      reason: 'M34 deterministic validation-repair fixture',
      content,
    }],
    validationCommands: [{ kind: 'npm-test' }],
    warnings: [],
    status: 'proposed',
  });
}

function recoveryResponse(callNumber) {
  if (callNumber === 1) {
    return {
      role: 'assistant',
      content: '',
      tool_calls: [{
        function: {
          name: 'read_file',
          arguments: { path: 'C:\\invented\\old-workspace\\src\\recovery-target.ts' },
        },
      }],
    };
  }
  if (callNumber === 2) {
    return {
      role: 'assistant',
      content: '',
      tool_calls: [{ function: { name: 'read_file', arguments: { path: '../outside/missing.ts' } } }],
    };
  }
  if (callNumber === 3) {
    return {
      role: 'assistant',
      content: '',
      tool_calls: [{ function: { name: 'read_file', arguments: { path: '..\\outside\\missing.ts' } } }],
    };
  }
  return {
    role: 'assistant',
    content: 'The repeated out-of-root path was unsafe. I changed strategy and used the corrected repository evidence.',
  };
}

function fixtureResponse(body, scenarioCallNumber) {
  const messages = Array.isArray(body?.messages) ? body.messages : [];
  const joined = messages.map((message) => String(message?.content ?? '')).join('\n');
  if (joined.includes(M34_RECOVERY_MARKER)) return recoveryResponse(scenarioCallNumber);

  const stage = /Stage:\s*([^\n]+)/i.exec(joined)?.[1]?.trim().toLowerCase();
  if (stage === 'repository-analyst' || stage === 'planner') {
    return { role: 'assistant', content: `bounded ${stage} evidence for the M34 acceptance task` };
  }

  if (joined.includes(M34_RETRY_MARKER)) {
    if (body?.model !== M34_STRONG_FIXTURE_MODEL) {
      // Deliberately invalid bounded output. The real executor/Core must own
      // terminalization and the visible retry; the fixture creates no records.
      return { role: 'assistant', content: '{"status":"cannot safely propose within the available evidence"}' };
    }
    return {
      role: 'assistant',
      content: proposal({
        summary: 'Complete the linked retry with the stronger configured fixture model',
        content: "export function formatGreeting(name) {\n  const normalized = String(name).trim();\n  return `Hello, ${normalized}!`;\n}\n",
      }),
    };
  }

  if (joined.includes(M34_REPAIR_MARKER)) {
    const hasRealFailureEvidence = /AssertionError|ERR_ASSERTION|validation failed|failed validation/i.test(joined);
    return {
      role: 'assistant',
      content: proposal(hasRealFailureEvidence
        ? {
          summary: 'Repair the implementation from the preserved npm test failure',
          content: "export function formatGreeting(name) {\n  const normalized = String(name).trim();\n  return `Hello, ${normalized}!`;\n}\n",
        }
        : {
          summary: 'Initial implementation that produces a real validation failure',
          content: "export function formatGreeting(name) {\n  return `Hello ${String(name).trim()}`;\n}\n",
        }),
    };
  }

  return { role: 'assistant', content: 'M34 deterministic fixture requires an explicit scenario marker.' };
}

/**
 * Acceptance-only Ollama transport. It supplies deterministic model output,
 * but never writes Core state or skips the packaged extension's execution,
 * validation, approval, retry, worktree, or delivery paths.
 */
export async function startDeterministicM34Proxy({
  model = M34_FIXTURE_MODEL,
  strongerModel = M34_STRONG_FIXTURE_MODEL,
} = {}) {
  const requests = [];
  const responses = [];
  const scenarioCalls = new Map();
  let closedAt = null;

  const server = http.createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const rawBody = Buffer.concat(chunks).toString('utf8');
    let body = null;
    try {
      body = rawBody ? JSON.parse(rawBody) : null;
    } catch {
      body = null;
    }
    requests.push({ method: request.method, path: request.url, body });

    if (request.url?.startsWith('/api/tags')) {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ models: [
        { name: model, model },
        { name: strongerModel, model: strongerModel },
      ] }));
      return;
    }

    if (request.url?.startsWith('/api/chat')) {
      const joined = (body?.messages ?? []).map((message) => String(message?.content ?? '')).join('\n');
      const scenario = [M34_RECOVERY_MARKER, M34_REPAIR_MARKER, M34_RETRY_MARKER]
        .find((marker) => joined.includes(marker)) ?? 'unmarked';
      const callNumber = (scenarioCalls.get(scenario) ?? 0) + 1;
      scenarioCalls.set(scenario, callNumber);
      const message = fixtureResponse(body, callNumber);
      responses.push({ scenario, callNumber, model: body?.model ?? null, message });
      response.writeHead(200, { 'content-type': 'application/x-ndjson' });
      response.end(`${JSON.stringify({
        model: body?.model ?? model,
        message,
        done: true,
        prompt_eval_count: 1,
        eval_count: 1,
      })}\n`);
      return;
    }

    response.writeHead(404, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ error: 'not found' }));
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('deterministic M34 proxy did not bind a TCP port');

  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    model,
    strongerModel,
    requests,
    responses,
    snapshot: () => ({
      scenarioCalls: Object.fromEntries(scenarioCalls),
      chatRequests: responses.length,
      closedAt,
    }),
    close: () => new Promise((resolve) => {
      server.closeAllConnections?.();
      server.close(() => {
        closedAt = new Date().toISOString();
        resolve();
      });
    }),
  };
}

export function parseExecutionQualityEvents(rows) {
  return (rows ?? [])
    .filter((row) => row?.domain === 'execution_quality')
    .map((row) => ({
      eventType: row.eventType,
      metadata: typeof row.metadata === 'string' ? JSON.parse(row.metadata) : row.metadata,
      sequence: row.sequence,
    }));
}

export function countTerminalTransitions(rows) {
  return (rows ?? []).filter((row) => {
    if (row?.eventType !== 'attempt_transitioned') return false;
    const metadata = typeof row.metadata === 'string' ? JSON.parse(row.metadata) : row.metadata;
    return ['completed', 'failed', 'cancelled'].includes(metadata?.to);
  }).length;
}
