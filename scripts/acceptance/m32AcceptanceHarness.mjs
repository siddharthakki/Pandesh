import * as http from 'http';

export const SAATH_CANCEL_FIXTURE_MODEL = 'm32-saathcancel-fixture';
export const SAATH_CANCEL_COMMAND = 'ping -n 20 127.0.0.1';

export const SCENARIO_REGISTRY = Object.freeze([
  Object.freeze({ name: 'baatkar', label: 'Baat Kar real-model packaged UI', requiresRealModel: true }),
  Object.freeze({ name: 'saathkar', label: 'Saath Kar real-model smoke', requiresRealModel: true }),
  Object.freeze({ name: 'saathcancel', label: 'Saath Kar deterministic cancellation', requiresRealModel: false }),
  Object.freeze({ name: 'karke', label: 'Karke Dikha governed delivery', requiresRealModel: true }),
  Object.freeze({ name: 'restart', label: 'Restart at approval', requiresRealModel: true }),
  Object.freeze({ name: 'followup', label: 'Baat Kar follow-up conversation', requiresRealModel: true }),
  Object.freeze({ name: 'everyday', label: 'M33 everyday journey (unified composer, recommendation, approvals, outcome, durable history, restart)', requiresRealModel: true }),
  Object.freeze({ name: 'm34-realwork', label: 'M34 real-world coding task (real model, validation, delivery, history)', requiresRealModel: true }),
  Object.freeze({ name: 'm34-recovery', label: 'M34 repository-path and non-progress recovery', requiresRealModel: false }),
  Object.freeze({ name: 'm34-repair-retry', label: 'M34 bounded validation repair and blocker retry', requiresRealModel: false }),
  Object.freeze({ name: 'm35-inline-approval', label: 'M35 inline chat-timeline approval gates, webview recreation, and restart persistence', requiresRealModel: false }),
  Object.freeze({ name: 'm35-trivial-steering', label: 'M35 model-free trivial steering through governed local delivery', requiresRealModel: false }),
  Object.freeze({ name: 'm35-inline-stop', label: 'M35 visible unified-composer inline Stop cancellation', requiresRealModel: false }),
  // Split per the M36 pass-2 gate-policy correction: package-provenance
  // protection and the packaged approval-gate mechanics must remain a hard,
  // deterministic CI gate (never gated on an open-ended real model), while
  // the genuinely nondeterministic real-local-model coding task is retained
  // as its own separately reported, non-gating live-model diagnostic — never
  // silently dropped, never allowed to block or misrepresent the
  // deterministic gate's own pass/fail.
  Object.freeze({ name: 'm35-package-provenance-gate', label: 'M35 package-provenance protection + packaged approval-gate lifecycle (deterministic fixture, hard CI gate)', requiresRealModel: false }),
  Object.freeze({ name: 'm35-package-provenance-live-diagnostic', label: 'M35 real-local-model package-provenance coding dogfood task (advisory, non-gating diagnostic — see run-win32-packaged-acceptance.ps1)', requiresRealModel: true }),
  Object.freeze({ name: 'm36-attachment-restart', label: 'M36 durable attachment upload (text + image) through the real Simple File Dialog, deterministic multimodal submission, and restart restoration', requiresRealModel: false }),
  Object.freeze({ name: 'm36-document-audio-restart', label: 'M36 durable document extraction plus successful timestamped local audio transcription through the real Simple File Dialog and restart restoration', requiresRealModel: false }),
  Object.freeze({ name: 'm36-governed-research-restart', label: 'M36 approved SearXNG research with deterministic sources, citation UI, and restart/no-refetch proof', requiresRealModel: false }),
  Object.freeze({ name: 'm36-combined-workbench', label: 'M36 final packaged workbench exit: one durable mixed-media, vision-routed, grounded research conversation with restart recovery', requiresRealModel: false }),
  // M39 mandatory exit gate: governed memory consent, durable recall with
  // evidence, contradiction preservation and explicit-policy resolution,
  // bounded impact analysis, auditable export, governed forget, exactly-once
  // redispatch, and a refused restricted secret — all across real host
  // restarts, driven entirely by deterministic fixtures (never live-model
  // judgement).
  Object.freeze({ name: 'm39-memory-knowledge-restart', label: 'M39 governed memory and knowledge intelligence across real Extension Host restarts (deterministic fixture, hard CI gate)', requiresRealModel: false }),
]);

export function selectScenarios(onlyRaw) {
  const requested = onlyRaw
    ? onlyRaw.split(',').map((value) => value.trim().toLowerCase()).filter(Boolean)
    : null;
  if (!requested) return [...SCENARIO_REGISTRY];

  const known = new Set(SCENARIO_REGISTRY.map((scenario) => scenario.name));
  const unknown = requested.filter((name) => !known.has(name));
  if (unknown.length > 0) {
    throw new Error(
      `unknown scenario name(s): ${unknown.join(', ')} (valid: ${SCENARIO_REGISTRY.map((scenario) => scenario.name).join(', ')})`,
    );
  }
  const selected = new Set(requested);
  return SCENARIO_REGISTRY.filter((scenario) => selected.has(scenario.name));
}

export function formatScenarioRegistry() {
  return SCENARIO_REGISTRY.map((scenario, index) => `${index + 1}. ${scenario.name} - ${scenario.label}`).join('\n');
}

/**
 * Durable pre-turn baseline capture for the follow-up scenario.
 *
 * Snapshot every existing Core conversation BEFORE follow-up turn 1, keyed by
 * conversation id. After turn 1 creates its Core request, the baseline is
 * resolved from that request's authoritative conversation id against this
 * snapshot. Selecting the globally newest / most-recently-updated conversation
 * is forbidden: an unrelated conversation (for example an earlier Saath Kar
 * run) can easily be newer than the Baat conversation backing the active
 * webview thread.
 */
export function captureConversationBaselineSnapshot(conversations) {
  const byId = new Map();
  for (const conversation of conversations ?? []) {
    if (!conversation?.id) throw new Error('conversation snapshot entry is missing an id');
    if (byId.has(conversation.id)) throw new Error(`duplicate conversation id in pre-turn snapshot: ${conversation.id}`);
    const messages = (conversation.messages ?? []).map((message) => ({
      id: message.id,
      seq: message.seq,
      role: message.role,
      content: message.content,
      modelInvocationId: message.modelInvocationId ?? null,
    }));
    byId.set(conversation.id, {
      conversationId: conversation.id,
      mode: conversation.mode ?? null,
      messageCount: messages.length,
      messageIds: messages.map((message) => message.id),
      messages,
    });
  }
  return { capturedAt: new Date().toISOString(), conversationIds: [...byId.keys()], byId };
}

/**
 * Resolve the durable pre-turn baseline for the exact conversation the
 * follow-up turn actually used. A conversation absent from the snapshot was
 * created by the turn itself and therefore has an empty baseline. Throws
 * rather than guessing when the turn produced no conversation id.
 */
export function resolveFollowUpBaseline(snapshot, followUpConversationId) {
  if (!snapshot?.byId) throw new Error('a pre-turn conversation snapshot is required to resolve the follow-up baseline');
  if (!followUpConversationId) throw new Error('follow-up turn 1 did not resolve an authoritative conversation id');
  const entry = snapshot.byId.get(followUpConversationId);
  if (!entry) {
    return {
      conversationId: followUpConversationId,
      existedBeforeTurnOne: false,
      mode: null,
      length: 0,
      messageIds: [],
      messages: [],
    };
  }
  return {
    conversationId: followUpConversationId,
    existedBeforeTurnOne: true,
    mode: entry.mode,
    length: entry.messageCount,
    messageIds: entry.messageIds,
    messages: entry.messages,
  };
}

/**
 * Recall-assertion normalization for the follow-up scenario, confined to the
 * acceptance harness. Real models legitimately reformat the remembered phrase
 * ("Blue_Mango_4729", quotes, commas), so the raw literal-substring check was
 * a false-negative trap. Normalization: Unicode NFKC, lowercase, every run of
 * non-alphanumeric characters becomes a single space, trim. The result is a
 * canonical space-separated token string.
 */
export function normalizeRecallText(text) {
  return String(text ?? '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/**
 * True only when the normalized candidate contains the normalized phrase as
 * an exact ordered, adjacent token sequence on token boundaries. Tokens
 * merely appearing somewhere (out of order, separated, or partial like
 * "47290") never match.
 */
export function recallTextContainsPhrase(candidate, phrase) {
  const normalizedPhrase = normalizeRecallText(phrase);
  if (!normalizedPhrase) throw new Error('recall phrase must contain at least one alphanumeric token');
  return ` ${normalizeRecallText(candidate)} `.includes(` ${normalizedPhrase} `);
}

/**
 * Acceptance-only deterministic Ollama fixture. Its first chat response emits
 * exactly one native run_command tool request. Any later chat response is a
 * final answer with no tool call, so the fixture can never dispatch a second
 * command even if a caller ignores cancellation.
 */
export async function startDeterministicSaathCancelProxy({
  model = SAATH_CANCEL_FIXTURE_MODEL,
  command = SAATH_CANCEL_COMMAND,
} = {}) {
  const requests = [];
  let chatResponses = 0;
  let toolCallResponses = 0;
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
    requests.push({
      capturedAt: new Date().toISOString(),
      method: request.method,
      path: request.url,
      body,
    });

    if (request.url?.startsWith('/api/tags')) {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ models: [{ name: model, model }] }));
      return;
    }

    if (request.url?.startsWith('/api/chat')) {
      chatResponses += 1;
      response.writeHead(200, { 'content-type': 'application/x-ndjson' });
      if (chatResponses === 1) {
        toolCallResponses += 1;
        response.end(`${JSON.stringify({
          model,
          message: {
            role: 'assistant',
            content: '',
            tool_calls: [{ function: { name: 'run_command', arguments: { command } } }],
          },
          done: true,
          prompt_eval_count: 1,
          eval_count: 1,
        })}\n`);
      } else {
        response.end(`${JSON.stringify({
          model,
          message: { role: 'assistant', content: 'The command finished.' },
          done: true,
          prompt_eval_count: 1,
          eval_count: 1,
        })}\n`);
      }
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
  if (!address || typeof address === 'string') throw new Error('deterministic Saath cancellation proxy did not bind a TCP port');

  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    model,
    command,
    requests,
    snapshot: () => ({
      chatResponses,
      toolCallResponses,
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
