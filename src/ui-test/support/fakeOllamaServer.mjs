/**
 * Guardian-owned localhost fake Ollama HTTP server.
 *
 * This is the harness-side deterministic injection seam approved in place of
 * a product-side `ScriptedProvider`. It speaks exactly the wire contract the
 * real `OllamaProvider` (src/providers/OllamaProvider.ts) already normalizes
 * — `GET /api/tags`, `POST /api/show`, `POST /api/chat` (non-streaming,
 * `stream:false`) — so Guardian exercises real production code (ProviderGateway,
 * AgentLoop, ModelDispatchPlanner, tool dispatch, Core capability approvals)
 * all the way down to the model boundary. Nothing here writes files, creates
 * approvals, touches Core state, mutates Git, or bypasses AgentLoop/tool
 * dispatch — it only returns model responses over HTTP.
 *
 * Scripted decisions (see computeFakeOllamaResponse):
 *   - Baat Kar (no tools offered): a fixed ordinary assistant answer.
 *   - Saath Kar (tools offered, no prior tool-result message): a fixed
 *     `write_file` tool call for note-saath.txt. This is returned identically
 *     whether it is the first attempt (later rejected) or a resubmission
 *     (fresh attempt after rejection/restore) — both are a fresh /api/chat
 *     call with zero prior tool-role messages, driven through the ordinary
 *     model/tool loop exactly like a real model would be asked again.
 *   - Saath Kar completion (tools offered, a prior tool-result message is
 *     present — i.e. the tool actually executed after approval): a fixed
 *     completion answer, no further tool call.
 */
import * as fs from 'node:fs';
import * as http from 'node:http';
import { fileURLToPath } from 'node:url';

// Advertised model identity: deliberately an EXISTING entry in
// ModelCapabilityRegistry.KNOWN (src/models/ModelCapabilityRegistry.ts),
// not an invented Guardian-only name. TaskModelSelection (src/models/
// TaskModelSelection.ts) runs its real, unmodified reliability/context/
// tool/role gate before Core is ever dispatched to — an unknown model name
// falls back to ModelCapabilityRegistry's name-pattern heuristic, which
// (having no digit+"b" parameter-count suffix and no "coder"/"code" token)
// scores well under the 0.82 reliability floor a file-mutation+validation
// task like Saath Kar's write_file turn requires, so the task is rejected
// before any HTTP request ever reaches this fixture. Reusing
// 'qwen3-coder:30b' — chat+tools+structuredOutput+streaming, 40960 context,
// allowedRoles including agent/edit, and a 30B parameter count — clears
// TaskModelSelection's real, unweakened gate the same way a real capable
// coding model would, with zero product-side capability overrides.
export const GUARDIAN_SCRIPTED_MODEL = 'qwen3-coder:30b';
export const GUARDIAN_BAAT_KAR_PROMPT_MARKER = 'Explain what this repository contains.';
export const GUARDIAN_BAAT_KAR_ANSWER =
  'This is a Guardian lifecycle workspace: a small Git repository used to exercise Baat Kar, Saath Kar, and Karke Dikha end to end.';
export const GUARDIAN_SAATH_KAR_PROMPT_MARKER = 'note-saath.txt';
export const GUARDIAN_SAATH_KAR_WRITE_PATH = 'note-saath.txt';
export const GUARDIAN_SAATH_KAR_WRITE_CONTENT = 'Hello from Saath Kar';
export const GUARDIAN_SAATH_KAR_PRECALL_TEXT = 'Creating note-saath.txt now.';
export const GUARDIAN_SAATH_KAR_COMPLETION =
  'Done — note-saath.txt has been created with the requested content.';

/**
 * Pure function of the `/api/chat` request body -> the next scripted
 * response, or `{ error }` when the request does not match any of the six
 * scripted P0/P1 decisions this fixture knows about. Kept pure/exported so
 * it is directly unit-testable without an HTTP round trip.
 */
export function computeFakeOllamaResponse(body) {
  const messages = Array.isArray(body?.messages) ? body.messages : [];
  const tools = Array.isArray(body?.tools) ? body.tools : [];
  const userMessages = messages.filter((m) => m?.role === 'user');
  const toolMessages = messages.filter((m) => m?.role === 'tool');
  const lastUser = userMessages[userMessages.length - 1];
  const lastUserText = String(lastUser?.content ?? '');

  if (tools.length === 0) {
    // Baat Kar: an ordinary chat turn never offers tools.
    if (!lastUser) {
      return { error: 'request carried no user message and offered no tools' };
    }
    if (!lastUserText.includes(GUARDIAN_BAAT_KAR_PROMPT_MARKER)) {
      return { error: `unexpected tool-free (Baat Kar) prompt: ${lastUserText.slice(0, 200)}` };
    }
    return { content: GUARDIAN_BAAT_KAR_ANSWER, toolCall: null };
  }

  // Saath Kar: tools are offered — write_file must be one of them.
  const writeFileOffered = tools.some((t) => t?.function?.name === 'write_file');
  if (!writeFileOffered) {
    return { error: 'tools were offered but write_file was not among them' };
  }

  if (toolMessages.length === 0) {
    if (!lastUserText.includes(GUARDIAN_SAATH_KAR_PROMPT_MARKER)) {
      return { error: `unexpected Saath Kar prompt: ${lastUserText.slice(0, 200)}` };
    }
    return {
      content: GUARDIAN_SAATH_KAR_PRECALL_TEXT,
      toolCall: {
        name: 'write_file',
        arguments: { path: GUARDIAN_SAATH_KAR_WRITE_PATH, content: GUARDIAN_SAATH_KAR_WRITE_CONTENT },
      },
    };
  }

  if (toolMessages.length > 1) {
    return { error: `unexpected extra Saath Kar tool-result turn (saw ${toolMessages.length}, expected exactly 1)` };
  }

  const lastToolMessage = toolMessages[0];
  const toolMessageText = String(lastToolMessage?.content ?? '');
  if (!toolMessageText.includes('write_file')) {
    return { error: `expected a prior write_file tool result; got: ${toolMessageText.slice(0, 200)}` };
  }
  return { content: GUARDIAN_SAATH_KAR_COMPLETION, toolCall: null };
}

/**
 * Starts the fake Ollama server on an ephemeral loopback port. Every
 * `/api/chat` request/response pair is recorded in-memory and, if
 * `logFilePath` is given, appended as JSONL so Guardian's post-run harness
 * assertions (request count/order, tools actually offered, the write_file
 * call coming from the model response) can be checked from evidence without
 * keeping the server process alive.
 */
export async function startFakeOllamaServer({ model = GUARDIAN_SCRIPTED_MODEL, logFilePath } = {}) {
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

    if (request.method === 'GET' && request.url?.startsWith('/api/tags')) {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ models: [{ name: model, model, modified_at: new Date().toISOString() }] }));
      return;
    }

    if (request.method === 'POST' && request.url?.startsWith('/api/show')) {
      // Matches ModelCapabilityRegistry's static KNOWN['qwen3-coder:30b']
      // entry (contextWindow: 40960) so a real /api/show probe never reports
      // a smaller context than the capability table already promises.
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({
        parameters: 'num_ctx 40960',
        model_info: { 'general.context_length': 40960, 'qwen3.context_length': 40960 },
        details: { family: 'qwen3', parameter_size: '30B' },
      }));
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

      const outcome = computeFakeOllamaResponse(body);
      const entry = {
        capturedAt: new Date().toISOString(),
        model: body?.model ?? null,
        toolNamesOffered: Array.isArray(body?.tools) ? body.tools.map((t) => t?.function?.name).filter(Boolean) : [],
        toolMessageCount: Array.isArray(body?.messages) ? body.messages.filter((m) => m?.role === 'tool').length : 0,
        userMessageCount: Array.isArray(body?.messages) ? body.messages.filter((m) => m?.role === 'user').length : 0,
        outcomeContent: outcome.content ?? null,
        outcomeToolCall: outcome.toolCall ?? null,
        outcomeError: outcome.error ?? null,
      };
      appendLog(entry);

      if (outcome.error) {
        response.writeHead(409, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ error: 'unexpected_request_shape', detail: outcome.error }));
        return;
      }

      const frame = {
        model,
        message: {
          role: 'assistant',
          content: outcome.content,
          ...(outcome.toolCall
            ? { tool_calls: [{ function: { name: outcome.toolCall.name, arguments: outcome.toolCall.arguments } }] }
            : {}),
        },
        done: true,
        prompt_eval_count: 1,
        eval_count: 1,
      };
      response.writeHead(200, { 'content-type': 'application/json' });
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
  if (!address || typeof address === 'string') throw new Error('fake Ollama server did not bind a TCP port');

  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    model,
    requestLog,
    chatRequests: () => requestLog.filter((entry) => 'toolMessageCount' in entry),
    violations: () => requestLog.filter((entry) => entry.outcomeError).map((entry) => entry.outcomeError),
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

// Standalone CLI usage (`node fakeOllamaServer.mjs`) — starts the server,
// prints its base URL, and shuts down cleanly on SIGTERM/SIGINT.
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const server = await startFakeOllamaServer({ logFilePath: process.env.GUARDIAN_FAKE_OLLAMA_LOG_PATH });
  // eslint-disable-next-line no-console
  console.log(`[guardian-fake-ollama-server] listening on ${server.baseUrl}`);
  const shutdown = async () => {
    await server.close();
    process.exit(0);
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}
