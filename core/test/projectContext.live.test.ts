/**
 * Live acceptance: the real PiAgentEngine turn, a real local Ollama model and real workspace folders.
 * Opt in with KARKEDIKHA_LIVE_PROJECT_CONTEXT=1 (model via KARKEDIKHA_DEFAULT_MODEL).
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { PiAgentEngine } from '../runtime/piAgentEngine';
import { openCoreDatabase } from '../db/openCore';
import { EventBroadcaster } from '../ws/broadcaster';
import { createConversation, appendMessage } from '../domain/conversations';
import { createRequest } from '../domain/requests';
import { createAttempt, getAttempt } from '../domain/attempts';
import { acquireFence } from '../domain/fence';
import { getTaskOutcome } from '../domain/taskOutcomes';

const enabled = process.env.KARKEDIKHA_LIVE_PROJECT_CONTEXT === '1';
const MODEL = process.env.KARKEDIKHA_DEFAULT_MODEL || 'gemma4:26b-a4b-it-qat';
const IMAGEGEN = 'C:\\Projects\\ImageGeneration';
const OTHER = 'C:\\Projects\\JobFinder';
const EVIDENCE = path.join(process.cwd(), '.tmp', 'project-context-live.json');

describe.skipIf(!enabled)('live: "this project" resolves against the selected workspace', () => {
  it('answers from the right workspace, across a switch, and refuses honestly for an inaccessible folder', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'project-context-live-'));
    const db = openCoreDatabase(path.join(dir, 'core.db')).db;
    const broadcaster = new EventBroadcaster();
    const engine = new PiAgentEngine();
    const conv = createConversation(db, { mode: 'baat_kar', title: 'project context live', actor: 'test' });
    const log: Array<Record<string, unknown>> = [];

    async function ask(question: string, workspaceRoot: string | undefined) {
      appendMessage(db, conv.id, { role: 'user', content: question, actor: 'test' });
      const req = createRequest(db, {
        clientId: 'live', currentMessage: question, requestedMode: 'baat_kar', resolvedMode: 'baat_kar',
        routeReason: 'live', correlationId: `c-${log.length}`, contextPolicy: {}, conversationId: conv.id, actor: 'test',
      });
      const attempt = createAttempt(db, { requestId: req.id, kind: 'baat_kar', actor: 'test' });
      const fence = acquireFence(db, attempt.id, { owner: 'live', actor: 'test', leaseMs: 600_000 });
      const started = Date.now();
      const result = await engine.executeAssistantTurn({
        db, broadcaster, attemptId: attempt.id, requestId: req.id, conversationId: conv.id,
        workspaceRoot, prompt: question, currentMessage: question, model: MODEL, fenceToken: fence.token,
      } as any);
      const final = getAttempt(db, attempt.id);
      const outcome = getTaskOutcome(db, attempt.id);
      const row = { question, workspaceRoot: workspaceRoot ?? null, success: result.success, attemptStatus: final.status, taskStatus: outcome?.status ?? null, taskEvidence: outcome?.evidence ?? null, ms: Date.now() - started, reply: result.reply };
      log.push(row);
      return row;
    }

    const q1 = await ask('What does this project do?', IMAGEGEN);
    const q2 = await ask('What language is it written in?', IMAGEGEN);
    const q3 = await ask('How do I run it?', IMAGEGEN);
    const q4 = await ask('What does this project do?', OTHER);
    const gone = path.join(dir, 'DeletedWorkspace');
    const q5 = await ask('What does this project do?', gone);
    const q6 = await ask('What does this project do?', undefined);

    fs.mkdirSync(path.dirname(EVIDENCE), { recursive: true });
    fs.writeFileSync(EVIDENCE, JSON.stringify(log, null, 2));

    for (const r of [q1, q2, q3]) {
      expect(r.attemptStatus).toBe('completed');
      expect(r.taskStatus).toBe('satisfied');
      expect(r.reply).not.toMatch(/which project|specify/i);
    }
    expect(q1.reply).toMatch(/image|diffusion|comfy|generat/i);
    expect(q2.reply).toMatch(/python/i);
    expect(q3.reply).toMatch(/launch\.bat|_start\.ps1|app\.py|pip install|requirements/i);
    // Different workspace -> different project, nothing carried over from ImageGeneration.
    expect(q4.reply).not.toMatch(/ImageGeneration|ComfyUI/i);
    // Unusable folders: exact message, no generated answer, task not reported successful.
    expect(q5.success).toBe(false);
    expect(q5.reply).toContain(gone);
    expect(q5.attemptStatus).toBe('failed');
    expect(q5.taskStatus).not.toBe('satisfied');
    expect(q6.success).toBe(false);
    expect(q6.reply).toMatch(/No workspace folder is selected/);
  }, 900_000);
});
