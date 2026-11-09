/**
 * External coding agents Pandesh can hand a coding job to (2026-11-09).
 *
 * Pandesh already drives Pi (its own engine), OpenCode (delegate_to_opencode) and Hermes (local gateway). This adds the
 * other agent CLIs installed on this PC behind ONE governed tool, `delegate_to_coding_agent`, with the same rules as
 * OpenCode: the selected folder only, an approval card per run, a wall-clock budget, and Core's own verification of
 * what changed afterwards (files on disk, covering tests, output checks) — never the agent's word.
 *
 * Locality decides the default:
 *  - local  (runs against this PC's Ollama models; nothing leaves the PC): enabled when installed.
 *  - cloud  (sends the objective and the files it reads to a vendor; may cost money): DISABLED until the user enables
 *    it in <dataDir>/coding-agents.json, and its card says exactly where the code goes.
 *
 * Pure: specs, argument building, PATH discovery and settings. Spawning stays in the engine (architecture guard).
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

export type AgentLocality = 'local' | 'cloud';

export interface CodingAgentSpec {
  id: string;
  name: string;
  /** Executable name looked up on PATH (without extension). */
  command: string;
  locality: AgentLocality;
  /** Where the code goes, for the approval card. */
  dataFlow: string;
  /** Non-interactive invocation in `dir` for `objective`, using `model` when the agent runs locally. */
  args(objective: string, dir: string, model: string): string[];
  /** Extra environment for the run. */
  env?(model: string): Record<string, string>;
  /** What the agent is good at, for the model's tool description. */
  strengths: string;
}

const OLLAMA = process.env.KARKEDIKHA_OLLAMA_URL || 'http://127.0.0.1:11434';

export const CODING_AGENTS: CodingAgentSpec[] = [
  {
    id: 'aider',
    name: 'Aider',
    command: 'aider',
    locality: 'local',
    dataFlow: 'runs on this PC with your local Ollama model; nothing leaves the PC',
    // --no-git: Pandesh verifies from the files on disk; Aider must not commit in the user's folder.
    args: (objective, _dir, model) => ['--model', `ollama_chat/${model}`, '--message', objective, '--yes-always', '--no-git', '--no-auto-commits', '--no-pretty', '--no-stream', '--map-tokens', '1024', '--no-show-model-warnings', '--no-check-update', '--analytics-disable'],
    env: () => ({ OLLAMA_API_BASE: OLLAMA }),
    strengths: 'precise edits to existing files and small multi-file changes',
  },
  {
    id: 'codex',
    name: 'Codex CLI (local mode)',
    command: 'codex',
    locality: 'local',
    dataFlow: 'runs on this PC with your local Ollama model (--oss); commands run in a workspace-write sandbox',
    args: (objective, dir, model) => ['exec', '--oss', '--local-provider', 'ollama', '-m', model, '-s', 'workspace-write', '-C', dir, '--skip-git-repo-check', objective],
    strengths: 'building a small program end to end with its own shell steps, sandboxed to the folder',
  },
  {
    id: 'claude-code',
    name: 'Claude Code',
    command: 'claude',
    locality: 'cloud',
    dataFlow: "sends the task and the files it reads to Anthropic's cloud (uses your Claude account and may cost money)",
    // acceptEdits: file edits in the folder are allowed; shell commands still need its own permission, which -p cannot grant.
    args: (objective) => ['-p', objective, '--output-format', 'json', '--permission-mode', 'acceptEdits'],
    strengths: 'hard, multi-file coding and debugging tasks',
  },
  {
    id: 'cline',
    name: 'Cline CLI',
    command: 'cline',
    locality: 'cloud',
    dataFlow: "sends the task and the files it reads to Cline's default cloud provider unless configured otherwise; it auto-approves its own commands",
    args: (objective, dir) => ['--json', '-c', dir, objective],
    strengths: 'general coding tasks',
  },
];

export interface CodingAgentSettings { enabled: Record<string, boolean> }

/** Local agents are on by default when installed; cloud agents only when the user switched them on. */
export function readCodingAgentSettings(dataDir: string | undefined | null): CodingAgentSettings {
  try {
    if (dataDir) {
      const raw = JSON.parse(fs.readFileSync(path.join(dataDir, 'coding-agents.json'), 'utf8')) as Partial<CodingAgentSettings>;
      if (raw && typeof raw.enabled === 'object' && raw.enabled) return { enabled: raw.enabled as Record<string, boolean> };
    }
  } catch { /* no settings: defaults */ }
  return { enabled: {} };
}

export function isAgentEnabled(spec: CodingAgentSpec, settings: CodingAgentSettings): boolean {
  const explicit = settings.enabled[spec.id];
  if (explicit !== undefined) return explicit === true;
  return spec.locality === 'local';
}

/** Absolute path of an executable on PATH (Windows: .exe, then .cmd), or null. Spawned without a shell. */
export function findOnPath(command: string, envPath = process.env.PATH ?? '', platform = process.platform): string | null {
  const exts = platform === 'win32' ? ['.exe', '.cmd', '.bat'] : [''];
  for (const dir of envPath.split(path.delimiter).filter(Boolean)) {
    for (const ext of exts) {
      const candidate = path.join(dir, command + ext);
      try { if (fs.statSync(candidate).isFile()) return candidate; } catch { /* next */ }
    }
  }
  return null;
}

export interface AvailableAgent { spec: CodingAgentSpec; executable: string; enabled: boolean }

export function discoverCodingAgents(dataDir: string | undefined | null, envPath?: string): AvailableAgent[] {
  const settings = readCodingAgentSettings(dataDir);
  return CODING_AGENTS
    .map((spec) => ({ spec, executable: findOnPath(spec.command, envPath), enabled: isAgentEnabled(spec, settings) }))
    .filter((a): a is AvailableAgent => a.executable !== null);
}

/** A .cmd/.bat shim cannot be spawned without a shell on Windows; it is run through cmd.exe with quoted arguments. */
export function spawnPlan(executable: string, args: string[]): { file: string; args: string[]; shellQuoted: boolean } {
  if (/\.(?:cmd|bat)$/i.test(executable)) {
    // cmd.exe expands %VAR% even inside quotes and ends the line at a newline: neither may reach it from a task text.
    const quote = (a: string) => `"${a.replace(/[\r\n]+/g, ' ').replace(/%/g, ' percent ').replace(/"/g, '""')}"`;
    return { file: process.env.ComSpec || 'cmd.exe', args: ['/d', '/s', '/c', [quote(executable), ...args.map(quote)].join(' ')], shellQuoted: true };
  }
  return { file: executable, args, shellQuoted: false };
}
