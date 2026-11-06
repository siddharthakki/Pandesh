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

interface ScenarioResult {
  id: string;
  category: string;
  request: string;
  status: 'PASS' | 'FAIL' | 'BLOCKED' | 'NOT_RUN' | 'NOT_APPLICABLE';
  executionType: string;
  actualRoute: string | null;
  actualModel: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  actualOutput: string | null;
  assertions: Array<{ assertion: string; passed: boolean; detail?: string }>;
  evidencePaths: string[];
  blocker: string | null;
  failureReason: string | null;
}

interface ResultsFile {
  runAt: string;
  commit: string;
  model: string;
  summary: {
    totalCount: number;
    passedCount: number;
    failedCount: number;
    blockedCount: number;
    notRunCount: number;
    baselineCount: number;
    appendedCount: number;
  };
  results: ScenarioResult[];
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

  it('verifies that the acceptance ledger contains truthful, evidence-backed records', () => {
    const resultsPath = path.resolve(process.cwd(), 'acceptance/rwts/results.json');
    expect(fs.existsSync(resultsPath)).toBe(true);

    const resultsData: ResultsFile = JSON.parse(fs.readFileSync(resultsPath, 'utf8'));
    expect(resultsData.summary.totalCount).toBe(343);
    expect(resultsData.results.length).toBe(343);

    const progressPath = path.resolve(process.cwd(), 'acceptance/rwts/execution_progress.json');
    expect(fs.existsSync(progressPath)).toBe(true);

    const evidenceBase = path.resolve(process.cwd(), 'acceptance/rwts/evidence');
    expect(fs.existsSync(evidenceBase)).toBe(true);

    for (const r of resultsData.results) {
      // Must not contain canned generic PASS responses
      if (r.actualOutput) {
        expect(r.actualOutput).not.toContain('Processed according to governed policies');
        expect(r.actualOutput).not.toBe('Timer command recognized and handled');
      }

      // If passed, must have verified assertions and physical evidence record
      if (r.status === 'PASS') {
        expect(r.assertions.length).toBeGreaterThan(0);
        expect(r.assertions.every((a) => a.passed)).toBe(true);

        const scenarioEvDir = path.join(evidenceBase, r.id);
        const evJson = path.join(scenarioEvDir, 'evidence.json');
        expect(fs.existsSync(evJson), `Missing evidence.json for ${r.id}`).toBe(true);
      }
    }

    expect(resultsData.summary.failedCount).toBe(0);
  });

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
