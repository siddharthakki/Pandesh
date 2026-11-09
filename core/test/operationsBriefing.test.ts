import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { openCoreDatabase } from '../db/openCore';
import type { CoreDatabase } from '../db/connection';
import { createScheduledTask } from '../domain/scheduledTasks';
import { renderOperationsSection } from '../runtime/operationsBriefing';

let dir: string;
let db: CoreDatabase;
const since = '2026-11-08T05:00:00.000Z'; // the previous brief
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'opsbrief-')); db = openCoreDatabase(path.join(dir, 'core.db')).db; });
afterEach(() => { db.close?.(); fs.rmSync(dir, { recursive: true, force: true }); });

describe('"Pandesh at work" in the morning brief', () => {
  it('a quiet night is one line', () => {
    expect(renderOperationsSection(db, dir, since)).toContain('Nothing new from the watchdog, AI Radar or the revenue team');
  });

  it('reports only what is new since the last brief, from each feature\'s own records', () => {
    const stateDir = path.join(dir, 'watchdog');
    fs.mkdirSync(stateDir);
    fs.writeFileSync(path.join(stateDir, 'history.jsonl'), [
      JSON.stringify({ runId: '2026-11-07T03-00-00-000Z', commit: 'old', regressions: 5, fixed: 0, known: 0, environment: 0, complete: true }),
      JSON.stringify({ runId: '2026-11-09T03-00-00-000Z', commit: 'abc123', regressions: 0, fixed: 1, known: 2, environment: 0, complete: true }),
    ].join('\n'));
    createScheduledTask(db, { title: 'w', instruction: 'w', dailyTime: '04:00', timezone: 'Europe/Berlin', routine: 'reliability_watchdog', scope: { repoPath: dir, stateDir } });
    fs.writeFileSync(path.join(dir, 'ai-radar.json'), JSON.stringify({ findings: {
      a: { title: 'Ollama v0.40.15', url: 'https://x/a', classification: 'update_available', status: 'new', firstSeenAt: '2026-11-09T06:30:00Z', action: 'Prepare an update.' },
      b: { title: 'Old thing', url: 'https://x/b', classification: 'update_available', status: 'new', firstSeenAt: '2026-11-01T06:30:00Z' },
      c: { title: 'vLLM', url: 'https://x/c', classification: 'not_relevant', status: 'new', firstSeenAt: '2026-11-09T06:30:00Z' },
    } }));
    fs.writeFileSync(path.join(dir, 'revenue-pipeline.json'), JSON.stringify({
      catering: { leads: [{ at: '2026-11-09T07:00:00Z' }], offers: [], drafts: [{ at: '2026-11-09T07:10:00Z', status: 'awaiting_approval', kind: 'social' }], outcomes: [] },
      digital: { leads: [], offers: [], drafts: [], outcomes: [] },
    }));
    const out = renderOperationsSection(db, dir, since);
    expect(out).toContain('1 watchdog run (latest on `abc123`): no new regressions, 1 fixed, 2 known failures unchanged');
    expect(out).not.toContain('5 new regressions'); // before the last brief
    expect(out).toContain('AI Radar: 1 new finding');
    expect(out).toContain('Ollama v0.40.15');
    expect(out).not.toContain('Old thing');
    expect(out).not.toContain('vLLM'); // not actionable
    expect(out).toContain('Revenue · Catering: 1 new qualified lead; 1 new draft — 1 waiting for your approval');
    expect(out).not.toContain('Digital services');
  });
});
