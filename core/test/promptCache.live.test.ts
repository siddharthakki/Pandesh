/**
 * Live: does the next message reuse Ollama's prompt cache? The real PiAgentEngine and a real local model.
 * Opt in with KARKEDIKHA_LIVE_PROMPT_CACHE=1 (model via KARKEDIKHA_DEFAULT_MODEL, default gemma4:12b).
 *
 * Three questions in one conversation, the clock moved a few minutes before the second and third, the way real
 * messages arrive. Ollama reports how long it spent reading each prompt (prompt_eval_duration); when the prefix
 * matches the previous request it reads only the new tail. Before the prompt-cache layout (turnState.ts) the clock
 * sat near the top of the system prompt and every new message paid for the whole prompt again.
 * Evidence is written to .tmp/prompt-cache-live.json.
 */
import { describe, it, expect, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { openDatabase } from '../db/connection';
import { runMigrations } from '../db/migrations';
import { EventBroadcaster } from '../ws/broadcaster';
import { createConversation, appendMessage } from '../domain/conversations';
import { createRequest } from '../domain/requests';
import { createAttempt } from '../domain/attempts';
import { acquireFence } from '../domain/fence';

const enabled = process.env.KARKEDIKHA_LIVE_PROMPT_CACHE === '1';
const MODEL = process.env.KARKEDIKHA_DEFAULT_MODEL || 'gemma4:12b';
const EVIDENCE = path.join(process.cwd(), '.tmp', 'prompt-cache-live.json');

describe.skipIf(!enabled)('live: the next message reuses the prompt cache', () => {
  it('reads only the new part of the prompt when the clock has moved', async () => {
    const { PiAgentEngine } = await import('../runtime/piAgentEngine');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'prompt-cache-live-'));
    const db = openDatabase(path.join(dir, 'core.db'));
    runMigrations(db);
    const broadcaster = new EventBroadcaster();
    const conv = createConversation(db, { mode: 'baat_kar', title: 'prompt cache live', actor: 'test' });
    vi.useFakeTimers({ toFake: ['Date'], shouldAdvanceTime: true });
    const start = Date.parse('2026-11-11T10:00:00Z');
    const questions = [
      'Explain in one sentence what a hash table is.',
      'And in one sentence, what is a hash collision?',
      'In one sentence, why is lookup in a hash table usually fast?',
    ];
    const turns: Array<{ question: string; firstCall: { promptTokens: number; promptMs: number }; calls: number; reply: string }> = [];
    try {
      for (const [i, question] of questions.entries()) {
        vi.setSystemTime(start + i * 3 * 60_000);
        appendMessage(db, conv.id, { role: 'user', content: question, actor: 'user' });
        const req = createRequest(db, { clientId: 'desktop', conversationId: conv.id, currentMessage: question, requestedMode: 'baat_kar', resolvedMode: 'baat_kar', routeReason: 'user_prompt', contextPolicy: { includeConversationHistory: true, includeProjectContext: false, includeRepositoryContext: false, includeGlobalStoryContext: false }, correlationId: `live_${i}_${Math.random()}` });
        const att = createAttempt(db, { requestId: req.id, kind: 'baat_kar', actor: 'client:desktop' });
        const fence = acquireFence(db, att.id, { owner: 'test', actor: 'test' });
        // The engine stores its own reply in the conversation.
        const result = await new PiAgentEngine().executeAssistantTurn({ db, broadcaster, attemptId: att.id, requestId: req.id, conversationId: conv.id, prompt: question, currentMessage: question, fenceToken: fence.token, model: MODEL });
        const calls = db.all<{ metadata: string }>(`SELECT metadata FROM runtime_events WHERE entityId = ? AND eventType = 'model_call' ORDER BY sequence`, [att.id]).map((r) => JSON.parse(r.metadata));
        expect(calls.length).toBeGreaterThan(0);
        turns.push({ question, firstCall: { promptTokens: calls[0].promptTokens, promptMs: calls[0].promptMs }, calls: calls.length, reply: String(result.reply).slice(0, 200) });
      }
    } finally {
      vi.useRealTimers();
      try { db.close(); } catch {}
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
    }
    fs.mkdirSync(path.dirname(EVIDENCE), { recursive: true });

    // Reading a prompt from scratch on this machine, measured now with a prompt no cache can hold (it starts with a
    // random line). Each later message must cost well under half of reading its whole prompt from scratch.
    const msPerToken = await coldMsPerToken(MODEL);
    const report = turns.map((t, i) => ({ turn: i + 1, ...t.firstCall, fromScratchMs: Math.round(t.firstCall.promptTokens * msPerToken) }));
    fs.writeFileSync(EVIDENCE, JSON.stringify({ model: MODEL, measuredAt: new Date().toISOString(), coldMsPerToken: msPerToken, report, turns }, null, 2));
    console.log(`[prompt-cache-live] from scratch: ${msPerToken.toFixed(3)} ms/token; ${report.map((r) => `turn ${r.turn}: ${r.promptMs} ms (from scratch ~${r.fromScratchMs} ms)`).join('; ')}`);
    for (const later of report.slice(1)) expect(later.promptMs).toBeLessThan(later.fromScratchMs * 0.5);
  }, 600_000);
});

/** Milliseconds per prompt token when nothing is cached: a ~5K-token prompt that begins with a random line. */
async function coldMsPerToken(model: string): Promise<number> {
  const base = (process.env.KARKEDIKHA_OLLAMA_URL || 'http://127.0.0.1:11434').replace(/\/v1\/?$/, '').replace(/\/$/, '');
  const system = `Session ${Math.random()}\n${'Keep answers short, check facts with tools, and report what really happened. '.repeat(320)}`;
  const response = await fetch(`${base}/api/chat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model, stream: false, think: false, options: { num_ctx: 32_768, num_predict: 1 }, messages: [{ role: 'system', content: system }, { role: 'user', content: 'Say OK.' }] }),
  });
  const data = await response.json() as { prompt_eval_count: number; prompt_eval_duration: number };
  return data.prompt_eval_duration / 1e6 / data.prompt_eval_count;
}
