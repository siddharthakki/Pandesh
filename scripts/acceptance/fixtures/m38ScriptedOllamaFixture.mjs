/**
 * M38 — scripted Ollama-compatible HTTP fixture for the governed
 * external-tool-fabric acceptance work.
 *
 * Speaks the same wire shape the real Core model backend speaks
 * (`core/runtime/modelBackend.ts`'s `OllamaModelBackend`): `POST /api/chat`
 * with a `messages` array and an optional `tools` array, replying with a
 * newline-delimited JSON frame shaped `{ model, message: { content,
 * tool_calls? }, done, prompt_eval_count, eval_count }`. `GET /api/tags`
 * mirrors the real model-listing endpoint; `GET /health` is a dedicated
 * readiness probe.
 *
 * For one Saath Kar turn it deterministically drives, in order:
 *   1. a governed repository-inspection tool call (`read_file`)
 *   2. a `governed_research` tool call
 *   3. a `github_comment_on_issue` tool call
 *   4. a final answer grounded in all three tool results
 * by inspecting how many `role: 'tool'` messages are present in the request
 * (Core appends exactly one per completed tool call — see
 * `core/runtime/executor.ts`'s `runCallQueue`/`resumeAgentLoop`) and
 * validating the most recent one carries the expected prior step's marker.
 * Any unexpected sequence — wrong step, wrong/missing marker, a repeated or
 * skipped step — is rejected with a non-2xx response and a clear JSON error
 * body rather than silently guessing a response.
 */
import * as fs from 'node:fs';
import * as http from 'node:http';
import { fileURLToPath } from 'node:url';
import {
  M38_FIXTURE_MODEL,
  M38_REPO_FIXTURE_FILE_NAME,
  M38_REPO_FIXTURE_FILE_CONTENT,
  M38_RESEARCH_QUERY,
  M38_RESEARCH_EVIDENCE_MARKER,
  M38_GITHUB_ISSUE_NUMBER,
  M38_GITHUB_COMMENT_BODY,
  M38_GITHUB_COMMENT_MARKER,
  m38FinalAnswer,
  m38DeniedFinalAnswer,
} from './m38FixtureConstants.mjs';

/** Builds the next scripted response, or `{ error }` if the request does not
 * match the exact expected sequence. Pure function of the request body so
 * it is trivially testable without a live HTTP round trip. */
export function computeScriptedResponse(body) {
  const messages = Array.isArray(body?.messages) ? body.messages : [];
  const toolMessages = messages.filter((m) => m?.role === 'tool');
  const n = toolMessages.length;

  if (n > 3) {
    return { error: `unexpected extra tool-result turn (saw ${n} tool messages, expected at most 3)` };
  }

  if (n === 0) {
    const hasUser = messages.some((m) => m?.role === 'user');
    if (!hasUser) return { error: 'first /api/chat request carried no user message' };
    return {
      content: 'Inspecting the repository first.',
      toolCall: { name: 'read_file', arguments: { path: M38_REPO_FIXTURE_FILE_NAME } },
    };
  }

  if (n === 1) {
    const last = String(toolMessages[0]?.content ?? '');
    if (!last.startsWith('[read_file]') || !last.includes(M38_REPO_FIXTURE_FILE_CONTENT.trim())) {
      return { error: `expected a prior read_file tool result containing the fixture note; got: ${last.slice(0, 200)}` };
    }
    return {
      content: 'Now researching the topic.',
      toolCall: { name: 'governed_research', arguments: { query: M38_RESEARCH_QUERY } },
    };
  }

  if (n === 2) {
    const last = String(toolMessages[1]?.content ?? '');
    if (!last.startsWith('[governed_research]') || !last.includes(M38_RESEARCH_EVIDENCE_MARKER)) {
      return { error: `expected a prior governed_research tool result containing the fixture evidence marker; got: ${last.slice(0, 200)}` };
    }
    return {
      content: 'Now posting the comment.',
      toolCall: { name: 'github_comment_on_issue', arguments: { number: M38_GITHUB_ISSUE_NUMBER, body: M38_GITHUB_COMMENT_BODY } },
    };
  }

  // n === 3
  const last = String(toolMessages[2]?.content ?? '');
  if (!last.startsWith('[github_comment_on_issue]')) {
    return { error: `expected a prior github_comment_on_issue tool result; got: ${last.slice(0, 200)}` };
  }
  // Honest-denial path (core/runtime/executor.ts's rejection branch feeds
  // back exactly `[github_comment_on_issue] Action denied by the user; no
  // mutation was performed.` as the tool result, never the mutation marker):
  // the scripted model still produces a real, grounded final answer that
  // reports the denial rather than a fabricated success — mirroring how a
  // real model would behave given this honest tool result. This is a
  // harness-only extension (the fixture is test-owned, not product code); it
  // does not change what Core feeds the model.
  if (last.includes('Action denied by the user')) {
    return { content: m38DeniedFinalAnswer(), toolCall: null };
  }
  if (!last.includes(M38_GITHUB_COMMENT_MARKER)) {
    return { error: `expected a prior github_comment_on_issue tool result containing the fixture comment marker (or an honest denial); got: ${last.slice(0, 200)}` };
  }
  return { content: m38FinalAnswer(), toolCall: null };
}

export async function startScriptedOllamaFixture({ model = M38_FIXTURE_MODEL, logFilePath } = {}) {
  const requestLog = [];
  let closedAt = null;

  function appendLog(entry) {
    requestLog.push(entry);
    if (logFilePath) {
      try {
        fs.appendFileSync(logFilePath, `${JSON.stringify(entry)}\n`, 'utf8');
      } catch {
        // Evidence logging is best-effort; it must never break the fixture's response path.
      }
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
      try {
        body = rawBody ? JSON.parse(rawBody) : null;
      } catch {
        appendLog({ capturedAt: new Date().toISOString(), rawBody, error: 'request body was not valid JSON' });
        response.writeHead(400, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ error: 'invalid_request', detail: '/api/chat body was not valid JSON' }));
        return;
      }

      const outcome = computeScriptedResponse(body);
      const entry = {
        capturedAt: new Date().toISOString(),
        model: body?.model ?? null,
        toolMessageCount: Array.isArray(body?.messages) ? body.messages.filter((m) => m?.role === 'tool').length : 0,
        messages: body?.messages ?? null,
        outcomeError: outcome.error ?? null,
      };
      appendLog(entry);

      if (outcome.error) {
        response.writeHead(409, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ error: 'unexpected_tool_call_sequence', detail: outcome.error }));
        return;
      }

      const frame = {
        model,
        message: {
          role: 'assistant',
          content: outcome.content,
          ...(outcome.toolCall ? { tool_calls: [{ function: { name: outcome.toolCall.name, arguments: outcome.toolCall.arguments } }] } : {}),
        },
        done: true,
        prompt_eval_count: 1,
        eval_count: 1,
      };
      response.writeHead(200, { 'content-type': 'application/x-ndjson' });
      response.end(`${JSON.stringify(frame)}\n`);
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
  if (!address || typeof address === 'string') throw new Error('scripted Ollama fixture did not bind a TCP port');

  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    model,
    requestLog,
    violations: () => requestLog.filter((e) => e.outcomeError).map((e) => e.outcomeError),
    snapshot: () => ({ chatRequests: requestLog.length, violations: requestLog.filter((e) => e.outcomeError).length, closedAt }),
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections?.();
        server.close(() => {
          closedAt = new Date().toISOString();
          resolve();
        });
      }),
  };
}

// Standalone CLI usage (`node m38ScriptedOllamaFixture.mjs`) — starts the
// fixture, prints its base URL, and shuts down cleanly on SIGTERM/SIGINT.
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const fixture = await startScriptedOllamaFixture({ logFilePath: process.env.M38_OLLAMA_FIXTURE_LOG_PATH });
  // eslint-disable-next-line no-console
  console.log(`[m38-scripted-ollama-fixture] listening on ${fixture.baseUrl}`);
  const shutdown = async () => {
    await fixture.close();
    process.exit(0);
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}
