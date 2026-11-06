import { describe, expect, it } from 'vitest';
import {
  isCloudPublicResearchRequest,
  derivePublicResearchQueries,
  sanitizePublicResearchObjective,
  buildCloudPublicResearchMessages,
  isStubReply,
} from '../runtime/cloudPublicResearch';
import { EverydayTimerManager } from '../../apps/desktop/src/host/everydayTimerManager';
import { parseEverydayIntent } from '../../apps/desktop/src/host/everydayToolsIntent';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

describe('Privacy and Everyday Timer Fixes (Phase B Safety)', () => {
  it('strictly isolates private CV canary from derived public queries and cloud messages', () => {
    const CANARY = 'PRIVATE_CV_CANARY_RWTS_2026';
    const mixedRequest = `Evaluate my local CV at C:\\Users\\siddh\\Documents\\my_cv.pdf (${CANARY}) and find five currently open English-speaking Product Manager positions near Ulm Germany paying €90,000–€100,000.`;

    expect(isCloudPublicResearchRequest(mixedRequest)).toBe(true);

    const sanitized = sanitizePublicResearchObjective(mixedRequest);
    expect(sanitized).not.toContain(CANARY);
    expect(sanitized).not.toContain('my_cv.pdf');
    expect(sanitized).not.toContain('C:\\Users');
    expect(sanitized.toLowerCase()).not.toContain('my cv');
    expect(sanitized.toLowerCase()).toContain('product manager');
    expect(sanitized.toLowerCase()).toContain('ulm');

    const queries = derivePublicResearchQueries(mixedRequest);
    expect(queries.length).toBeGreaterThan(0);
    for (const q of queries) {
      expect(q).not.toContain(CANARY);
      expect(q).not.toContain('my_cv.pdf');
      expect(q).not.toContain('CV');
      expect(q).not.toContain('resume');
      expect(q.toLowerCase()).toContain('product manager');
    }

    const messages = buildCloudPublicResearchMessages(mixedRequest, '=== Evidence ===\n[S1] Title: PM at Tech\nURL: https://tech.example.com/job/1\nEvidence: PM role in Ulm.');
    for (const msg of messages) {
      expect(msg.content).not.toContain(CANARY);
      expect(msg.content).not.toContain('my_cv.pdf');
      expect(msg.content.toLowerCase()).not.toContain('evaluate my local cv');
    }
  });

  it('correctly resolves and targets specific timers in a two-timer setup', async () => {
    const tmpDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pandesh-timer-test-'));
    const manager = new EverydayTimerManager({ dataDir: tmpDataDir });

    try {
      // Start short timer (10s) and long timer (5m)
      const shortRes = manager.startTimer(10_000, 'short timer', 'convo-1');
      const longRes = manager.startTimer(300_000, 'long timer', 'convo-1');

      expect(shortRes.timer.state).toBe('running');
      expect(longRes.timer.state).toBe('running');
      expect(shortRes.timer.id).not.toBe(longRes.timer.id);

      // Verify intent parser extracts target from "pause timer id:..."
      const parsedId = parseEverydayIntent(`pause timer id:${shortRes.timer.id}`);
      expect(parsedId).not.toBeNull();
      expect(parsedId?.kind).toBe('pause_timer');
      expect((parsedId as any)?.target).toBe(shortRes.timer.id);

      // Pause short timer using stable ID
      const pauseResult = manager.pauseTimer(`id:${shortRes.timer.id}`);
      expect(pauseResult.success).toBe(true);
      expect(pauseResult.timer?.id).toBe(shortRes.timer.id);
      expect(pauseResult.timer?.state).toBe('paused');

      // Crucial assertion: long timer MUST still be running!
      const active = manager.listActiveTimers();
      const shortActive = active.find((t) => t.id === shortRes.timer.id);
      const longActive = active.find((t) => t.id === longRes.timer.id);

      expect(shortActive?.state).toBe('paused');
      expect(longActive?.state).toBe('running');

      // Resume short timer
      const resumeResult = manager.resumeTimer(`id:${shortRes.timer.id}`);
      expect(resumeResult.success).toBe(true);
      expect(resumeResult.timer?.state).toBe('running');

      // Test "short" ordinal targeting
      const pauseByShort = manager.pauseTimer('short');
      expect(pauseByShort.success).toBe(true);
      expect(pauseByShort.timer?.id).toBe(shortRes.timer.id);

      // Cancel short timer
      const stopResult = manager.stopTimer(`id:${shortRes.timer.id}`);
      expect(stopResult.success).toBe(true);
      expect(stopResult.timer?.state).toBe('cancelled');

      // Long timer still running
      const finalActive = manager.listActiveTimers();
      expect(finalActive.some((t) => t.id === longRes.timer.id && t.state === 'running')).toBe(true);
      expect(finalActive.some((t) => t.id === shortRes.timer.id && t.state === 'running')).toBe(false);
    } finally {
      manager.dispose();
      fs.rmSync(tmpDataDir, { recursive: true, force: true });
    }
  });
});
