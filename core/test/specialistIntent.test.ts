import { describe, expect, it } from 'vitest';
import { implicitSpecialistEnabled, implicitSpecialistRequest } from '../runtime/specialistIntent';

describe('implicit specialist routing', () => {
  it('routes read-only PC-state questions to Operations', () => {
    for (const q of ['How much free disk space do I have?', 'What is my graphics memory usage right now?', 'Which ports are listening on this PC?', 'List my installed apps', 'Check the system health', 'Which models are installed on this machine?']) {
      expect(implicitSpecialistRequest(q), q).toEqual({ agent: 'operations', rule: 'pc_state_read_only' });
    }
  });
  it('leaves everything else to the lead model: chat, status, files, web, changes and questions about agents', () => {
    for (const q of ['Good morning!', 'Thanks, that worked', 'What did we decide yesterday?', 'Summarize this folder', 'Find the latest news about Ollama', 'Delete my old downloads to free up disk space', 'Kill the process that uses the most RAM', 'Install the update', 'What can the Operations agent do?', "Don't check my disk space", 'Print the test page', '']) {
      expect(implicitSpecialistRequest(q), q).toBeNull();
    }
  });
  it('ignores very long messages and is off unless switched on', () => {
    expect(implicitSpecialistRequest(`How much free disk space do I have? ${'x'.repeat(500)}`)).toBeNull();
    expect(implicitSpecialistEnabled({})).toBe(false);
    expect(implicitSpecialistEnabled({ PANDESH_IMPLICIT_SPECIALISTS: '1' })).toBe(true);
  });
});
