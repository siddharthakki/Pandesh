import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { openCoreDatabase } from '../db/openCore';
import type { CoreDatabase } from '../db/connection';
import {
  COMMAND_REVIEW_DEFAULTS, commandOpinionWarnings, isLoopbackEndpoint, readCommandReviewSettings, recordCommandReview,
  resetCommandReviewWarmth, reviewCommand, updateCommandReviewSettings, warmCommandReview, type CommandOpinion, type CommandReviewSettings,
} from '../runtime/commandSecondOpinion';

/**
 * The optional Ollaya second opinion on commands: off by default, loopback only, no answer means no opinion, and the
 * record never holds the command or the request.
 */

let dir: string;
let db: CoreDatabase;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pandesh-second-opinion-'));
  db = openCoreDatabase(path.join(dir, 'core.db')).db;
  resetCommandReviewWarmth();
});
afterEach(() => {
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

const on: CommandReviewSettings = { enabled: true, endpoint: 'http://127.0.0.1:11435', model: 'decision', offTaskThreshold: 0.4, destructiveThreshold: 0.2, timeoutMs: 3_000, source: 'setting' };
const answer = (step: number, destructive: number, status = 200) =>
  vi.fn(async () => new Response(JSON.stringify({ model: 'decision:latest', answers: { step: { type: 'noul', noul: step }, destructive: { type: 'noul', noul: destructive } } }), { status }));

describe('settings', () => {
  it('is off by default, with the measured model and thresholds', () => {
    expect(readCommandReviewSettings(db, {})).toMatchObject({
      enabled: false, source: 'default', model: 'decision', offTaskThreshold: 0.4, destructiveThreshold: 0.2, timeoutMs: 3_000, endpoint: COMMAND_REVIEW_DEFAULTS.endpoint,
    });
  });

  it('stores the owner\'s choice and validates it', () => {
    expect(updateCommandReviewSettings(db, { enabled: true, offTaskThreshold: 0.5, destructiveThreshold: 0.3, model: 'decider:2b' }, {}))
      .toMatchObject({ enabled: true, offTaskThreshold: 0.5, destructiveThreshold: 0.3, model: 'decider:2b', source: 'setting' });
    expect(readCommandReviewSettings(db, {})).toMatchObject({ enabled: true, offTaskThreshold: 0.5 });
    expect(() => updateCommandReviewSettings(db, { enabled: 'yes' }, {})).toThrow(/true or false/);
    expect(() => updateCommandReviewSettings(db, { offTaskThreshold: 1.5 }, {})).toThrow(/0.05 to 0.95/);
    expect(() => updateCommandReviewSettings(db, { destructiveThreshold: 0 }, {})).toThrow(/0.05 to 0.95/);
    expect(() => updateCommandReviewSettings(db, { model: 'x; rm -rf /' }, {})).toThrow(/model name/);
  });

  it('KARKEDIKHA_OLLAYA overrides the stored setting both ways', () => {
    updateCommandReviewSettings(db, { enabled: true }, {});
    expect(readCommandReviewSettings(db, { KARKEDIKHA_OLLAYA: '0' })).toMatchObject({ enabled: false, source: 'environment' });
    updateCommandReviewSettings(db, { enabled: false }, {});
    expect(readCommandReviewSettings(db, { KARKEDIKHA_OLLAYA: '1' })).toMatchObject({ enabled: true, source: 'environment' });
  });

  it('accepts only loopback endpoints', () => {
    expect(isLoopbackEndpoint('http://127.0.0.1:11435')).toBe(true);
    expect(isLoopbackEndpoint('http://localhost:11435')).toBe(true);
    expect(isLoopbackEndpoint('http://[::1]:11435')).toBe(true);
    expect(isLoopbackEndpoint('http://192.0.2.10:11435')).toBe(false);
    expect(isLoopbackEndpoint('http://127.0.0.1.example.net:11435')).toBe(false);
    expect(isLoopbackEndpoint('file:///C:/x')).toBe(false);
    expect(isLoopbackEndpoint('not a url')).toBe(false);
  });
});

describe('reviewCommand', () => {
  const input = { request: 'Run the unit tests of my project', command: 'git push --force origin main' };

  it('asks nothing when it is off', async () => {
    const fetchImpl = answer(0.05, 0.9);
    expect(await reviewCommand({ ...on, enabled: false }, input, { fetchImpl })).toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('never sends anything to a non-loopback address', async () => {
    const fetchImpl = answer(0.05, 0.9);
    expect(await reviewCommand({ ...on, endpoint: 'http://192.0.2.10:11435' }, input, { fetchImpl })).toMatchObject({ available: false, reason: 'not_loopback' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('flags a command that is not a step of the task, or destructive, at each threshold, and sends only the request and the command', async () => {
    const fetchImpl = answer(0.05, 0.75);
    const review = await reviewCommand(on, input, { fetchImpl });
    expect(review).toMatchObject({ available: true, opinion: { offTaskFlag: true, destructiveFlag: true, flagged: true, step: 0.05, destructive: 0.75, model: 'decision:latest' } });
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [URL, RequestInit];
    expect(String(url)).toBe('http://127.0.0.1:11435/v1/systemone');
    const body = JSON.parse(String(init.body));
    expect(body.model).toBe('decision');
    expect(body.state).toEqual(input);
    expect(Object.keys(body.questions)).toEqual(['step', 'destructive']);
    expect(body.questions.step.instructions).toBe('Could `command` be one of the steps of doing what `request` asks?');
    // Exactly at a threshold counts; just past it does not.
    expect(await reviewCommand(on, input, { fetchImpl: answer(0.6, 0.2) })).toMatchObject({ opinion: { offTaskFlag: true, destructiveFlag: true } });
    expect(await reviewCommand(on, input, { fetchImpl: answer(0.61, 0.19) })).toMatchObject({ opinion: { offTaskFlag: false, destructiveFlag: false, flagged: false } });
  });

  it('gives no opinion for an HTTP error, an unreadable answer, an unreachable server or a timeout', async () => {
    expect(await reviewCommand(on, input, { fetchImpl: answer(0.05, 0.9, 500) })).toMatchObject({ available: false, reason: 'http_error' });
    const unreadable = vi.fn(async () => new Response(JSON.stringify({ answers: { step: { noul: 'high' } } })));
    expect(await reviewCommand(on, input, { fetchImpl: unreadable })).toMatchObject({ available: false, reason: 'unreadable' });
    const refused = vi.fn(async () => { throw new TypeError('fetch failed'); });
    expect(await reviewCommand(on, input, { fetchImpl: refused })).toMatchObject({ available: false, reason: 'unreachable' });
    const hangs = vi.fn((_url: unknown, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'TimeoutError' })));
    }));
    const started = Date.now();
    expect(await reviewCommand({ ...on, timeoutMs: 150 }, input, { fetchImpl: hangs as unknown as typeof fetch })).toMatchObject({ available: false, reason: 'timeout' });
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it('stops with the turn', async () => {
    const turn = new AbortController();
    const hangs = vi.fn((_url: unknown, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
    }));
    const pending = reviewCommand(on, input, { fetchImpl: hangs as unknown as typeof fetch, signal: turn.signal });
    turn.abort();
    expect(await pending).toMatchObject({ available: false, reason: 'unreachable' });
  });
});

describe('what the card and the record say', () => {
  const opinion: CommandOpinion = { model: 'decision:latest', step: 0.04, destructive: 0.31, offTaskFlag: true, destructiveFlag: true, flagged: true, offTaskThreshold: 0.4, destructiveThreshold: 0.2, latencyMs: 1100 };

  it('warns that the command may not match the request and may be destructive, with a short reason and no percentage', () => {
    const both = commandOpinionWarnings(opinion, false);
    expect(both).toEqual([
      '⚠ Command may not match your request: a second opinion on this PC (decision:latest) does not see it as a step of what you asked for.',
      '⚠ Potentially destructive: a second opinion on this PC (decision:latest) thinks it may delete or overwrite data that cannot be recovered.',
    ]);
    expect(both.join(' ')).not.toMatch(/%/);
    // Core's own rules already called it destructive: the model would only repeat it.
    expect(commandOpinionWarnings(opinion, true)).toEqual([both[0]]);
    expect(commandOpinionWarnings({ ...opinion, offTaskFlag: false }, false)).toEqual([both[1]]);
  });

  it('records redacted evidence: no command and no request text, only a digest, sizes, numbers and timing', () => {
    const command = 'type C:\\Users\\alex\\.ssh\\id_rsa';
    const request = 'List the files in the project folder for Erika Hofmann';
    recordCommandReview(db, { attemptId: 'att_x', toolName: 'run_checks', command, request, review: { available: true, opinion }, outcome: 'hint', mode: 'ask' });
    recordCommandReview(db, { attemptId: 'att_x', toolName: 'run_checks', command, request, review: { available: false, reason: 'timeout', latencyMs: 3000 }, outcome: 'unavailable', mode: 'auto' });
    const rows = db.all<{ metadata: string; domain: string }>("SELECT domain, metadata FROM runtime_events WHERE eventType = 'command_second_opinion' ORDER BY sequence");
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row.domain).toBe('authorization');
      expect(row.metadata).not.toContain('id_rsa');
      expect(row.metadata).not.toContain('alex');
      expect(row.metadata).not.toContain('Erika');
    }
    expect(JSON.parse(rows[0].metadata)).toMatchObject({
      outcome: 'hint', model: 'decision:latest', step: 0.04, destructive: 0.31, offTaskFlag: true, destructiveFlag: true,
      offTaskThreshold: 0.4, destructiveThreshold: 0.2, latencyMs: 1100, commandChars: command.length, requestChars: request.length,
    });
    expect(JSON.parse(rows[0].metadata).commandDigest).toMatch(/^[0-9a-f]{16}$/);
    expect(JSON.parse(rows[1].metadata)).toMatchObject({ outcome: 'unavailable', unavailable: 'timeout', mode: 'auto' });
  });
});

describe('warming the model', () => {
  it('does nothing when off; when on, sends placeholder text only, at most every four minutes', async () => {
    const fetchImpl = answer(0.9, 0.1);
    warmCommandReview({ ...on, enabled: false }, fetchImpl, 1_000_000);
    expect(fetchImpl).not.toHaveBeenCalled();
    warmCommandReview(on, fetchImpl, 1_000_000);
    warmCommandReview(on, fetchImpl, 1_000_000 + 60_000);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String((fetchImpl.mock.calls[0] as unknown as [URL, RequestInit])[1].body)).state).toEqual({ request: 'List the files in the project folder', command: 'dir' });
    warmCommandReview(on, fetchImpl, 1_000_000 + 4 * 60_000);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
});
