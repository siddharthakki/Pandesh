import { describe, expect, it } from 'vitest';
import * as path from 'node:path';
import {
  COPILOT_LOCAL_WORKER_ID,
  LOCAL_MODEL_ENDPOINT,
  discoverCopilotLocal,
  probeConfinementBackend,
  resolveCopilotBinary,
} from '../runtime/workerDiscovery';
import { listWorkerOptions, resolveWorkerProfile } from '../runtime/localCoreQuestion';

describe('Copilot Local discovery', () => {
  it('never reports confinement ready while the PRE-3 loopback origin exception is missing', () => {
    const confinement = probeConfinementBackend('win32');
    expect(confinement.ready).toBe(false);
    expect(confinement.missing).toEqual(['PRE-3']);
    expect(confinement.detail).toMatch(/LoopbackExempt/);
    expect(confinement.detail).toMatch(/FwpmEngineOpen/);
  });

  it('does not treat a missing binary as resolved', () => {
    const binary = resolveCopilotBinary({
      env: { PATH: 'C:\\empty-path', LOCALAPPDATA: 'C:\\empty-appdata' },
      platform: 'win32',
      pathExists: () => false,
    });
    expect(binary.resolved).toBe(false);
    expect(binary.searched.some((candidate) => candidate.endsWith('copilot.exe'))).toBe(true);
  });

  it('resolves KARKEDIKHA_COPILOT_CLI when that path exists, and still refuses selection', () => {
    const fake = path.join('C:', 'core-owned', 'copilot.exe');
    const discovery = discoverCopilotLocal({
      env: { KARKEDIKHA_COPILOT_CLI: fake, PATH: '' },
      platform: 'win32',
      pathExists: (candidate) => candidate === fake,
    });
    expect(discovery.binary.resolved).toBe(true);
    expect(discovery.binary.path).toBe(fake);
    expect(discovery.selectable).toBe(false);
    expect(discovery.confinement.ready).toBe(false);
    expect(discovery.reason).toMatch(/cannot run until confinement is enforceable/);
    expect(discovery.reason).toContain(LOCAL_MODEL_ENDPOINT);

    const option = listWorkerOptions({
      env: { KARKEDIKHA_COPILOT_CLI: fake, PATH: '' },
      platform: 'win32',
      pathExists: (candidate) => candidate === fake,
    }).find((item) => item.id === COPILOT_LOCAL_WORKER_ID);
    expect(option?.selectable).toBe(false);

    const resolved = resolveWorkerProfile(COPILOT_LOCAL_WORKER_ID, {
      env: { KARKEDIKHA_COPILOT_CLI: fake, PATH: '' },
      platform: 'win32',
      pathExists: (candidate) => candidate === fake,
    });
    expect(resolved.ok).toBe(false);
  });

  it('names the loopback Ollama origin Copilot must use, not a GitHub or cloud endpoint', () => {
    const discovery = discoverCopilotLocal({ env: { PATH: '' }, platform: 'win32', pathExists: () => false });
    expect(discovery.reason).toContain('COPILOT_OFFLINE=true');
    expect(discovery.reason).toContain(`COPILOT_PROVIDER_BASE_URL=${LOCAL_MODEL_ENDPOINT}`);
    expect(discovery.reason).not.toMatch(/api\.github\.com/);
  });
});
