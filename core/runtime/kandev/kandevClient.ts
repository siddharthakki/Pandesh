/**
 * Thin client for a local Kandev control plane (https://github.com/kdlbs/kandev, AGPL-3.0).
 *
 * Kandev runs as a separate, unmodified local process (see scripts/kandev/). KKD talks to it only
 * through its public surfaces: the external MCP endpoint (task/dependency/permission tools), a few
 * REST routes, and three WebSocket actions (stop, relaunch, follow-up message). No Kandev code is
 * copied or linked into KKD.
 */
import { WebSocket } from 'ws';
import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawn } from 'node:child_process';

export interface KandevTask {
  id: string;
  title: string;
  state: string;
  workflow_step_id?: string;
  external_id?: string;
  updated_at?: string;
  created_at?: string;
}

export interface KandevSession {
  id: string;
  state: string;
  worktree_path?: string;
  worktree_branch?: string;
  base_branch?: string;
  agent_profile_id?: string;
  error_message?: string;
  updated_at?: string;
}

export interface KandevPermission {
  pending_id: string;
  request_id: string;
  session_id: string;
  task_id: string;
  title?: string;
  action?: { type?: string; path?: string; command?: string; description?: string };
  options?: Array<{ kind: string; option_id: string; name?: string }>;
}

export class KandevUnavailableError extends Error {}

/**
 * Kandev has no authentication, so KKD only ever talks to it on loopback. Any 127.0.0.0/8 address is
 * loopback; the launcher picks a random one (see readKandevEndpoint) so no well-known address exists.
 */
export function assertLoopbackUrl(url: string): void {
  const host = new URL(url).hostname.replace(/^\[|\]$/g, '');
  if (!(/^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host) || host === '::1' || host === 'localhost')) {
    throw new Error(`Refusing Kandev at ${url}: Kandev runs without authentication and must be on 127.0.0.1`);
  }
}

export function kandevHome(): string {
  return process.env.KARKEDIKHA_KANDEV_HOME || path.join(os.homedir(), '.kkd-kandev');
}

/**
 * Kandev has no authentication and its origin check accepts any request whose Origin equals its Host
 * (so a DNS-rebinding page gets full access to a well-known address). The launcher therefore binds it to
 * a random loopback address and port per start and records them in a file only the current user can
 * read. Reading that file is how Core "authenticates": the address is the capability.
 */
export function readKandevEndpoint(): string | null {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(kandevHome(), 'endpoint.json'), 'utf8')) as { url?: string };
    if (!raw.url) return null;
    assertLoopbackUrl(raw.url);
    return raw.url;
  } catch {
    return null;
  }
}

/** scripts/kandev next to the running Core bundle (out-core/core.js) or the repo checkout. */
function kandevScriptsDir(): string | null {
  const candidates = [
    process.env.KARKEDIKHA_KANDEV_SCRIPTS,
    process.argv[1] ? path.resolve(path.dirname(process.argv[1]), '..', 'scripts', 'kandev') : undefined,
    path.resolve(process.cwd(), 'scripts', 'kandev'),
  ].filter((p): p is string => Boolean(p));
  return candidates.find(p => fs.existsSync(path.join(p, 'start-kandev.ps1'))) ?? null;
}

export class KandevClient {
  private mcpSession: string | null = null;

  private readonly explicitUrl: string | null;

  constructor(baseUrl?: string) {
    this.explicitUrl = baseUrl ?? process.env.KARKEDIKHA_KANDEV_URL ?? null;
    if (this.explicitUrl) assertLoopbackUrl(this.explicitUrl);
  }

  /** Re-read on every use: each Kandev start picks a new address. */
  get baseUrl(): string {
    const url = this.explicitUrl ?? readKandevEndpoint();
    if (!url) throw new KandevUnavailableError('Kandev is not running (no endpoint recorded)');
    return url;
  }

  /**
   * Starts Kandev through scripts/kandev/start-kandev.ps1 when it is not running (isolated worker profile,
   * loopback-only self-check). The user never has to manage Kandev for a dispatch.
   */
  async ensureRunning(): Promise<void> {
    if (await this.healthy()) return;
    const dir = kandevScriptsDir();
    if (!dir || process.platform !== 'win32') throw new KandevUnavailableError('Kandev is not running and its launcher (scripts/kandev/start-kandev.ps1) was not found');
    const out = await new Promise<{ code: number | null; text: string }>((resolve) => {
      const child = spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(dir, 'start-kandev.ps1')], { windowsHide: true });
      let text = '';
      child.stdout.on('data', d => { text += d; });
      child.stderr.on('data', d => { text += d; });
      // `exit`, not `close`: Kandev inherits the launcher's stdout/stderr, so those pipes stay open for as long as Kandev runs.
      child.on('exit', code => setTimeout(() => resolve({ code, text }), 250));
      child.on('error', err => resolve({ code: -1, text: err.message }));
    });
    if (out.code !== 0 || !(await this.healthy())) throw new KandevUnavailableError(`Could not start Kandev: ${out.text.trim().slice(-400)}`);
  }

  async healthy(): Promise<boolean> {
    try {
      const res = await fetch(`${this.baseUrl}/health`, { signal: AbortSignal.timeout(2_000) });
      return res.ok;
    } catch {
      return false;
    }
  }

  // --- external MCP (streamable HTTP, JSON-RPC) ---

  private async rpc(method: string, params: unknown, notify = false): Promise<any> {
    const headers: Record<string, string> = { 'content-type': 'application/json', accept: 'application/json, text/event-stream' };
    if (this.mcpSession) headers['mcp-session-id'] = this.mcpSession;
    const body = notify ? { jsonrpc: '2.0', method, params } : { jsonrpc: '2.0', id: randomUUID(), method, params };
    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}/mcp`, { method: 'POST', headers, body: JSON.stringify(body), signal: AbortSignal.timeout(30_000) });
    } catch (err) {
      throw new KandevUnavailableError(`Kandev is not reachable at ${this.baseUrl}: ${(err as Error).message}`);
    }
    this.mcpSession = res.headers.get('mcp-session-id') ?? this.mcpSession;
    if (notify) return null;
    const text = await res.text();
    const payload = text.trim().startsWith('{')
      ? text
      : text.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5)).pop();
    if (!payload) throw new Error(`Kandev MCP ${method}: empty response (HTTP ${res.status})`);
    return JSON.parse(payload);
  }

  private async ensureMcp(): Promise<void> {
    if (this.mcpSession) return;
    await this.rpc('initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'karkedikha-core', version: '1' } });
    await this.rpc('notifications/initialized', {}, true);
  }

  /** Calls one Kandev MCP tool and returns its parsed JSON result. Tool errors throw. */
  async tool<T = any>(name: string, args: Record<string, unknown>): Promise<T> {
    await this.ensureMcp();
    let reply = await this.rpc('tools/call', { name, arguments: args });
    if (reply?.error?.code === -32001 || /session/i.test(String(reply?.error?.message ?? ''))) {
      this.mcpSession = null; // Kandev restarted; its MCP sessions do not survive.
      await this.ensureMcp();
      reply = await this.rpc('tools/call', { name, arguments: args });
    }
    if (reply?.error) throw new Error(`Kandev ${name}: ${reply.error.message ?? JSON.stringify(reply.error)}`);
    const text = (reply?.result?.content ?? []).map((c: { text?: string }) => c.text ?? '').join('');
    if (reply?.result?.isError) throw new Error(`Kandev ${name}: ${text.slice(0, 500)}`);
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new Error(`Kandev ${name}: ${text.slice(0, 500)}`);
    }
  }

  // --- REST ---

  async rest<T = any>(method: 'GET' | 'POST' | 'DELETE', path: string, body?: unknown): Promise<T> {
    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}/api/v1${path}`, {
        method,
        headers: body === undefined ? undefined : { 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(30_000),
      });
    } catch (err) {
      throw new KandevUnavailableError(`Kandev is not reachable at ${this.baseUrl}: ${(err as Error).message}`);
    }
    const text = await res.text();
    if (!res.ok) throw new Error(`Kandev ${method} ${path}: HTTP ${res.status} ${text.slice(0, 300)}`);
    return (text ? JSON.parse(text) : null) as T;
  }

  // --- WebSocket actions (no MCP/REST equivalent in Kandev v0.97) ---

  async ws<T = any>(action: string, payload: Record<string, unknown>): Promise<T> {
    const url = this.baseUrl.replace(/^http/, 'ws') + '/ws';
    const id = randomUUID();
    return await new Promise<T>((resolve, reject) => {
      const socket = new WebSocket(url);
      const timer = setTimeout(() => { socket.terminate(); reject(new Error(`Kandev ${action}: timed out`)); }, 20_000);
      socket.on('open', () => socket.send(JSON.stringify({ id, type: 'request', action, payload })));
      socket.on('message', (raw) => {
        const msg = JSON.parse(String(raw));
        if (msg.id !== id) return;
        clearTimeout(timer);
        socket.close();
        if (msg.type === 'error') reject(new Error(`Kandev ${action}: ${msg.payload?.message ?? 'error'}`));
        else resolve(msg.payload as T);
      });
      socket.on('error', (err) => { clearTimeout(timer); reject(new KandevUnavailableError(`Kandev ${action}: ${err.message}`)); });
    });
  }

  // --- convenience wrappers used by the dev-story coordinator ---

  async defaultWorkspaceId(): Promise<string> {
    const { workspaces } = await this.tool<{ workspaces: Array<{ id: string }> }>('list_workspaces_kandev', {});
    if (!workspaces?.length) throw new Error('Kandev has no workspace');
    return workspaces[0].id;
  }

  async taskByExternalId(workspaceId: string, externalId: string): Promise<KandevTask | null> {
    try {
      const found = await this.rest<{ task?: KandevTask } & KandevTask>('GET', `/workspaces/${workspaceId}/tasks/by-external-id?external_id=${encodeURIComponent(externalId)}`);
      return (found?.task ?? (found?.id ? found : null)) as KandevTask | null;
    } catch (err) {
      if (/HTTP 404/.test((err as Error).message)) return null;
      throw err;
    }
  }

  async sessions(taskId: string): Promise<KandevSession[]> {
    const res = await this.rest<{ sessions?: KandevSession[] }>('GET', `/tasks/${taskId}/sessions`);
    return res?.sessions ?? [];
  }

  /** The session's most recent agent turn; `completed_at` is absent while the turn is still running. */
  async latestTurn(sessionId: string): Promise<{ started_at: string; completed_at?: string } | null> {
    const res = await this.rest<{ turns?: Array<{ started_at: string; completed_at?: string }> }>('GET', `/task-sessions/${sessionId}/turns`);
    const turns = [...(res?.turns ?? [])].sort((a, b) => a.started_at.localeCompare(b.started_at));
    return turns.at(-1) ?? null;
  }

  async pendingPermissions(taskId: string): Promise<KandevPermission[]> {
    const res = await this.tool<{ permissions?: KandevPermission[] }>('list_pending_agent_permissions_kandev', { task_id: taskId });
    return res.permissions ?? [];
  }

  async resolvePermission(p: KandevPermission, kind: 'allow_once' | 'reject_once'): Promise<void> {
    const option = (p.options ?? []).find(o => o.kind === kind);
    if (!option) throw new Error(`permission ${p.pending_id} offers no ${kind} option`);
    await this.tool('resolve_agent_permission_kandev', {
      task_id: p.task_id, session_id: p.session_id, request_id: p.request_id, pending_id: p.pending_id, option_id: option.option_id,
    });
  }

  async setTaskState(taskId: string, state: string): Promise<void> {
    await this.tool('update_task_state_kandev', { task_id: taskId, state });
  }

  async stopTask(taskId: string, reason: string): Promise<void> {
    await this.ws('orchestrator.stop', { task_id: taskId, reason, force: false });
  }

  async sessionStatus(taskId: string, sessionId: string): Promise<{ is_agent_running?: boolean; needs_resume?: boolean; resume_reason?: string }> {
    return await this.ws('task.session.status', { task_id: taskId, session_id: sessionId });
  }

  /** Relaunches a session whose agent process is gone; agents with ACP session/load restore their own context. */
  async relaunchSession(taskId: string, sessionId: string): Promise<void> {
    await this.ws('session.launch', { task_id: taskId, session_id: sessionId });
  }

  /** What the worker itself said or did lately (newest last): its narrative messages and tool calls. */
  async agentMessages(sessionId: string, limit = 40): Promise<Array<{ id: string; at: string; kind: string; text: string; status?: string }>> {
    const res = await this.rest<{ messages?: Array<Record<string, unknown>> } | Array<Record<string, unknown>>>('GET', `/task-sessions/${sessionId}/messages?limit=${limit}&sort=desc`);
    const list = (Array.isArray(res) ? res : res?.messages ?? []) as Array<Record<string, unknown>>;
    return list
      .filter(m => m.author_type === 'agent')
      .map(m => ({ id: String(m.id ?? ''), at: String(m.created_at ?? ''), kind: String(m.type ?? ''), text: String(m.content ?? ''), status: (m.metadata as { status?: string } | undefined)?.status }))
      .sort((a, b) => a.at.localeCompare(b.at));
  }

  async sendMessage(taskId: string, sessionId: string, content: string): Promise<void> {
    await this.ws('message.add', { task_id: taskId, session_id: sessionId, content });
  }
}
