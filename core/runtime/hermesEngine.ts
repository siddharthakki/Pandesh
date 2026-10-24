import * as path from 'node:path';
import * as fs from 'node:fs';
import * as cp from 'node:child_process';
import type { CoreDatabase } from '../db/connection';
import type { EventBroadcaster } from '../ws/broadcaster';
import { startToolInvocation, completeToolInvocation } from '../domain/toolInvocations';
import { startModelInvocation, completeModelInvocation } from '../domain/modelInvocations';
import { recordRuntimeEvent, latestRuntimeSequence, listRuntimeEventsAfter } from '../domain/runtimeEvents';
import { appendMessage } from '../domain/conversations';
import { registerArtifact } from '../domain/artifacts';
import { transitionAttempt, failAttempt, getAttempt, settleCancelledAttempt } from '../domain/attempts';
import { createApproval, getApproval, listApprovalsForAttempt } from '../domain/approvals';
import { recordExecutionQuality } from '../domain/executionQuality';
import {
  type EngineAdapter,
  type EngineExecutionOptions,
  type EngineExecutionResult,
  EngineRegistry,
} from './adapters/EngineAdapter';
import { sharedCloudCredentials } from './cloudCredentials';
import { ensureModelResident } from './ollamaResidency';

export const DEFAULT_HERMES_URL = 'http://127.0.0.1:8642';
export const DEFAULT_HERMES_MODEL = 'qwen3-coder:swift-27b';
export const DEFAULT_OLLAMA_URL = process.env.KARKEDIKHA_OLLAMA_URL || 'http://localhost:11434';

/**
 * The installed Hermes profile directories that hold real skills.
 *
 * `hermes/skills` is the user's installed skill set; `hermes-agent/skills`
 * is the bundled source tree the installer seeds from. Both are read-only
 * here — Pandesh never writes into another product's install.
 */
function hermesSkillRoots(): string[] {
  const roots: string[] = [];
  const localAppData = process.env.LOCALAPPDATA || (process.platform === 'win32' ? path.join(process.env.HOME ?? '', 'AppData', 'Local') : '');
  if (!localAppData) return roots;
  const profile = path.join(localAppData, 'hermes');
  roots.push(path.join(profile, 'skills'));
  roots.push(path.join(profile, 'hermes-agent', 'skills'));
  return roots.filter((root) => fs.existsSync(root));
}

function readSkillFrontmatter(filePath: string): { name: string; description: string } | null {
  let raw: string;
  try { raw = fs.readFileSync(filePath, 'utf8'); } catch { return null; }
  if (!raw.startsWith('---')) return null;
  const end = raw.indexOf('\n---', 3);
  if (end === -1) return null;
  const front = raw.slice(3, end);
  const name = /^name:\s*(.+)$/m.exec(front)?.[1]?.trim() ?? '';
  const description = /^description:\s*([\s\S]+?)$/m.exec(front)?.[1]?.trim() ?? '';
  if (!name) return null;
  return { name, description: description.replace(/\s+/g, ' ').slice(0, 400) };
}

/**
 * Reads the installed skills straight from the local Hermes profile.
 *
 * This is the honest fallback for an installed Hermes build whose
 * `/v1/skills` handler is broken: the skills are real, they are installed,
 * and the result says it came from the install rather than from the API.
 */
export function readLocalHermesSkills(): { skills: Array<{ name: string; description: string }> } {
  const found = new Map<string, { name: string; description: string }>();
  for (const root of hermesSkillRoots()) {
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch { continue; }
    const directories = entries.filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'));
    for (const directory of directories) {
      const direct = path.join(root, directory.name, 'SKILL.md');
      if (fs.existsSync(direct)) {
        const meta = readSkillFrontmatter(direct);
        if (meta && !found.has(meta.name)) found.set(meta.name, meta);
        continue;
      }
      // Category directories (the bundled tree) hold one level of skills.
      let nested: fs.Dirent[];
      try { nested = fs.readdirSync(path.join(root, directory.name), { withFileTypes: true }); } catch { continue; }
      for (const child of nested) {
        if (!child.isDirectory() || child.name.startsWith('.')) continue;
        const meta = readSkillFrontmatter(path.join(root, directory.name, child.name, 'SKILL.md'));
        if (meta && !found.has(meta.name)) found.set(meta.name, meta);
      }
    }
  }
  return { skills: [...found.values()].sort((a, b) => a.name.localeCompare(b.name)) };
}

function mutateWithBroadcast<T>(
  db: CoreDatabase,
  broadcaster: EventBroadcaster | undefined,
  fn: () => T
): T {
  const before = latestRuntimeSequence(db);
  const result = fn();
  if (broadcaster && typeof broadcaster.publishRuntime === 'function') {
    for (const event of listRuntimeEventsAfter(db, before, 200)) {
      broadcaster.publishRuntime(event);
    }
  }
  return result;
}

function safeRecordRuntimeEvent(
  db: CoreDatabase,
  broadcaster: EventBroadcaster | undefined,
  attemptId: string,
  eventType: string,
  metadata: Record<string, unknown>,
  actor: string
): void {
  try {
    const rec = recordRuntimeEvent(db, {
      domain: 'attempt',
      entityId: attemptId,
      eventType,
      actor,
      metadata,
    });
    if (broadcaster && typeof broadcaster.publishRuntime === 'function') {
      broadcaster.publishRuntime(rec);
    }
  } catch {}
}

export interface HermesCapabilities {
  runs?: boolean;
  tools?: boolean | string[];
  skills?: boolean | string[];
  models?: string[];
  version?: string;
  [key: string]: unknown;
}

export interface HermesRunContext {
  db: CoreDatabase;
  broadcaster: EventBroadcaster;
  attemptId: string;
  requestId: string;
  conversationId: string;
  workspaceRoot?: string;
  prompt: string;
  model?: string;
  fenceToken: string;
  signal?: AbortSignal;
  idempotencyKey?: string;
  manageAttemptLifecycle?: boolean;
}

export interface HermesRunResponse {
  id: string;
  status: 'created' | 'running' | 'completed' | 'failed' | 'cancelled' | 'interrupted' | 'unknown';
  output?: string;
  error?: string;
  modifiedFiles?: string[];
  toolCalls?: Array<{ tool: string; args?: unknown; status?: string; result?: unknown }>;
  [key: string]: unknown;
}

/**
 * Hermes HTTP Runs API Client and Runtime Execution Engine.
 * Implements official /v1/capabilities and /v1/runs lifecycle with KKD governance.
 */
export class HermesEngine {
  private static activeControllers = new Map<string, AbortController>();

  static getBaseUrl(): string {
    return (process.env.HERMES_URL || process.env.HERMES_API_BASE || DEFAULT_HERMES_URL).replace(/\/$/, '');
  }

  static getApiKey(): string {
    return (
      process.env.HERMES_API_KEY ||
      sharedCloudCredentials.get('hermes')?.apiKey ||
      'hermes-local-key'
    ).trim();
  }

  static isEnabled(): boolean {
    return process.env.HERMES_ENABLED !== 'false' && process.env.HERMES_ENABLED !== '0';
  }

  /**
   * Discovers Hermes through its local API address and verifies /v1/capabilities.
   */
  private static startAttempt: Promise<void> | null = null;

  /** Like checkCapabilities, but when the configured endpoint is local and
   * not answering, starts the installed Hermes gateway once (detached) and
   * waits for it, so the user never has to launch Hermes by hand. */
  static async ensureAvailable(waitMs = 45_000): Promise<{ available: boolean; capabilities?: HermesCapabilities; error?: string }> {
    const first = await this.checkCapabilities();
    if (first.available || !this.isEnabled()) return first;
    const base = new URL(this.getBaseUrl());
    if (!['127.0.0.1', 'localhost'].includes(base.hostname)) return first;
    const bin = process.env.HERMES_BIN
      || [path.join(process.env.LOCALAPPDATA || '', 'hermes', 'bin', 'hermes.exe'), path.join(process.env.LOCALAPPDATA || '', 'hermes', 'bin', 'hermes')]
        .find((candidate) => fs.existsSync(candidate));
    if (!bin) return { available: false, error: `${first.error ?? 'Hermes is not running'}; the Hermes CLI is not installed (set HERMES_BIN).` };
    if (!this.startAttempt) {
      this.startAttempt = (async () => {
        const child = cp.spawn(bin, ['gateway', 'run'], { detached: true, stdio: 'ignore', windowsHide: true });
        child.unref();
        const deadline = Date.now() + waitMs;
        while (Date.now() < deadline && !(await this.checkCapabilities()).available) await new Promise((r) => setTimeout(r, 1_000));
      })().finally(() => { this.startAttempt = null; });
    }
    await this.startAttempt;
    const after = await this.checkCapabilities();
    return after.available ? after : { available: false, error: `Hermes was started but did not become ready within ${Math.round(waitMs / 1000)}s (${after.error ?? 'no response'})` };
  }

  static async checkCapabilities(timeoutMs = 1500): Promise<{ available: boolean; capabilities?: HermesCapabilities; error?: string }> {
    if (!this.isEnabled()) {
      return { available: false, error: 'Hermes engine is disabled via configuration (HERMES_ENABLED=false).' };
    }
    const baseUrl = this.getBaseUrl();
    const apiKey = this.getApiKey();
    try {
      const res = await fetch(`${baseUrl}/v1/capabilities`, {
        headers: {
          Authorization: `Bearer ${apiKey}`,
          Accept: 'application/json',
        },
        signal: AbortSignal.timeout(timeoutMs),
      });

      if (!res.ok) {
        return { available: false, error: `Hermes returned HTTP ${res.status}` };
      }

      const json = await res.json() as any;
      const rawCaps = typeof json.capabilities === 'object' ? json.capabilities : json;
      const caps: HermesCapabilities = {
        ...rawCaps,
        models: json.models || rawCaps.models,
      };
      // Valid if capabilities response indicates run execution support
      const runsSupported = caps.runs !== false;
      return { available: runsSupported, capabilities: caps };
    } catch (err: any) {
      return { available: false, error: err.message || 'Hermes capabilities check failed' };
    }
  }

  /**
   * Submits a task to Hermes via POST /v1/runs using an idempotency key.
   */
  static async submitRun(
    payload: {
      prompt: string;
      model?: string;
      workspaceRoot?: string;
      idempotencyKey: string;
      metadata?: Record<string, unknown>;
    },
    signal?: AbortSignal
  ): Promise<HermesRunResponse> {
    const baseUrl = this.getBaseUrl();
    const apiKey = this.getApiKey();

    const res = await fetch(`${baseUrl}/v1/runs`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
        'Idempotency-Key': payload.idempotencyKey,
      },
      body: JSON.stringify({
        input: payload.prompt,
        prompt: payload.prompt,
        model: payload.model || DEFAULT_HERMES_MODEL,
        workspace_root: payload.workspaceRoot,
        idempotency_key: payload.idempotencyKey,
        metadata: payload.metadata,
        endpoints: {
          ollama: DEFAULT_OLLAMA_URL,
          llamacpp: process.env.KARKEDIKHA_LLAMACPP_URL || undefined,
        },
      }),
      signal,
    });

    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      throw new Error(`Hermes POST /v1/runs failed with HTTP ${res.status}: ${errText}`);
    }

    const data = await res.json() as any;
    const runId = data.id || data.run_id;
    if (!runId) {
      throw new Error('Hermes POST /v1/runs did not return a valid run ID');
    }

    return {
      id: runId,
      status: data.status || 'created',
      output: data.output,
      error: data.error,
      modifiedFiles: data.modified_files || data.modifiedFiles,
      toolCalls: data.tool_calls || data.toolCalls,
    };
  }

  /**
   * Fetches status of a specific run from Hermes via GET /v1/runs/{id}.
   */
  static async getRun(runId: string, signal?: AbortSignal): Promise<HermesRunResponse> {
    const baseUrl = this.getBaseUrl();
    const apiKey = this.getApiKey();

    const res = await fetch(`${baseUrl}/v1/runs/${encodeURIComponent(runId)}`, {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        Accept: 'application/json',
      },
      signal,
    });

    if (!res.ok) {
      throw new Error(`Hermes GET /v1/runs/${runId} failed with HTTP ${res.status}`);
    }

    const data = await res.json() as any;
    return {
      id: data.id || data.run_id || runId,
      status: data.status || 'unknown',
      output: data.output || data.result?.output || data.response,
      error: data.error || data.result?.error,
      modifiedFiles: data.modified_files || data.modifiedFiles || data.result?.modifiedFiles,
      toolCalls: data.tool_calls || data.toolCalls || data.result?.toolCalls,
    };
  }

  /**
   * Safely stops/cancels an active run on Hermes via POST /v1/runs/{id}/stop.
   */
  static async stopRun(runId: string): Promise<boolean> {
    const baseUrl = this.getBaseUrl();
    const apiKey = this.getApiKey();
    try {
      const res = await fetch(`${baseUrl}/v1/runs/${encodeURIComponent(runId)}/stop`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
        },
      });
      return res.ok;
    } catch {
      return false;
    }
  }

  /**
   * Lists the skills installed in the local Hermes profile.
   *
   * The official source is `GET /v1/skills`. When that endpoint fails (an
   * installed Hermes build can ship a broken handler), the same installed
   * skills are read from the local Hermes profile instead, and the result
   * says which source it used — the caller never has to guess whether the
   * list came from the live API or from disk.
   */
  static async listSkills(timeoutMs = 5_000): Promise<{
    source: 'hermes-api' | 'local-install';
    skills: Array<{ name: string; description: string; category?: string }>;
    apiError?: string;
  }> {
    const baseUrl = this.getBaseUrl();
    const apiKey = this.getApiKey();
    try {
      const res = await fetch(`${baseUrl}/v1/skills`, {
        headers: { Authorization: `Bearer ${apiKey}`, Accept: 'application/json' },
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (res.ok) {
        const data = await res.json() as { data?: unknown; skills?: unknown };
        const rows = Array.isArray(data.data) ? data.data : (Array.isArray(data.skills) ? data.skills : []);
        const skills = rows
          .map((row) => {
            const record = (row && typeof row === 'object') ? row as Record<string, unknown> : { name: String(row) };
            return {
              name: String(record.name ?? record.id ?? '').trim(),
              description: String(record.description ?? '').trim(),
              category: record.category ? String(record.category) : undefined,
            };
          })
          .filter((skill) => skill.name.length > 0);
        return { source: 'hermes-api', skills };
      }
      const apiError = `Hermes GET /v1/skills failed with HTTP ${res.status}`;
      const local = readLocalHermesSkills();
      return { source: 'local-install', skills: local.skills, apiError };
    } catch (err: any) {
      const apiError = err?.message ? String(err.message) : 'Hermes GET /v1/skills failed';
      const local = readLocalHermesSkills();
      return { source: 'local-install', skills: local.skills, apiError };
    }
  }

  /**
   * Invokes one installed Hermes skill through the official Runs API and
   * returns the run's real result.
   *
   * The run is a genuine Hermes run: the prompt names the skill, Hermes
   * resolves and executes it, and the returned tool calls are the evidence
   * that it actually ran. Stop is honoured: when the caller's signal aborts,
   * the Hermes run is stopped and the result says it was stopped.
   */
  static async invokeSkill(input: {
    skill: string;
    task: string;
    model?: string;
    provider?: string;
    workspaceRoot?: string;
    signal?: AbortSignal;
    timeoutMs?: number;
  }): Promise<{
    runId: string | null;
    status: 'completed' | 'failed' | 'cancelled' | 'unknown';
    output: string;
    toolCalls: Array<{ tool: string; args?: unknown; status?: string; result?: unknown }>;
    error?: string;
    stopped: boolean;
  }> {
    const baseUrl = this.getBaseUrl();
    const apiKey = this.getApiKey();
    const controller = new AbortController();
    const onAbort = () => controller.abort();
    input.signal?.addEventListener('abort', onAbort, { once: true });
    const timer = setTimeout(() => controller.abort(), input.timeoutMs ?? 300_000);
    timer.unref?.();

    let runId: string | null = null;
    let output = '';
    let error: string | undefined;
    let stopped = false;
    let terminal = false;
    const toolCalls: Array<{ tool: string; args?: unknown; status?: string; result?: unknown }> = [];

    try {
      const prompt = `Use the "${input.skill}" skill to carry out this task:\n\n${input.task}`;
      const res = await fetch(`${baseUrl}/v1/runs`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
          'Idempotency-Key': `pandesh-skill:${input.skill}:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`,
        },
        body: JSON.stringify({
          input: prompt,
          prompt,
          model: input.model || DEFAULT_HERMES_MODEL,
          ...(input.provider ? { provider: input.provider } : {}),
          ...(input.workspaceRoot ? { workspace_root: input.workspaceRoot } : {}),
          metadata: { skill: input.skill, requested_by: 'pandesh' },
          endpoints: { ollama: DEFAULT_OLLAMA_URL },
        }),
        signal: controller.signal,
      });
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        return { runId: null, status: 'failed', output: '', toolCalls, error: `Hermes POST /v1/runs failed with HTTP ${res.status}: ${text.slice(0, 400)}`, stopped: false };
      }
      const submitted = await res.json() as { id?: string; run_id?: string };
      runId = submitted.id || submitted.run_id || null;
      if (!runId) {
        return { runId: null, status: 'failed', output: '', toolCalls, error: 'Hermes POST /v1/runs did not return a run id', stopped: false };
      }

      const sseRes = await fetch(`${baseUrl}/v1/runs/${encodeURIComponent(runId)}/events`, {
        headers: { Authorization: `Bearer ${apiKey}`, Accept: 'text/event-stream' },
        signal: controller.signal,
      });
      if (!sseRes.ok || !sseRes.body) {
        const polled = await this.getRun(runId, controller.signal).catch(() => null);
        if (polled) {
          output = polled.output ?? '';
          error = polled.error;
          terminal = true;
        }
      } else {
        const reader = (sseRes.body as any).getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        while (!terminal) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split(/\r?\n/);
          buffer = lines.pop() || '';
          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed || trimmed.startsWith(':')) continue;
            if (!trimmed.startsWith('data:')) continue;
            const data = trimmed.slice(5).trim();
            if (data === '[DONE]') { terminal = true; break; }
            let event: any;
            try { event = JSON.parse(data); } catch { continue; }
            const evType = event.event || event.type;
            if (evType === 'token' || evType === 'text_delta' || evType === 'message.delta' || evType === 'message.interim') {
              output += String(event.delta || event.text || '');
            } else if (evType === 'tool_call' || evType === 'tool.started') {
              toolCalls.push({ tool: String(event.tool || event.name || 'hermes_tool'), args: event.args || event.input, status: 'started' });
            } else if (evType === 'tool_result' || evType === 'tool.completed') {
              toolCalls.push({ tool: String(event.tool || 'hermes_tool'), result: event.output ?? event.result, status: event.success === false ? 'failed' : 'completed' });
            } else if (evType === 'run_finish' || evType === 'completed' || evType === 'failed' || evType === 'run.completed' || evType === 'run.failed' || evType === 'run.cancelled') {
              if (event.output) output = String(event.output);
              if (event.error) error = String(event.error);
              if (evType === 'run.cancelled') stopped = true;
              terminal = true;
              break;
            }
          }
        }
      }

      if (controller.signal.aborted && !terminal) {
        stopped = true;
        await this.stopRun(runId).catch(() => false);
      }
      const finalStatus = stopped ? 'cancelled' : (error ? 'failed' : (terminal ? 'completed' : 'unknown'));
      return { runId, status: finalStatus, output, toolCalls, error, stopped };
    } catch (err: any) {
      const aborted = err?.name === 'AbortError' || input.signal?.aborted;
      if (aborted && runId) {
        stopped = true;
        await this.stopRun(runId).catch(() => false);
      }
      return {
        runId,
        status: stopped ? 'cancelled' : 'failed',
        output,
        toolCalls,
        error: aborted ? 'the run was stopped before it finished' : (err?.message ? String(err.message) : 'Hermes skill run failed'),
        stopped,
      };
    } finally {
      clearTimeout(timer);
      input.signal?.removeEventListener('abort', onAbort);
    }
  }

  /**
   * Submits an approval resolution to Hermes via POST /v1/runs/{id}/approval.
   */
  static async submitApproval(
    runId: string,
    approvalId: string,
    decision: 'approved' | 'rejected',
    notes?: string
  ): Promise<boolean> {
    const baseUrl = this.getBaseUrl();
    const apiKey = this.getApiKey();
    try {
      const res = await fetch(`${baseUrl}/v1/runs/${encodeURIComponent(runId)}/approval`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          approval_id: approvalId,
          decision,
          notes,
        }),
      });
      return res.ok;
    } catch {
      return false;
    }
  }

  /**
   * Executes a task using Hermes HTTP Runs API, streaming events into KKD's activity system.
   */
  static async executeHermesRun(ctx: HermesRunContext): Promise<EngineExecutionResult> {
    const {
      db,
      broadcaster,
      attemptId,
      requestId,
      conversationId,
      workspaceRoot,
      prompt,
      model,
      fenceToken,
      signal,
    } = ctx;

    const actor = 'karkedikha:hermes';
    const startTime = Date.now();
    const idempotencyKey = ctx.idempotencyKey || `kkd:attempt:${attemptId}`;
    const selectedModel = model || DEFAULT_HERMES_MODEL;
    await ensureModelResident(selectedModel, { signal });

    // Check availability & capabilities first
    const capCheck = await this.checkCapabilities();
    if (!capCheck.available) {
      const errMsg = capCheck.error || 'Hermes capabilities check failed';
      if (ctx.manageAttemptLifecycle !== false) {
        try {
          mutateWithBroadcast(db, broadcaster, () => {
            failAttempt(db, attemptId, { failureReason: errMsg, fenceToken, actor });
          });
        } catch {}
      }
      return {
        success: false,
        reply: '',
        error: errMsg,
      };
    }

    if (ctx.manageAttemptLifecycle !== false) {
      try {
        mutateWithBroadcast(db, broadcaster, () => {
          transitionAttempt(db, attemptId, { toStatus: 'running', fenceToken, actor });
        });
      } catch {}
    }

    safeRecordRuntimeEvent(db, broadcaster, attemptId, 'step_start', {
      step: 1,
      engine: 'hermes',
      mode: 'runs_api',
      workspace: workspaceRoot || 'none',
      prompt: prompt.slice(0, 300),
      idempotencyKey,
    }, actor);

    // Track model invocation
    let modelInvocationRecord: any = null;
    try {
      mutateWithBroadcast(db, broadcaster, () => {
        modelInvocationRecord = startModelInvocation(db, {
          attemptId,
          requestedProvider: 'hermes',
          requestedModel: selectedModel,
          policyProvider: 'hermes',
          policyModel: selectedModel,
          actor,
        });
      });
    } catch {}

    // Submit the run to Hermes
    let run: HermesRunResponse;
    try {
      run = await this.submitRun({
        prompt,
        model: selectedModel,
        workspaceRoot,
        idempotencyKey,
        metadata: {
          attemptId,
          conversationId,
          requestId,
        },
      }, signal);
    } catch (err: any) {
      if (signal?.aborted || err.name === 'AbortError' || err.message?.includes('aborted')) {
        if (ctx.manageAttemptLifecycle !== false) {
          try {
            mutateWithBroadcast(db, broadcaster, () => {
              // Settled as cancelled, never failed: a failed attempt is eligible
              // for Auto reroute, which would restart work the user stopped.
              settleCancelledAttempt(db, attemptId, { fenceToken, actor });
            });
          } catch {}
        }
        safeRecordRuntimeEvent(db, broadcaster, attemptId, 'step_finish', {
          step: 1,
          status: 'cancelled',
          error: 'aborted',
        }, actor);

        return {
          success: false,
          reply: 'Task execution cancelled.',
          error: 'aborted',
        };
      }
      const errMsg = `Failed to submit run to Hermes: ${err.message}`;
      if (ctx.manageAttemptLifecycle !== false) {
        try {
          mutateWithBroadcast(db, broadcaster, () => {
            failAttempt(db, attemptId, { failureReason: errMsg, fenceToken, actor });
          });
        } catch {}
      }
      safeRecordRuntimeEvent(db, broadcaster, attemptId, 'step_finish', {
        step: 1,
        status: 'failed',
        error: errMsg,
      }, actor);

      return {
        success: false,
        reply: errMsg,
        error: errMsg,
      };
    }

    const runId = run.id;
    // Bind Hermes run ID to KKD attempt ID in runtime events
    safeRecordRuntimeEvent(db, broadcaster, attemptId, 'hermes_run_bound', {
      runId,
      attemptId,
      idempotencyKey,
      engine: 'hermes',
      status: run.status,
    }, actor);

    // Register active abort controller
    const runAbort = new AbortController();
    this.activeControllers.set(attemptId, runAbort);

    if (signal) {
      signal.addEventListener('abort', () => {
        runAbort.abort();
        HermesEngine.stopRun(runId).catch(() => {});
      });
    }

    const baseUrl = this.getBaseUrl();
    const apiKey = this.getApiKey();
    const activeToolInvocations = new Map<string, string>();
    const toolCallsRecorded: Array<{ tool: string; args?: unknown; status?: string; result?: unknown }> = [];
    let finalReply = '';
    let runSuccess = false;
    let runError: string | undefined;
    const modifiedFiles: string[] = [];

    // Stream SSE events from /v1/runs/{id}/events
    try {
      const sseRes = await fetch(`${baseUrl}/v1/runs/${encodeURIComponent(runId)}/events`, {
        headers: {
          Authorization: `Bearer ${apiKey}`,
          Accept: 'text/event-stream',
        },
        signal: runAbort.signal,
      });

      if (!sseRes.ok) {
        // If SSE is unavailable, fall back to polling GET /v1/runs/{id}
        const polled = await this.pollRunUntilTerminal(runId, runAbort.signal, 500);
        finalReply = polled.output || '';
        runSuccess = polled.status === 'completed';
        runError = polled.error;
        if (polled.modifiedFiles) modifiedFiles.push(...polled.modifiedFiles);
        if (polled.toolCalls) toolCallsRecorded.push(...polled.toolCalls);
      } else {
        // Read SSE stream
        const body = sseRes.body;
        if (!body) {
          throw new Error('Hermes SSE response body is empty');
        }

        const reader = (body as any).getReader();
        const decoder = new TextDecoder();
        let buffer = '';

        let sseTerminal = false;
        while (!sseTerminal) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });

          const lines = buffer.split(/\r?\n/);
          buffer = lines.pop() || '';

          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed || trimmed.startsWith(':')) continue;

            if (trimmed.startsWith('data:')) {
              const dataStr = trimmed.slice(5).trim();
              if (dataStr === '[DONE]') {
                sseTerminal = true;
                break;
              }
              try {
                const event = JSON.parse(dataStr);
                const evType = event.event || event.type;

                if (evType === 'token' || evType === 'text_delta' || evType === 'message.delta' || evType === 'message.interim') {
                  const delta = event.delta || event.text || '';
                  finalReply += delta;
                  if (broadcaster && typeof broadcaster.publishRuntimeToken === 'function') {
                    broadcaster.publishRuntimeToken({
                      attemptId,
                      invocationId: 'hermes',
                      delta,
                    });
                  }
                } else if (evType === 'tool_call' || evType === 'tool.started') {
                  const toolName = event.tool || event.name || 'hermes_tool';
                  const callId = event.call_id || event.id || `call_${Date.now()}`;
                  const args = event.args || event.preview || event.input || {};

                  let invId: string | undefined;
                  try {
                    mutateWithBroadcast(db, broadcaster, () => {
                      const rec = startToolInvocation(db, {
                        attemptId,
                        toolName,
                        argsSummary: args,
                        actor,
                      });
                      invId = rec?.id;
                    });
                  } catch {}

                  if (invId) {
                    activeToolInvocations.set(callId, invId);
                  }

                  safeRecordRuntimeEvent(db, broadcaster, attemptId, 'tool_call', {
                    toolName,
                    args,
                    invocationId: invId,
                    callId,
                  }, actor);

                  toolCallsRecorded.push({ tool: toolName, args, status: 'started' });
                } else if (evType === 'tool_result' || evType === 'tool.completed') {
                  const callId = event.call_id || event.id;
                  const invId = callId ? activeToolInvocations.get(callId) : undefined;
                  const success = event.success !== false && !event.error;
                  const output = event.output || event.result || event.preview;

                  if (invId) {
                    try {
                      mutateWithBroadcast(db, broadcaster, () => {
                        completeToolInvocation(db, invId, {
                          status: success ? 'succeeded' : 'failed',
                          exitCode: success ? 0 : 1,
                          evidence: { output, error: event.error },
                          actor,
                        });
                      });
                    } catch {}
                    activeToolInvocations.delete(callId);
                  }

                  safeRecordRuntimeEvent(db, broadcaster, attemptId, 'tool_result', {
                    toolName: event.tool || 'hermes_tool',
                    success,
                    invocationId: invId,
                    output: typeof output === 'string' ? output.slice(0, 300) : output,
                  }, actor);

                  toolCallsRecorded.push({ tool: event.tool || 'hermes_tool', result: output, status: success ? 'completed' : 'failed' });
                } else if (evType === 'approval_request' || evType === 'approval.requested' || evType === 'approval.request') {
                  // Hermes requires human authorization for a tool call (e.g. file mutation)
                  const toolName = event.tool || 'file_modification';
                  const targetFiles = event.files || (event.args?.path ? [event.args.path] : []);
                  const cardText = event.prompt || `Hermes requests authorization to run tool "${toolName}".`;

                  let approvalRecord: any;
                  try {
                    mutateWithBroadcast(db, broadcaster, () => {
                      transitionAttempt(db, attemptId, { toStatus: 'waiting_for_approval', fenceToken, actor });
                      approvalRecord = createApproval(db, {
                        attemptId,
                        kind: 'mutation',
                        summary: {
                          toolName,
                          targetFiles,
                          args: event.args,
                          cardText,
                        },
                        presentation: {
                          toolName,
                          targetFiles,
                          cardText,
                        },
                        actor,
                      });
                    });
                  } catch (err) {
                    console.error('[hermesEngine] createApproval error:', err);
                  }

                  // Await approval resolution
                  if (approvalRecord?.id) {
                    const pollStart = Date.now();
                    const timeoutMs = 60_000;
                    let curApproval = getApproval(db, approvalRecord.id);
                    while (curApproval.status === 'pending' && Date.now() - pollStart < timeoutMs && !runAbort.signal.aborted) {
                      await new Promise((r) => setTimeout(r, 400));
                      curApproval = getApproval(db, approvalRecord.id);
                    }

                    const decision = curApproval.status === 'approved' ? 'approved' : 'rejected';
                    await HermesEngine.submitApproval(runId, approvalRecord.id, decision);

                    try {
                      mutateWithBroadcast(db, broadcaster, () => {
                        const curAttempt = getAttempt(db, attemptId);
                        if (curAttempt.status === 'waiting_for_approval') {
                          transitionAttempt(db, attemptId, { toStatus: 'running', fenceToken, actor });
                        }
                      });
                    } catch {}
                  }
                } else if (evType === 'clarification_request') {
                  safeRecordRuntimeEvent(db, broadcaster, attemptId, 'clarification_request', {
                    question: event.question || event.prompt,
                  }, actor);
                } else if (evType === 'run_finish' || evType === 'completed' || evType === 'failed' || evType === 'run.completed' || evType === 'run.failed' || evType === 'run.cancelled') {
                  runSuccess = evType !== 'failed' && evType !== 'run.failed' && event.status !== 'failed' && !event.error;
                  if (event.output) finalReply = event.output;
                  if (event.error) runError = event.error;
                  if (Array.isArray(event.modified_files)) modifiedFiles.push(...event.modified_files);
                  if (Array.isArray(event.modifiedFiles)) modifiedFiles.push(...event.modifiedFiles);
                  sseTerminal = true;
                  break;
                }
              } catch {}
            }
          }
        }
      }
    } catch (err: any) {
      if (err.name === 'AbortError' || signal?.aborted) {
        if (ctx.manageAttemptLifecycle !== false) {
          try {
            mutateWithBroadcast(db, broadcaster, () => {
              settleCancelledAttempt(db, attemptId, { fenceToken, actor });
            });
          } catch {}
        }
        return { success: false, reply: 'Execution cancelled.', error: 'aborted' };
      }
      runError = err.message;
      runSuccess = false;
    } finally {
      this.activeControllers.delete(attemptId);
    }

    // If final reply is empty, query run directly
    if (!finalReply) {
      try {
        const finalCheck = await this.getRun(runId);
        if (finalCheck.output) finalReply = finalCheck.output;
        if (finalCheck.error && !runError) runError = finalCheck.error;
        if (finalCheck.status === 'completed') runSuccess = true;
        if (finalCheck.modifiedFiles) {
          for (const f of finalCheck.modifiedFiles) {
            if (!modifiedFiles.includes(f)) modifiedFiles.push(f);
          }
        }
      } catch {}
    }

    if (!finalReply && runSuccess) {
      finalReply = 'Hermes task executed successfully.';
    }

    // Register artifacts
    for (const filePath of modifiedFiles) {
      try {
        const abs = workspaceRoot && !path.isAbsolute(filePath) ? path.resolve(workspaceRoot, filePath) : filePath;
        const fileName = path.basename(abs);
        registerArtifact(db, {
          attemptId,
          conversationId,
          requestId,
          kind: 'file',
          title: fileName,
          mimeType: 'text/plain',
          absolutePath: abs,
          source: 'hermes',
          actor,
          metadata: { workspaceRoot, relativePath: workspaceRoot ? path.relative(workspaceRoot, abs) : filePath },
        });
      } catch {}
    }

    // Append to conversation
    if (finalReply && conversationId) {
      try {
        appendMessage(db, conversationId, {
          role: 'assistant',
          content: finalReply,
          modelInvocationId: modelInvocationRecord?.id ?? null,
          actor,
        });
      } catch {}
    }

    const totalMs = Date.now() - startTime;
    if (modelInvocationRecord?.id) {
      try {
        mutateWithBroadcast(db, broadcaster, () => {
          completeModelInvocation(db, modelInvocationRecord.id, {
            status: runSuccess ? 'succeeded' : 'failed',
            actualProvider: 'hermes',
            actualModel: selectedModel,
            usageMetadata: { totalMs, runId },
            actor,
          });
        });
      } catch {}
    }

    try {
      recordExecutionQuality(db, attemptId, {
        eventType: 'final_verification_recorded',
        actor,
        metadata: {
          passed: runSuccess,
          totalMs,
          runId,
          modifiedFilesCount: modifiedFiles.length,
          toolCallsCount: toolCallsRecorded.length,
        },
      });
    } catch {}

    if (runSuccess) {
      if (ctx.manageAttemptLifecycle !== false) {
        try {
          mutateWithBroadcast(db, broadcaster, () => {
            transitionAttempt(db, attemptId, { toStatus: 'completed', fenceToken, actor });
          });
        } catch (e) {
          console.error('[hermesEngine] transitionAttempt completed error:', e);
        }
      }
      safeRecordRuntimeEvent(db, broadcaster, attemptId, 'step_finish', {
        step: 1,
        status: 'completed',
        runId,
        modifiedFiles,
        totalMs,
      }, actor);

      return {
        success: true,
        reply: finalReply,
        modifiedFiles,
        toolCalls: toolCallsRecorded,
        metrics: { totalMs },
      };
    } else {
      const errMessage = runError || 'Hermes run failed';
      if (ctx.manageAttemptLifecycle !== false) {
        try {
          mutateWithBroadcast(db, broadcaster, () => {
            failAttempt(db, attemptId, { failureReason: errMessage, fenceToken, actor });
          });
        } catch (e) {
          console.error('[hermesEngine] failAttempt error:', e);
        }
      }
      safeRecordRuntimeEvent(db, broadcaster, attemptId, 'step_finish', {
        step: 1,
        status: 'failed',
        runId,
        error: errMessage,
      }, actor);

      return {
        success: false,
        reply: finalReply || `Hermes execution failed: ${errMessage}`,
        error: errMessage,
        modifiedFiles,
        metrics: { totalMs },
      };
    }
  }

  /**
   * Safe recovery for interrupted / unknown Hermes runs.
   * Never automatically repeat an operation when its previous outcome is uncertain.
   */
  static async reconcileInterruptedRun(
    attemptId: string,
    db: CoreDatabase,
    broadcaster?: EventBroadcaster,
    actor = 'karkedikha:hermes:reconcile'
  ): Promise<{ status: string; reconciled: boolean; reason?: string }> {
    // Locate bound runId from runtime_events
    const event = db.get<{ metadata: string }>(
      `SELECT metadata FROM runtime_events WHERE entityId = ? AND eventType = 'hermes_run_bound' ORDER BY sequence DESC LIMIT 1`,
      [attemptId]
    );

    if (!event || !event.metadata) {
      return { status: 'unknown', reconciled: false, reason: 'No bound Hermes run found for attempt' };
    }

    let meta: any;
    try {
      meta = JSON.parse(event.metadata);
    } catch {
      return { status: 'unknown', reconciled: false, reason: 'Corrupt Hermes run binding metadata' };
    }

    const runId = meta.runId;
    if (!runId) {
      return { status: 'unknown', reconciled: false, reason: 'Missing runId in binding metadata' };
    }

    try {
      const run = await this.getRun(runId);
      if (run.status === 'completed') {
        safeRecordRuntimeEvent(db, broadcaster, attemptId, 'hermes_reconciliation', {
          runId,
          outcome: 'completed',
          output: run.output?.slice(0, 200),
        }, actor);
        return { status: 'completed', reconciled: true };
      } else if (run.status === 'failed') {
        safeRecordRuntimeEvent(db, broadcaster, attemptId, 'hermes_reconciliation', {
          runId,
          outcome: 'failed',
          error: run.error,
        }, actor);
        return { status: 'failed', reconciled: true, reason: run.error };
      } else if (run.status === 'running') {
        return { status: 'running', reconciled: false, reason: 'Run is still actively executing on Hermes' };
      } else {
        // Outcome is uncertain: fail closed without repeating
        safeRecordRuntimeEvent(db, broadcaster, attemptId, 'hermes_reconciliation', {
          runId,
          outcome: 'uncertain',
          status: run.status,
          action: 'fail_closed_no_replay',
        }, actor);
        return { status: run.status, reconciled: false, reason: 'Hermes run outcome is uncertain; will not repeat automatically' };
      }
    } catch (err: any) {
      safeRecordRuntimeEvent(db, broadcaster, attemptId, 'hermes_reconciliation', {
        runId,
        outcome: 'unreachable',
        error: err.message,
        action: 'fail_closed_no_replay',
      }, actor);
      return { status: 'unreachable', reconciled: false, reason: `Hermes server unreachable: ${err.message}` };
    }
  }

  private static async pollRunUntilTerminal(runId: string, signal?: AbortSignal, intervalMs = 500): Promise<HermesRunResponse> {
    const start = Date.now();
    const timeout = 120_000;
    while (Date.now() - start < timeout && !signal?.aborted) {
      const run = await this.getRun(runId, signal);
      if (run.status === 'completed' || run.status === 'failed' || run.status === 'cancelled') {
        return run;
      }
      await new Promise((r) => setTimeout(r, intervalMs));
    }
    throw new Error(`Hermes run ${runId} timed out or aborted while polling`);
  }
}

/**
 * Hermes Engine Adapter implementing the standard EngineAdapter interface.
 */
export class HermesEngineAdapter implements EngineAdapter {
  readonly id = 'hermes';
  readonly name = 'Hermes Agent';
  readonly role = 'specialist' as const;
  readonly description = 'Hermes agent engine for autonomous skills and multi-turn workflows using official HTTP Runs API';

  async isAvailable(): Promise<boolean> {
    const check = await HermesEngine.checkCapabilities(1200);
    return check.available;
  }

  async execute(prompt: string, options?: EngineExecutionOptions): Promise<EngineExecutionResult> {
    const isAvail = await this.isAvailable();
    if (!isAvail) {
      return {
        success: false,
        reply: '',
        error: 'Hermes engine is not running or available on this system.',
      };
    }

    const idempotencyKey = `hermes:exec:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`;
    const run = await HermesEngine.submitRun({
      prompt,
      model: options?.model,
      workspaceRoot: options?.workingDirectory,
      idempotencyKey,
    }, options?.signal);

    const start = Date.now();
    const timeout = options?.timeoutMs || 120000;
    while (Date.now() - start < timeout && !options?.signal?.aborted) {
      const cur = await HermesEngine.getRun(run.id, options?.signal);
      if (cur.status === 'completed') {
        return {
          success: true,
          reply: cur.output || 'Task completed successfully',
          modifiedFiles: cur.modifiedFiles,
          toolCalls: cur.toolCalls,
        };
      }
      if (cur.status === 'failed') {
        return {
          success: false,
          reply: cur.output || '',
          error: cur.error || 'Hermes task execution failed',
          modifiedFiles: cur.modifiedFiles,
          toolCalls: cur.toolCalls,
        };
      }
      await new Promise((r) => setTimeout(r, 600));
    }

    return {
      success: false,
      reply: '',
      error: 'Hermes execution timed out',
    };
  }

  abort(): void {
    // Abort signal is passed per execution
  }
}

// Register real adapter into EngineRegistry
export const hermesEngineAdapter = new HermesEngineAdapter();
EngineRegistry.register(hermesEngineAdapter);
