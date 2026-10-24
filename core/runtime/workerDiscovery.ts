/**
 * External-worker discovery for Copilot Local.
 *
 * This is the WorkerAdapter registry seam for a worker that is not yet
 * allowed to run. Discovery reports why. It never spawns a process, never
 * inherits `process.env`, and never treats a Windows Job Object as
 * confinement: Job Objects can kill a tree and cap CPU/memory (PRE-4, PRE-7)
 * but they do not restrict filesystem writes, credential reads, or egress
 * (PRE-1, PRE-2, PRE-3). Copilot's own `/sandbox` and SDK defaults are not
 * Core confinement.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

export const COPILOT_LOCAL_WORKER_ID = 'copilot-local';

/** The loopback origin Core itself uses. Copilot BYOK must name this exactly. */
export const LOCAL_MODEL_ENDPOINT = 'http://127.0.0.1:11434';

export const CONFINEMENT_PRE_IDS = ['PRE-1', 'PRE-2', 'PRE-3', 'PRE-4'] as const;

export interface WorkerDiscoveryInput {
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  homedir?: string;
  localAppData?: string;
  pathExists?: (candidate: string) => boolean;
}

export interface CopilotBinaryDiscovery {
  resolved: boolean;
  path?: string;
  searched: string[];
}

export interface ConfinementDiscovery {
  /** True only when PRE-1 through PRE-4 can be applied at process launch. */
  ready: boolean;
  missing: readonly string[];
  detail: string;
}

export interface CopilotLocalDiscovery {
  id: typeof COPILOT_LOCAL_WORKER_ID;
  binary: CopilotBinaryDiscovery;
  confinement: ConfinementDiscovery;
  selectable: false;
  reason: string;
}

function exists(candidate: string, pathExists: (candidate: string) => boolean): boolean {
  try {
    return pathExists(candidate);
  } catch {
    return false;
  }
}

/**
 * Core does not treat this host as confinement-ready: PRE-3's single
 * loopback origin cannot be granted without an all-ports debug exemption or
 * an admin WFP filter. Filesystem, synthetic-credential, constructed-env,
 * and Job Object kill were proved by the Windows launcher prototype.
 */
export function probeConfinementBackend(platform: NodeJS.Platform = process.platform): ConfinementDiscovery {
  if (platform !== 'win32') {
    return {
      ready: false,
      missing: CONFINEMENT_PRE_IDS,
      detail:
        'Core has no launch-time filesystem, credential, or network confinement launcher (PRE-1, PRE-2, PRE-3). '
        + 'A Windows Job Object can provide the kill domain and resource limits (PRE-4, PRE-7) but is not sufficient on its own.',
    };
  }
  return {
    ready: false,
    missing: ['PRE-3'],
    detail:
      'Windows AppContainer + Job Object prototype proved workspace/scratch writes, denied outside writes, '
      + 'denied linked-worktree Git metadata, denied synthetic credential reads, a constructed environment, '
      + 'and confirmed job-tree kill. PRE-3 cannot allow only http://127.0.0.1:11434: AppContainer blocks loopback '
      + 'unless NetworkIsolationSetAppContainerConfig/LoopbackExempt opens every loopback port, and FwpmEngineOpen '
      + 'returned status 50 on this host. Copilot stays unselectable.',
  };
}

export function resolveCopilotBinary(input: WorkerDiscoveryInput = {}): CopilotBinaryDiscovery {
  const env = input.env ?? process.env;
  const platform = input.platform ?? process.platform;
  const pathExists = input.pathExists ?? ((candidate) => fs.existsSync(candidate));
  const searched: string[] = [];
  const candidates: string[] = [];

  const explicit = env.KARKEDIKHA_COPILOT_CLI?.trim() || env.COPILOT_CLI?.trim();
  if (explicit) candidates.push(explicit);

  const localAppData = input.localAppData ?? env.LOCALAPPDATA;
  if (platform === 'win32' && localAppData) {
    candidates.push(path.join(localAppData, 'GitHub CLI', 'copilot', 'copilot.exe'));
    candidates.push(path.join(localAppData, 'GitHub CLI', 'copilot.exe'));
  }

  const pathValue = env.PATH ?? env.Path ?? '';
  const exe = platform === 'win32' ? 'copilot.exe' : 'copilot';
  for (const dir of pathValue.split(path.delimiter)) {
    if (!dir) continue;
    candidates.push(path.join(dir, exe));
    if (platform === 'win32') candidates.push(path.join(dir, 'copilot.cmd'));
  }

  for (const candidate of candidates) {
    searched.push(candidate);
    if (exists(candidate, pathExists)) {
      return { resolved: true, path: candidate, searched };
    }
  }
  return { resolved: false, searched };
}

export function discoverCopilotLocal(input: WorkerDiscoveryInput = {}): CopilotLocalDiscovery {
  const confinement = probeConfinementBackend(input.platform ?? process.platform);
  const binary = resolveCopilotBinary(input);
  const parts = [confinement.detail];
  if (binary.resolved) {
    parts.push(`Copilot CLI is present at ${binary.path} but cannot run until confinement is enforceable.`);
  } else {
    parts.push('Copilot CLI is not resolvable on disk (not on PATH, not under GitHub CLI, no KARKEDIKHA_COPILOT_CLI).');
  }
  parts.push(
    `When confinement exists, Copilot must use a constructed env with COPILOT_OFFLINE=true and `
    + `COPILOT_PROVIDER_BASE_URL=${LOCAL_MODEL_ENDPOINT}, never inherited process.env or GitHub tokens.`,
  );
  return {
    id: COPILOT_LOCAL_WORKER_ID,
    binary,
    confinement,
    selectable: false,
    reason: parts.join(' '),
  };
}
