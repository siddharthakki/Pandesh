/**
 * A Pandesh Bot's identity lives in Hermes: one Hermes profile per Bot (its SOUL.md instructions, its persistent
 * memory, its model preference). This file is the only place that talks to Hermes for Bots, and it uses Hermes'
 * own supported interfaces: `hermes profile create|list|delete` and the one-shot run `hermes -p <profile> -z`.
 *
 * What a Bot run is allowed to do inside Hermes is decided here, not by the profile:
 *  - A run gets the `memory` toolset and nothing else. No terminal, file, browser, web, code or cron tools.
 *    Hermes' one-shot mode bypasses its own approvals, and an earlier evaluation saw Hermes push to git unasked,
 *    so a Bot never acts through Hermes. Core gathers the facts with its own governed read-only code and Hermes
 *    reasons over them, writes the report and remembers.
 *  - The profile is pinned to the local Ollama endpoint with no fallback provider, and the pin is checked before
 *    every run (`profileIsLocalOnly`). A profile that points anywhere else is refused, so private evidence (mail)
 *    cannot leave this PC through a Bot.
 *  - The child process gets a reduced environment: no provider keys from Core's own environment are inherited.
 *
 * A Hermes profile is a configuration boundary, not a security sandbox: Hermes runs as the same Windows user.
 * The safety here comes from giving the run no acting tool, not from the profile.
 */
import * as cp from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { HermesEngine } from '../hermesEngine';

export const BOT_PROFILE_PREFIX = 'pandesh';
/** Hermes refuses a model served with less than 64,000 tokens of context (agent_init._enforce_minimum_context). */
export const HERMES_MIN_CONTEXT = 65536;
export const DEFAULT_BOT_MODEL = 'gemma4:12b';
export const BOT_TOOLSETS = 'memory';
/** Windows limits a command line to 32,767 characters; the prompt travels as one argument. */
export const MAX_BOT_PROMPT_CHARS = 24_000;
const PROFILE_NAME = /^[a-z][a-z0-9]{2,39}$/;

export interface HermesBotProfile { name: string; path: string; description: string | null; model: string | null; localOnly: boolean; managed: boolean }
export interface HermesStatus { available: boolean; version: string | null; binary: string | null; home: string | null; reason: string | null }
export interface BotTurnResult {
  ok: boolean; text: string; error: string | null; durationMs: number; exitCode: number | null;
  usage: { model: string | null; provider: string | null; inputTokens: number | null; outputTokens: number | null; apiCalls: number | null } | null;
}

export type Exec = (file: string, args: string[], options: { timeoutMs: number; env?: NodeJS.ProcessEnv; signal?: AbortSignal }) => Promise<{ code: number | null; stdout: string; stderr: string; timedOut: boolean }>;

export const spawnExec: Exec = (file, args, options) => new Promise((resolve) => {
  let stdout = ''; let stderr = ''; let timedOut = false; let done = false;
  let child: cp.ChildProcess;
  try {
    child = cp.spawn(file, args, { env: options.env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (err) {
    resolve({ code: null, stdout: '', stderr: err instanceof Error ? err.message : String(err), timedOut: false });
    return;
  }
  const finish = (code: number | null) => { if (done) return; done = true; clearTimeout(timer); options.signal?.removeEventListener('abort', onAbort); resolve({ code, stdout, stderr, timedOut }); };
  const kill = () => {
    // Hermes starts helper processes; end the whole tree so nothing keeps the model busy after a timeout.
    if (process.platform === 'win32' && child.pid) cp.spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }).on('error', () => undefined);
    else child.kill('SIGKILL');
  };
  const timer = setTimeout(() => { timedOut = true; kill(); }, options.timeoutMs);
  const onAbort = () => { kill(); };
  options.signal?.addEventListener('abort', onAbort, { once: true });
  child.stdout?.setEncoding('utf8').on('data', (d: string) => { if (stdout.length < 400_000) stdout += d; });
  child.stderr?.setEncoding('utf8').on('data', (d: string) => { if (stderr.length < 100_000) stderr += d; });
  child.on('error', (err) => { stderr += err.message; finish(null); });
  child.on('close', (code) => finish(code));
});

export function hermesHome(env: NodeJS.ProcessEnv = process.env): string | null {
  if (env.HERMES_HOME) return env.HERMES_HOME;
  const local = env.LOCALAPPDATA || (process.platform === 'win32' ? path.join(os.homedir(), 'AppData', 'Local') : '');
  if (local) return path.join(local, 'hermes');
  return path.join(os.homedir(), '.hermes');
}

export function profileDir(name: string, env: NodeJS.ProcessEnv = process.env): string | null {
  const home = hermesHome(env);
  return home && PROFILE_NAME.test(name) ? path.join(home, 'profiles', name) : null;
}

/** A Hermes profile name for a Bot: lowercase letters and digits only (Hermes' own rule), always prefixed. */
export function botProfileName(displayName: string, taken: ReadonlySet<string> = new Set()): string {
  const slug = displayName.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '').slice(0, 24) || 'bot';
  const base = `${BOT_PROFILE_PREFIX}${slug}`;
  let name = base; let n = 2;
  while (taken.has(name)) name = `${base}${n++}`;
  return name;
}

/** Only what a Hermes run needs: paths and locale. Provider keys in Core's environment are not passed on. */
export function botProcessEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const keep = ['PATH', 'Path', 'PATHEXT', 'SystemRoot', 'SYSTEMROOT', 'SystemDrive', 'windir', 'COMSPEC', 'TEMP', 'TMP', 'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH', 'HOME', 'USERNAME',
    'LOCALAPPDATA', 'APPDATA', 'ProgramData', 'ProgramFiles', 'ProgramFiles(x86)', 'NUMBER_OF_PROCESSORS', 'PROCESSOR_ARCHITECTURE', 'OS', 'LANG', 'LC_ALL', 'TZ', 'HERMES_HOME'];
  const out: NodeJS.ProcessEnv = {};
  for (const key of keep) if (env[key] !== undefined) out[key] = env[key];
  out.PYTHONIOENCODING = 'utf-8';
  out.PYTHONUTF8 = '1';
  out.NO_COLOR = '1';
  return out;
}

/** The config a Bot profile runs with. Local Ollama only, no fallback, memory on, memory as the only toolset. */
export function botProfileConfig(input: { model: string; ollamaUrl: string }): string {
  const base = input.ollamaUrl.replace(/\/+$/, '').replace(/\/v1$/, '');
  return [
    '# Pandesh Bot profile. Written by Pandesh when the Bot was created.',
    '# Local-first: the provider is pinned to local Ollama, with no cloud provider and no fallback chain.',
    '# Pandesh runs this profile with the memory toolset only; it gathers facts itself and keeps every action.',
    'model:',
    '  provider: custom',
    `  base_url: ${base}/v1`,
    `  default: ${input.model}`,
    '  api_mode: chat_completions',
    `  context_length: ${HERMES_MIN_CONTEXT}`,
    `  ollama_num_ctx: ${HERMES_MIN_CONTEXT}`,
    'fallback_providers: []',
    'delegation:',
    '  fallback_providers: []',
    'agent:',
    '  max_turns: 8',
    '  api_max_retries: 1',
    'memory:',
    '  memory_enabled: true',
    '  user_profile_enabled: false',
    'approvals:',
    '  mode: manual',
    '  timeout: 60',
    '  cron_mode: deny',
    'platform_toolsets:',
    '  cli:',
    '    - memory',
    '  api_server:',
    '    - memory',
    'gateway:',
    '  standalone: true',
    '',
  ].join('\n');
}

function isLocalUrl(url: string): boolean {
  try { const h = new URL(url).hostname; return h === '127.0.0.1' || h === 'localhost' || h === '::1' || h === '[::1]'; } catch { return false; }
}

/** Reads a profile's config and says whether its model is pinned to a local endpoint with no fallback. */
export function readProfileRouting(configText: string): { provider: string | null; baseUrl: string | null; model: string | null; fallbacks: boolean; localOnly: boolean } {
  const lines = configText.replace(/^﻿/, '').split(/\r?\n/);
  let provider: string | null = null; let baseUrl: string | null = null; let model: string | null = null; let fallbacks = false;
  const start = lines.findIndex((l) => /^model:\s*$/.test(l));
  if (start !== -1) {
    for (let i = start + 1; i < lines.length && !/^\S/.test(lines[i]); i++) {
      const p = /^ {2}provider:\s*['"]?([^'"\s#]+)/.exec(lines[i]); if (p) provider = p[1];
      const b = /^ {2}base_url:\s*['"]?([^'"\s#]+)/.exec(lines[i]); if (b) baseUrl = b[1];
      const m = /^ {2}default:\s*['"]?([^'"\s#]+)/.exec(lines[i]); if (m) model = m[1];
    }
  }
  for (let i = 0; i < lines.length; i++) {
    const f = /^(?: {2})?fallback_providers:\s*(.*)$/.exec(lines[i]);
    if (!f) continue;
    const inline = f[1].trim();
    if (inline && inline !== '[]') fallbacks = true;
    if (!inline && /^\s+-\s+\S/.test(lines[i + 1] ?? '')) fallbacks = true;
  }
  const localOnly = provider === 'custom' && Boolean(baseUrl) && isLocalUrl(baseUrl as string) && !fallbacks;
  return { provider, baseUrl, model, fallbacks, localOnly };
}

function readDescription(dir: string): string | null {
  try {
    const m = /^description:\s*['"]?(.*?)['"]?\s*$/m.exec(fs.readFileSync(path.join(dir, 'profile.yaml'), 'utf8'));
    return m && m[1] ? m[1] : null;
  } catch { return null; }
}

export class HermesBotRuntime {
  constructor(private readonly options: { exec?: Exec; env?: NodeJS.ProcessEnv; binary?: () => string | undefined; ollamaUrl?: string } = {}) {}

  private get env(): NodeJS.ProcessEnv { return this.options.env ?? process.env; }
  private get exec(): Exec { return this.options.exec ?? spawnExec; }
  private binary(): string | undefined { return this.options.binary ? this.options.binary() : HermesEngine.findHermesBinary(); }
  private get ollamaUrl(): string { return this.options.ollamaUrl ?? this.env.KARKEDIKHA_OLLAMA_URL ?? 'http://127.0.0.1:11434'; }

  private statusCache: { at: number; value: HermesStatus } | null = null;

  /** Is Hermes installed and answering `--version`? Cached for a minute; never starts a gateway. */
  async status(force = false): Promise<HermesStatus> {
    if (!force && this.statusCache && Date.now() - this.statusCache.at < 60_000) return this.statusCache.value;
    const home = hermesHome(this.env);
    const done = (value: HermesStatus) => { this.statusCache = { at: Date.now(), value }; return value; };
    if (this.env.HERMES_ENABLED === 'false' || this.env.HERMES_ENABLED === '0') return done({ available: false, version: null, binary: null, home, reason: 'Hermes is switched off (HERMES_ENABLED=false)' });
    const binary = this.binary();
    if (!binary) return done({ available: false, version: null, binary: null, home, reason: 'Hermes is not installed on this PC' });
    const r = await this.exec(binary, ['--version'], { timeoutMs: 30_000, env: botProcessEnv(this.env) });
    const version = /Hermes Agent v([^\s]+)/.exec(r.stdout)?.[1] ?? null;
    if (r.code !== 0 || !version) return done({ available: false, version: null, binary, home, reason: `Hermes did not answer (${(r.stderr || r.stdout).trim().split('\n')[0]?.slice(0, 160) || (r.timedOut ? 'timed out' : `exit ${r.code}`)})` });
    return done({ available: true, version, binary, home, reason: null });
  }

  /** Every Hermes profile on this PC, read from the profiles folder. `managed` marks the ones Pandesh created. */
  listProfiles(): HermesBotProfile[] {
    const home = hermesHome(this.env);
    if (!home) return [];
    const root = path.join(home, 'profiles');
    let names: string[] = [];
    try { names = fs.readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name); } catch { return []; }
    return names.sort().map((name) => {
      const dir = path.join(root, name);
      let routing = { model: null as string | null, localOnly: false };
      try { routing = readProfileRouting(fs.readFileSync(path.join(dir, 'config.yaml'), 'utf8')); } catch { /* no config yet */ }
      return { name, path: dir, description: readDescription(dir), model: routing.model, localOnly: routing.localOnly, managed: fs.existsSync(path.join(dir, 'pandesh-bot.json')) };
    });
  }

  profileIsLocalOnly(name: string): { ok: boolean; reason: string | null; model: string | null } {
    const dir = profileDir(name, this.env);
    if (!dir || !fs.existsSync(dir)) return { ok: false, reason: `the Hermes profile "${name}" does not exist`, model: null };
    try {
      const r = readProfileRouting(fs.readFileSync(path.join(dir, 'config.yaml'), 'utf8'));
      if (!r.localOnly) return { ok: false, reason: `the Hermes profile "${name}" is not pinned to a local model (provider ${r.provider ?? 'unset'}, endpoint ${r.baseUrl ?? 'unset'}${r.fallbacks ? ', with fallback providers' : ''})`, model: r.model };
      return { ok: true, reason: null, model: r.model };
    } catch { return { ok: false, reason: `the Hermes profile "${name}" has no readable config`, model: null }; }
  }

  /**
   * Creates the Hermes profile for a Bot with `hermes profile create`, then writes the Bot's config and SOUL.md
   * into it. An existing profile of that name is never overwritten.
   */
  async createProfile(input: { name: string; description: string; soul: string; model?: string }): Promise<HermesBotProfile> {
    if (!PROFILE_NAME.test(input.name) || !input.name.startsWith(BOT_PROFILE_PREFIX)) throw new Error(`"${input.name}" is not a valid Bot profile name`);
    const st = await this.status();
    if (!st.available || !st.binary) throw new Error(st.reason ?? 'Hermes is not available');
    const dir = profileDir(input.name, this.env) as string;
    if (fs.existsSync(dir)) throw new Error(`a Hermes profile named "${input.name}" already exists`);
    const description = input.description.replace(/\s+/g, ' ').trim().slice(0, 200);
    const r = await this.exec(st.binary, ['profile', 'create', input.name, '--no-alias', '--no-skills', '--description', description], { timeoutMs: 120_000, env: botProcessEnv(this.env) });
    if (r.code !== 0 || !fs.existsSync(dir)) throw new Error(`Hermes could not create the profile: ${(r.stderr || r.stdout).trim().split('\n').slice(-2).join(' ').slice(0, 300) || `exit ${r.code}`}`);
    const model = input.model?.trim() || DEFAULT_BOT_MODEL;
    fs.writeFileSync(path.join(dir, 'config.yaml'), botProfileConfig({ model, ollamaUrl: this.ollamaUrl }), 'utf8');
    fs.writeFileSync(path.join(dir, 'SOUL.md'), input.soul.trim() + '\n', 'utf8');
    // A local endpoint needs no key; this placeholder stops Hermes from looking for one in the shell environment.
    fs.writeFileSync(path.join(dir, '.env'), 'OPENAI_API_KEY=local-ollama-no-key\n', 'utf8');
    fs.writeFileSync(path.join(dir, 'pandesh-bot.json'), JSON.stringify({ createdBy: 'pandesh', createdAt: new Date().toISOString() }, null, 2), 'utf8');
    return { name: input.name, path: dir, description, model, localOnly: true, managed: true };
  }

  /** Rewrites a managed Bot's instructions and model preference. Never touches a profile Pandesh did not create. */
  updateProfile(name: string, patch: { soul?: string; model?: string }): void {
    const dir = profileDir(name, this.env);
    if (!dir || !fs.existsSync(path.join(dir, 'pandesh-bot.json'))) throw new Error(`"${name}" is not a Bot profile created by Pandesh`);
    if (patch.soul !== undefined) fs.writeFileSync(path.join(dir, 'SOUL.md'), patch.soul.trim() + '\n', 'utf8');
    if (patch.model !== undefined) fs.writeFileSync(path.join(dir, 'config.yaml'), botProfileConfig({ model: patch.model.trim() || DEFAULT_BOT_MODEL, ollamaUrl: this.ollamaUrl }), 'utf8');
  }

  /** Deletes a managed Bot's Hermes profile (its memory goes with it). Explicit user action only. */
  async deleteProfile(name: string): Promise<void> {
    const dir = profileDir(name, this.env);
    if (!dir || !fs.existsSync(path.join(dir, 'pandesh-bot.json'))) throw new Error(`"${name}" is not a Bot profile created by Pandesh`);
    const st = await this.status();
    if (!st.available || !st.binary) throw new Error(st.reason ?? 'Hermes is not available');
    await this.exec(st.binary, ['profile', 'delete', name, '--yes'], { timeoutMs: 120_000, env: botProcessEnv(this.env) });
    if (fs.existsSync(dir)) throw new Error('Hermes did not remove the profile');
    await this.exec(st.binary, ['profile', 'purge-identity', name], { timeoutMs: 60_000, env: botProcessEnv(this.env) });
  }

  /** What the Bot remembers: Hermes' own memory file for the profile, read as text. */
  readMemory(name: string): { text: string; updatedAt: string | null } {
    const dir = profileDir(name, this.env);
    if (!dir) return { text: '', updatedAt: null };
    const file = path.join(dir, 'memories', 'MEMORY.md');
    try { return { text: fs.readFileSync(file, 'utf8').slice(0, 20_000), updatedAt: fs.statSync(file).mtime.toISOString() }; } catch { return { text: '', updatedAt: null }; }
  }

  readSoul(name: string): string {
    const dir = profileDir(name, this.env);
    try { return dir ? fs.readFileSync(path.join(dir, 'SOUL.md'), 'utf8').slice(0, 8000) : ''; } catch { return ''; }
  }

  /**
   * One Bot turn through Hermes: `hermes -p <profile> -z <prompt> -t memory`. Refused, without contacting Hermes,
   * when the profile is not pinned to a local model.
   */
  async runTurn(input: { profile: string; prompt: string; timeoutMs?: number; signal?: AbortSignal }): Promise<BotTurnResult> {
    const started = Date.now();
    const fail = (error: string, exitCode: number | null = null): BotTurnResult => ({ ok: false, text: '', error, durationMs: Date.now() - started, exitCode, usage: null });
    const st = await this.status();
    if (!st.available || !st.binary) return fail(st.reason ?? 'Hermes is not available');
    const local = this.profileIsLocalOnly(input.profile);
    if (!local.ok) return fail(`Not run: ${local.reason}. A Bot only runs on a local model.`);
    if (input.prompt.length > MAX_BOT_PROMPT_CHARS) return fail(`Not run: the prompt is ${input.prompt.length} characters, over the ${MAX_BOT_PROMPT_CHARS} limit`);
    const usageFile = path.join(os.tmpdir(), `pandesh-bot-usage-${process.pid}-${started}-${Math.random().toString(36).slice(2, 8)}.json`);
    const r = await this.exec(st.binary, ['-p', input.profile, '-z', input.prompt, '-t', BOT_TOOLSETS, '--usage-file', usageFile], { timeoutMs: input.timeoutMs ?? 300_000, env: botProcessEnv(this.env), signal: input.signal });
    let usage: BotTurnResult['usage'] = null;
    let failedByUsage = false;
    try {
      const u = JSON.parse(fs.readFileSync(usageFile, 'utf8')) as Record<string, unknown>;
      usage = { model: typeof u.model === 'string' ? u.model : null, provider: typeof u.provider === 'string' ? u.provider : null, inputTokens: typeof u.input_tokens === 'number' ? u.input_tokens : null, outputTokens: typeof u.output_tokens === 'number' ? u.output_tokens : null, apiCalls: typeof u.api_calls === 'number' ? u.api_calls : null };
      failedByUsage = u.failed === true || u.completed === false;
    } catch { /* no usage report */ } finally { try { fs.unlinkSync(usageFile); } catch { /* already gone */ } }
    const text = r.stdout.trim();
    if (r.timedOut) return { ...fail('Hermes did not finish in time and was stopped', r.code), usage };
    if (input.signal?.aborted) return { ...fail('The run was cancelled', r.code), usage };
    if (r.code !== 0 || failedByUsage || !text) {
      const detail = (text || r.stderr).trim().split('\n').find((l) => l.trim())?.slice(0, 200) ?? `exit ${r.code}`;
      return { ...fail(`Hermes could not complete the turn: ${detail}`, r.code), usage };
    }
    return { ok: true, text, error: null, durationMs: Date.now() - started, exitCode: r.code, usage };
  }
}

export const sharedHermesBots = new HermesBotRuntime();
