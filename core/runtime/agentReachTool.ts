/**
 * `agent_reach`: read-only public lookups through the Agent Reach command-line tool, when the person installed it
 * (`<data dir>/tools/agent-reach.json`). Deliberately narrow:
 *  - an allowlist of (channel, action) pairs that need no login and no browser; everything else is refused here
 *    (login, add, remove, setup, update, configure, uninstall and the browser channels are never reachable);
 *  - no shell: the program is started directly with fixed arguments;
 *  - an isolated home folder (its logins, caches and settings live there, never in the person's profile), and the
 *    GitHub CLI's own login is hidden so the lookup is anonymous;
 *  - a search query must pass the same public-query guard as web research; a link must be a public http(s) address;
 *  - the result is capped, stripped of upstream raw data, and labelled untrusted.
 * Consent is asked by the caller (a card, like web research); this module only validates and runs.
 */
import { execFile } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

export interface AgentReachConfig { command: string[]; home: string }

/** channel -> actions that read public content without a login. */
export const AGENT_REACH_ALLOWED: Readonly<Record<string, readonly string[]>> = {
  web: ['read'],
  github: ['search', 'read'],
  youtube: ['search', 'read', 'subtitle'],
  reddit: ['search', 'read'],
  v2ex: ['hot', 'node', 'read', 'user'],
};

export const AGENT_REACH_TIMEOUT_MS = 90_000;
const MAX_ITEM_CHARS = 4_000;
const MAX_TOTAL_CHARS = 16_000;

export function readAgentReachConfig(dataDir: string | undefined): AgentReachConfig | null {
  if (!dataDir) return null;
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(dataDir, 'tools', 'agent-reach.json'), 'utf8')) as { command?: unknown; home?: unknown };
    const command = Array.isArray(raw.command) ? raw.command.map(String).filter(Boolean) : [];
    const home = typeof raw.home === 'string' ? raw.home : '';
    if (command.length === 0 || !home || !fs.existsSync(command[0]) || !fs.existsSync(home)) return null;
    return { command, home };
  } catch { return null; }
}

const PRIVATE_HOST = /^(?:localhost|.*\.local|.*\.internal|.*\.lan|.*\.home|.*\.corp)$/i;

/** A public http(s) address only: no credentials in it, no local or private host, no non-standard scheme. */
export function isPublicUrl(value: string): boolean {
  let u: URL;
  try { u = new URL(value); } catch { return false; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
  if (u.username || u.password) return false;
  const host = u.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (!host || PRIVATE_HOST.test(host) || !host.includes('.') && !host.includes(':')) return false;
  if (/^(?:127\.|10\.|0\.|169\.254\.|192\.168\.|172\.(?:1[6-9]|2\d|3[01])\.)/.test(host)) return false;
  if (host === '::1' || /^(?:fc|fd|fe80)/i.test(host)) return false;
  return true;
}

export interface AgentReachCall { channel: string; action: string; target: string; limit: number }

export type AgentReachValidation = { ok: true; call: AgentReachCall; isSearch: boolean } | { ok: false; reason: string };

export function validateAgentReachCall(args: { channel?: unknown; action?: unknown; target?: unknown; limit?: unknown }): AgentReachValidation {
  const channel = String(args.channel ?? '').trim().toLowerCase();
  const action = String(args.action ?? '').trim().toLowerCase();
  const target = String(args.target ?? '').trim();
  const allowed = AGENT_REACH_ALLOWED[channel];
  if (!allowed) return { ok: false, reason: `channel "${channel}" is not available. Public channels: ${Object.keys(AGENT_REACH_ALLOWED).join(', ')} (no login or browser channels).` };
  if (!allowed.includes(action)) return { ok: false, reason: `"${action}" is not an allowed action for ${channel}. Allowed: ${allowed.join(', ')}.` };
  if (!target && action !== 'hot') return { ok: false, reason: 'A target is required (a search query, or a link / name to read).' };
  if (target.length > 500 || /[\r\n\0]/.test(target)) return { ok: false, reason: 'The target is too long or contains control characters.' };
  if (target.startsWith('-')) return { ok: false, reason: 'The target may not start with "-".' };
  const isSearch = action === 'search';
  if (!isSearch && (action === 'read' || action === 'subtitle') && channel !== 'github' && !isPublicUrl(target)) return { ok: false, reason: 'Reading needs a public http(s) link (no local address, no credentials in the link).' };
  if (channel === 'github' && action === 'read' && !isPublicUrl(target) && !/^[\w.-]+\/[\w.-]+$/.test(target)) return { ok: false, reason: 'GitHub read needs owner/repo or a github.com link.' };
  const limit = Math.min(10, Math.max(1, Math.floor(Number(args.limit ?? 5)) || 5));
  return { ok: true, call: { channel, action, target, limit }, isSearch };
}

export interface AgentReachResult { ok: boolean; text: string; items: number; channel: string; action: string; backend?: string; errorCode?: string }

function isolatedEnv(home: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const k of ['PATH', 'Path', 'SystemRoot', 'SYSTEMROOT', 'ComSpec', 'PATHEXT', 'TEMP', 'TMP', 'LANG']) if (process.env[k] !== undefined) env[k] = process.env[k];
  env.HOME = home; env.USERPROFILE = home;
  env.APPDATA = path.join(home, 'AppData', 'Roaming'); env.LOCALAPPDATA = path.join(home, 'AppData', 'Local'); // hides the GitHub CLI login
  env.GH_TOKEN = ''; env.GITHUB_TOKEN = ''; env.PYTHONUTF8 = '1';
  return env;
}

/** Runs one validated lookup. Never throws; a failure is reported as such, with the tool's own error code. */
export function runAgentReach(config: AgentReachConfig, call: AgentReachCall, opts: { timeoutMs?: number } = {}): Promise<AgentReachResult> {
  const [exe, ...base] = config.command;
  const argv = [...base, call.channel, call.action, ...(call.target ? [call.target] : []), ...(call.action !== 'read' && call.action !== 'subtitle' ? ['--limit', String(call.limit)] : [])];
  return new Promise((resolve) => {
    execFile(exe, argv, { env: isolatedEnv(config.home), cwd: config.home, timeout: opts.timeoutMs ?? AGENT_REACH_TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024, windowsHide: true, shell: false }, (err, stdout) => {
      let parsed: any = null;
      try { parsed = JSON.parse(String(stdout || '').trim()); } catch { /* not JSON */ }
      if (!parsed || typeof parsed !== 'object') {
        const why = err ? (err as NodeJS.ErrnoException).code === 'ETIMEDOUT' || (err as { killed?: boolean }).killed ? 'timed out' : err.message.split('\n')[0].slice(0, 160) : 'no readable output';
        return resolve({ ok: false, text: `Agent Reach did not return a result (${why}). Nothing was read.`, items: 0, channel: call.channel, action: call.action });
      }
      if (!parsed.ok) {
        const e = parsed.error ?? {};
        return resolve({ ok: false, text: `Agent Reach could not read it: ${String(e.code ?? 'ERROR')}${e.message ? ` — ${String(e.message).slice(0, 200)}` : ''}${e.hint ? `. ${String(e.hint).slice(0, 200)}` : ''}. Nothing was read.`, items: 0, channel: call.channel, action: call.action, errorCode: String(e.code ?? 'ERROR') });
      }
      const items = Array.isArray(parsed.items) ? parsed.items : [];
      let total = 0;
      const lines: string[] = [];
      for (const [i, it] of items.entries()) {
        const text = String(it?.text ?? '').slice(0, MAX_ITEM_CHARS);
        const block = `[${i + 1}] ${String(it?.title ?? '').slice(0, 200)}\n${String(it?.url ?? '')}${it?.author ? ` — ${String(it.author).slice(0, 80)}` : ''}${it?.published_at ? ` — ${String(it.published_at).slice(0, 40)}` : ''}\n${text}`;
        if (total + block.length > MAX_TOTAL_CHARS) { lines.push(`[… ${items.length - i} more result(s) omitted for length]`); break; }
        total += block.length; lines.push(block);
      }
      resolve({ ok: true, text: lines.join('\n\n') || 'The lookup succeeded but returned no items.', items: items.length, channel: call.channel, action: call.action, backend: typeof parsed.backend === 'string' ? parsed.backend : undefined });
    });
  });
}
