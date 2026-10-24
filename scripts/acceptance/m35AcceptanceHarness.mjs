import * as fs from 'node:fs';
import * as http from 'node:http';
import * as path from 'node:path';

// Deterministic fixture for the M35 inline-approval packaged scenario. Its
// only job is to supply model output; the packaged extension and Core still
// own the proposal, mutation, delivery, approval, worktree, and durable-state
// machinery being exercised.
//
// Use a registry-known lightweight identity so deterministic routing evidence
// cannot be confused with selection of the 30B five-stage coding default.
export const M35_FIXTURE_MODEL = 'qwen2.5:14b';
export const M35_CAPABLE_FIXTURE_MODEL = 'qwen3-coder:30b';
export const M35_MARKER = '[M35_INLINE_APPROVAL]';

function writeFile(root, relativePath, content) {
  const destination = path.join(root, ...relativePath.split('/'));
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.writeFileSync(destination, content, 'utf8');
}

/** A trivial real repository the deterministic proposal below targets. */
export function writeM35Repository(root) {
  writeFile(root, 'README.md', '# M35 inline-approval acceptance workspace\n');
  writeFile(root, 'src/greeting.js', [
    'export function greeting() {',
    "  return 'hello';",
    '}',
    '',
  ].join('\n'));
  return Object.freeze({
    task: `Change greeting() to return 'hello, karkedikha' and nothing else. ${M35_MARKER}`,
    intendedFile: 'src/greeting.js',
  });
}

function proposalMessage() {
  return {
    role: 'assistant',
    content: JSON.stringify({
      version: 1,
      taskSummary: "Update greeting() to return 'hello, karkedikha'",
      operations: [{
        type: 'replace',
        path: 'src/greeting.js',
        reason: 'M35 deterministic inline-approval fixture',
        content: [
          'export function greeting() {',
          "  return 'hello, karkedikha';",
          '}',
          '',
        ].join('\n'),
      }],
      validationCommands: [],
      warnings: [],
      status: 'proposed',
    }),
  };
}

function fixtureResponse(body) {
  const messages = Array.isArray(body?.messages) ? body.messages : [];
  const joined = messages.map((message) => String(message?.content ?? '')).join('\n');
  const stage = /Stage:\s*([^\n]+)/i.exec(joined)?.[1]?.trim().toLowerCase();
  if (stage === 'repository-analyst' || stage === 'planner') {
    return { role: 'assistant', content: 'bounded planning evidence for the M35 inline-approval acceptance task' };
  }
  if (joined.includes(M35_MARKER)) return proposalMessage();
  return { role: 'assistant', content: 'M35 deterministic fixture requires the explicit scenario marker.' };
}

/**
 * Acceptance-only Ollama transport driving exactly one deterministic
 * proposal. Never writes Core state itself — only supplies chat responses
 * over the real /api/chat surface the packaged extension already calls.
 */
export async function startDeterministicM35Proxy({ model = M35_FIXTURE_MODEL } = {}) {
  const requests = [];
  const responses = [];
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
      response.end(JSON.stringify({ models: [{ name: model, model }] }));
      return;
    }

    if (request.url?.startsWith('/api/chat')) {
      const message = fixtureResponse(body);
      responses.push({ model: body?.model ?? null, message });
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
  if (!address || typeof address === 'string') throw new Error('deterministic M35 proxy did not bind a TCP port');

  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    model,
    requests,
    responses,
    snapshot: () => ({ chatRequests: responses.length, closedAt }),
    close: () => new Promise((resolve) => {
      server.closeAllConnections?.();
      server.close(() => {
        closedAt = new Date().toISOString();
        resolve();
      });
    }),
  };
}
