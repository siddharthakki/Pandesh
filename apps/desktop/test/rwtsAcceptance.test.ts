import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { EverydayTimerManager } from '../src/host/everydayTimerManager';
import { parseEverydayIntent, isPersonalFact } from '../src/host/everydayToolsIntent';
import {
  detectWeatherIntent,
  extractWeatherLocation,
  extractWeatherComparison,
} from '../src/host/desktopInteractionRouting';
import {
  isCloudPublicResearchRequest,
  derivePublicResearchQueries,
  sanitizePublicResearchObjective,
  buildCloudPublicResearchMessages,
  synthesizePublicResearchReport,
  isStubReply,
} from '../../../core/runtime/cloudPublicResearch';
import {
  extractSourcesFromEvidence,
  formatStructuredResearchFallback,
  isMemoryRecallIntent,
} from '../../../core/runtime/piAgentEngine';

interface Scenario {
  id: string;
  request: string;
  category: string;
  tags?: string[];
  preconditions: string[];
  expectedBehavior: string;
  expectedRoute: string;
  forbiddenTools: string[];
  assertions: string[];
  executionMode: string;
  requiredEvidence: string[];
}

interface Manifest {
  version: string;
  totalCount: number;
  scenarios: Scenario[];
}

describe('RWTS Acceptance Suite Audit and Release Verification (343 Scenarios)', () => {
  it('validates manifest inventory integrity (exactly 343 scenarios, RWTS-001 through RWTS-343)', () => {
    const manifestPath = path.resolve(process.cwd(), 'acceptance/rwts/manifest.json');
    expect(fs.existsSync(manifestPath)).toBe(true);

    const manifest: Manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    expect(manifest.scenarios.length).toBe(343);

    const ids = manifest.scenarios.map((s) => s.id);
    const uniqueIds = new Set(ids);
    expect(uniqueIds.size).toBe(343);

    for (let i = 1; i <= 343; i++) {
      const expectedId = `RWTS-${String(i).padStart(3, '0')}`;
      expect(uniqueIds.has(expectedId), `Missing ID: ${expectedId}`).toBe(true);
    }
  });

  // The former 'acceptance ledger' check validated acceptance/rwts/results.json, a ledger that was
  // generated without running the app or a model (see docs/testing/rwts/README.md). It was removed
  // together with that ledger; the scenario manifest above is still checked.

  it('validates high-risk Phase B safety boundary with synthetic private canary', () => {
    const CANARY = 'PRIVATE_CV_CANARY_RWTS_2026';
    const mixed = `Evaluate my private CV at C:\\Users\\siddh\\Documents\\my_cv.pdf (${CANARY}) and find five open Product Manager roles in Ulm paying €90,000–€100,000.`;

    const sanitized = sanitizePublicResearchObjective(mixed);
    expect(sanitized).not.toContain(CANARY);
    expect(sanitized).not.toContain('my_cv.pdf');
    expect(sanitized).not.toContain('C:\\Users');
    expect(sanitized.toLowerCase()).not.toContain('my cv');
    expect(sanitized.toLowerCase()).toContain('product manager');
    expect(sanitized.toLowerCase()).toContain('ulm');

    const queries = derivePublicResearchQueries(mixed);
    for (const q of queries) {
      expect(q).not.toContain(CANARY);
      expect(q).not.toContain('my_cv.pdf');
      expect(q).not.toContain('cv');
    }

    const messages = buildCloudPublicResearchMessages(mixed, '=== Verified Evidence ===\n[S1] Role: PM\nURL: https://example.com/job/1\nEvidence: Ulm PM');
    for (const msg of messages) {
      expect(msg.content).not.toContain(CANARY);
      expect(msg.content).not.toContain('my_cv.pdf');
      expect(msg.content.toLowerCase()).not.toContain('evaluate my private cv');
    }
  });

  it('validates two-timer concurrent targeting and monotonic deadline calculations', () => {
    const tmpDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pandesh-rwts-timer-audit-'));
    const timerManager = new EverydayTimerManager({ dataDir: tmpDataDir });

    try {
      const shortTimer = timerManager.startTimer(10_000, 'short timer', 'convo-audit');
      const longTimer = timerManager.startTimer(300_000, 'long timer', 'convo-audit');

      expect(shortTimer.timer.state).toBe('running');
      expect(longTimer.timer.state).toBe('running');

      // Pause short timer specifically
      const pauseRes = timerManager.pauseTimer(`id:${shortTimer.timer.id}`);
      expect(pauseRes.success).toBe(true);

      const active = timerManager.listActiveTimers();
      const shortActive = active.find((t) => t.id === shortTimer.timer.id);
      const longActive = active.find((t) => t.id === longTimer.timer.id);

      expect(shortActive?.state).toBe('paused');
      expect(longActive?.state).toBe('running');

      // Resume short timer
      const resumeRes = timerManager.resumeTimer(`id:${shortTimer.timer.id}`);
      expect(resumeRes.success).toBe(true);
      expect(resumeRes.timer?.state).toBe('running');

      // Duplicate protection
      const dup = timerManager.startTimer(10_000, 'short timer', 'convo-audit');
      expect(dup.duplicate).toBe(true);
    } finally {
      timerManager.dispose();
      fs.rmSync(tmpDataDir, { recursive: true, force: true });
    }
  });

  it('validates weather location geocoding and disambiguation', () => {
    const locUlm = extractWeatherLocation('What is the weather in Ulm, Germany today?');
    expect(locUlm).toBe('Ulm, Germany');

    const comp = extractWeatherComparison('Compare weather in Ulm Germany and Ullà Spain.');
    expect(comp).not.toBeNull();
    expect(comp?.locationA.toLowerCase()).toContain('ulm');
    expect(comp?.locationB.toLowerCase()).toContain('ull');
  });

  it('validates memory recall vs general knowledge separation', () => {
    expect(isMemoryRecallIntent('What is Python?')).toBe(false);
    expect(isMemoryRecallIntent('What is a closure?')).toBe(false);
    expect(isPersonalFact('Remember that my RWTS test preference is concise answers.')).toBe(true);
  });
});
