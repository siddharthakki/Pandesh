import { afterAll, beforeAll, beforeEach, afterEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';
import type { AddressInfo } from 'node:net';
import { openCoreDatabase } from '../db/openCore';
import type { CoreDatabase } from '../db/connection';
import { EventBroadcaster } from '../ws/broadcaster';
import { createConversation } from '../domain/conversations';
import { submitRequest } from '../domain/submission';
import { acquireFence } from '../domain/fence';
import { listPendingApprovals, resolveApproval } from '../domain/approvals';
import { createStandingAuthorization, setConversationPermissionMode } from '../domain/permissionModes';
import { resetQueryPrivacyWarmth, updateQueryPrivacySettings } from '../runtime/queryPrivacySecondOpinion';
import { resetCommandReviewWarmth } from '../runtime/commandSecondOpinion';
import { startScriptedOllama, afterToolResult, type ScriptedOllama } from './support/scriptedOllama';

/**
 * The Ollaya privacy second opinion on the real search path (web_research), next to the existing guard. A query the
 * guard lets through but the model flags goes to the person as a card; nothing is sent without a yes. When it is off,
 * down or slow, research works exactly as before. A fake SearXNG counts what would really have been sent.
 */

// The miss that made the first pick fail: the guard lets it through (no path, no "my", not the whole message).
const NAME_AND_DIAGNOSIS = 'Jonas Weber diabetes diagnosis treatment options';
const PUBLIC = 'latest stable Ollama release';

interface Verdict { publicP: number; personDetail: number }
let verdict: Verdict;
let ollayaRequests = 0;
let searches: string[] = [];
let query = NAME_AND_DIAGNOSIS;
let ollaya: http.Server; let searx: http.Server; let model: ScriptedOllama;
let ollayaUrl: string; let closedUrl: string;
let PiAgentEngineCtor: typeof import('../runtime/piAgentEngine').PiAgentEngine;
const saved = { model: process.env.KARKEDIKHA_OLLAMA_URL, ollaya: process.env.KARKEDIKHA_OLLAYA_URL, flag: process.env.KARKEDIKHA_OLLAYA, searx: process.env.KARKEDIKHA_SEARXNG_URL };

const listen = (server: http.Server) => new Promise<string>((r) => server.listen(0, '127.0.0.1', () => r(`http://127.0.0.1:${(server.address() as AddressInfo).port}`)));

beforeAll(async () => {
  ollaya = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      ollayaRequests += 1;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ model: JSON.parse(body || '{}').model ?? 'unknown', answers: {
        kind: { type: 'choice', choice: 'public', confidence: 0.5, probabilities: { public: verdict.publicP, personal: 1 - verdict.publicP, confidential: 0 } },
        person_detail: { type: 'noul', noul: verdict.personDetail },
        // The command review's questions, should a warm-up for it arrive here too.
        step: { type: 'noul', noul: 0.9 }, destructive: { type: 'noul', noul: 0.05 },
      } }));
    });
  });
  ollayaUrl = await listen(ollaya);
  searx = http.createServer((req, res) => {
    searches.push(new URL(req.url ?? '/', 'http://x').searchParams.get('q') ?? '');
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ results: [] }));
  });
  process.env.KARKEDIKHA_SEARXNG_URL = `${await listen(searx)}/search`;
  const probe = http.createServer();
  closedUrl = await listen(probe);
  await new Promise<void>((r) => probe.close(() => r()));
  model = await startScriptedOllama((call) => {
    const toolOutput = afterToolResult(call);
    if (toolOutput !== null) return { text: `Tool said: ${toolOutput.slice(0, 300)}` };
    return { tool: { name: 'web_research', args: { query } } };
  });
  process.env.KARKEDIKHA_OLLAMA_URL = model.url;
  PiAgentEngineCtor = (await import('../runtime/piAgentEngine')).PiAgentEngine;
});

afterAll(async () => {
  for (const [key, value] of [['KARKEDIKHA_OLLAMA_URL', saved.model], ['KARKEDIKHA_OLLAYA_URL', saved.ollaya], ['KARKEDIKHA_OLLAYA', saved.flag], ['KARKEDIKHA_SEARXNG_URL', saved.searx]] as const) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
  await model.close();
  await new Promise<void>((r) => ollaya.close(() => r()));
  await new Promise<void>((r) => searx.close(() => r()));
});

describe('privacy second opinion on web_research', () => {
  let dir: string;
  let db: CoreDatabase;
  let conversationId: string;
  let decider: NodeJS.Timeout | undefined;
  let cards: Array<{ cardText: string; privacySecondOpinion?: unknown }>;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pandesh-query-privacy-engine-'));
    db = openCoreDatabase(path.join(dir, 'core.db')).db;
    conversationId = createConversation(db, { mode: 'baat_kar', actor: 'test' }).id;
    verdict = { publicP: 0.95, personDetail: 0.02 };
    ollayaRequests = 0;
    searches = [];
    cards = [];
    query = NAME_AND_DIAGNOSIS;
    resetQueryPrivacyWarmth();
    resetCommandReviewWarmth();
    delete process.env.KARKEDIKHA_OLLAYA;
    process.env.KARKEDIKHA_OLLAYA_URL = ollayaUrl;
  });

  afterEach(() => {
    if (decider) clearInterval(decider);
    decider = undefined;
    try { db.close(); } catch {}
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  });

  function answerCards(resolution: 'approved' | 'rejected') {
    decider = setInterval(() => {
      for (const a of listPendingApprovals(db)) {
        cards.push({ cardText: String(a.summary.cardText ?? ''), privacySecondOpinion: a.summary.privacySecondOpinion });
        try {
          resolveApproval(db, a.id, { resolution, attemptId: a.attemptId, gate: a.kind, expectedAttemptRevision: a.expectedAttemptRevision, expectedAttemptStatus: a.expectedAttemptStatus, requestedActionDigest: a.requestedActionDigest, frozenContextHash: a.frozenContextHash, expectedRevision: a.revision, actor: 'test-operator' });
        } catch {}
      }
    }, 50);
  }

  async function turn(text: string, mode: 'ask' | 'auto') {
    if (mode === 'auto') {
      setConversationPermissionMode(db, conversationId, 'auto', 'desktop');
      createStandingAuthorization(db, { conversationId, categories: ['web_research_public'], expiresInMinutes: 60, actor: 'desktop' });
    }
    const { request, attempt } = submitRequest(db, {
      clientId: 'desktop', currentMessage: text, requestedMode: 'baat_kar', conversationId,
      requestedProvider: 'ollama', selectedModel: 'fake-model', toolPermissionPolicy: { profile: 'confirm-mutations' }, correlationId: `c-${Math.random()}`,
    });
    const fence = acquireFence(db, attempt.id, { owner: 'test', actor: 'test' });
    return new PiAgentEngineCtor().executeAssistantTurn({ db, broadcaster: new EventBroadcaster(), attemptId: attempt.id, requestId: request.id, conversationId, prompt: text, currentMessage: text, fenceToken: fence.token, model: 'fake-model' });
  }

  const reviews = () => db.all<{ metadata: string }>("SELECT metadata FROM runtime_events WHERE eventType = 'query_privacy_second_opinion' ORDER BY sequence").map((r) => ({ raw: r.metadata, ...JSON.parse(r.metadata) }));
  const askAboutJonas = 'Search the web for what is known about treatment options in the case of Jonas Weber and his diabetes diagnosis';

  it('regression: the guard lets the name-plus-diagnosis query through; a flagged one waits for the person and is not sent when refused', async () => {
    updateQueryPrivacySettings(db, { enabled: true });
    verdict = { publicP: 0.2, personDetail: 0.9 };
    answerCards('rejected');
    await turn(askAboutJonas, 'ask');
    expect(searches).toEqual([]);
    expect(cards).toHaveLength(1);
    expect(cards[0].cardText).toMatch(/^⚠ This search may contain private information: a second opinion on this PC \(decider:2b, decider:0\.8b\)/);
    expect(cards[0].cardText).toContain(`Pandesh wants to search the web for: "${NAME_AND_DIAGNOSIS}"`);
    expect(cards[0].privacySecondOpinion).toMatchObject({ models: ['decider:2b', 'decider:0.8b'], personDetail: 0.9, kindFlag: true, detailFlag: true, kindThreshold: 0.7, detailThreshold: 0.6 });
    const [event] = reviews();
    expect(event).toMatchObject({ outcome: 'asked', toolName: 'web_research', flagged: true });
    expect(event.raw).not.toMatch(/Jonas|Weber|diabetes/);
  }, 60_000);

  it('a flagged query the person approves is sent', async () => {
    updateQueryPrivacySettings(db, { enabled: true });
    verdict = { publicP: 0.2, personDetail: 0.9 };
    answerCards('approved');
    await turn(askAboutJonas, 'ask');
    expect(cards).toHaveLength(1);
    expect(searches).toEqual([NAME_AND_DIAGNOSIS]);
  }, 60_000);

  it('a query the second opinion finds public gets the usual consent card, without a warning', async () => {
    updateQueryPrivacySettings(db, { enabled: true });
    answerCards('rejected');
    await turn(askAboutJonas, 'ask');
    expect(cards).toHaveLength(1);
    expect(cards[0].cardText).not.toContain('⚠');
    expect(cards[0].privacySecondOpinion).toBeUndefined();
    expect(reviews()).toMatchObject([{ outcome: 'clear' }]);
  }, 60_000);

  it('Auto: a public search runs as before; when the second opinion flags it, neither the search nor Core\'s fallback search is sent', async () => {
    query = PUBLIC;
    updateQueryPrivacySettings(db, { enabled: true });
    answerCards('rejected');
    // The fake search engine finds nothing, so Core also runs its own fallback search with a query derived from the
    // message; it goes through the same web_research tool, guard and second opinion.
    await turn(`Search the web for the ${PUBLIC}`, 'auto');
    expect(cards).toHaveLength(0);
    expect(searches).toEqual([PUBLIC, `the ${PUBLIC}`]);
    expect(reviews().map((r) => r.outcome)).toEqual(['clear', 'clear']);

    searches = [];
    verdict = { publicP: 0.1, personDetail: 0.2 };
    await turn(`Search the web for the ${PUBLIC}`, 'auto');
    expect(searches).toEqual([]);
    expect(cards).toHaveLength(2);
    for (const card of cards) {
      expect(card.cardText).toContain('⚠ This search may contain private information');
      expect(card.cardText).toContain('Auto would have sent this search, but a second opinion thinks it may contain private information, so it waits for you.');
    }
    expect(reviews().slice(2).map((r) => r.outcome)).toEqual(['asked', 'asked']);
  }, 60_000);

  it('off by default: Ollaya is never asked and research behaves as before', async () => {
    verdict = { publicP: 0.01, personDetail: 0.99 };
    answerCards('rejected');
    await turn(askAboutJonas, 'ask');
    expect(ollayaRequests).toBe(0);
    expect(cards).toHaveLength(1);
    expect(cards[0].cardText).not.toContain('⚠');
    expect(reviews()).toHaveLength(0);
  }, 60_000);

  it('when Ollaya is not running nothing changes', async () => {
    updateQueryPrivacySettings(db, { enabled: true });
    process.env.KARKEDIKHA_OLLAYA_URL = closedUrl;
    answerCards('rejected');
    await turn(askAboutJonas, 'ask');
    expect(cards).toHaveLength(1);
    expect(cards[0].cardText).not.toContain('⚠');
    expect(reviews()).toMatchObject([{ outcome: 'unavailable', unavailable: 'unreachable' }]);
  }, 60_000);

  it('the existing guard still refuses first: Ollaya is not asked about a query it already stopped', async () => {
    query = 'C:\\Users\\alex\\Documents\\report.docx summary';
    updateQueryPrivacySettings(db, { enabled: true });
    answerCards('approved');
    await turn('Summarise the report in my documents and search the web for related facts', 'ask');
    expect(searches).toEqual([]);
    expect(reviews()).toHaveLength(0);
  }, 60_000);
});
