import * as cp from 'node:child_process';
import * as os from 'node:os';
import * as path from 'node:path';
import * as fs from 'node:fs';
import * as net from 'node:net';
import { randomBytes } from 'node:crypto';
import { ensureModelResident } from './ollamaResidency';
import type { CoreDatabase } from '../db/connection';
import type { EventBroadcaster } from '../ws/broadcaster';
import { startToolInvocation, completeToolInvocation } from '../domain/toolInvocations';
import { recordRuntimeEvent, latestRuntimeSequence, listRuntimeEventsAfter } from '../domain/runtimeEvents';
import { appendMessage } from '../domain/conversations';
import { registerArtifact } from '../domain/artifacts';
import { transitionAttempt, failAttempt, settleCancelledAttempt } from '../domain/attempts';
import { recordExecutionQuality } from '../domain/executionQuality';

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

import {
  type EngineAdapter,
  type EngineExecutionOptions,
  type EngineExecutionResult,
  type EngineProgressEvent,
  EngineRegistry
} from './adapters/EngineAdapter';

const DEFAULT_MODEL = 'qwen3-coder:swift-27b';
const DEFAULT_OLLAMA_URL = process.env.KARKEDIKHA_OLLAMA_URL || 'http://localhost:11434';
/**
 * Where OpenCode may live. %APPDATA% is not trusted alone: a profile that redirects it (a portable or test profile)
 * must still find the person's own npm-installed OpenCode, so the real home directory is searched too.
 */
export function openCodeCandidates(): string[] {
  const npmRoots = [...new Set([
    path.join(process.env.APPDATA || '', 'npm'),
    path.join(os.homedir(), 'AppData', 'Roaming', 'npm'),
  ].filter((root) => root !== 'npm'))];
  return [
    ...(process.env.OPENCODE_BIN ? [process.env.OPENCODE_BIN] : []),
    ...npmRoots.flatMap((root) => [
      path.join(root, 'node_modules', '@opencode', 'cli', 'bin', 'opencode.exe'),
      path.join(root, 'opencode.cmd'),
    ]),
  ];
}

/**
 * What OpenCode may do on its own. Pandesh cannot answer OpenCode's internal
 * permission prompts, so anything that would need one is denied outright:
 * no shell (deletes, git pushes, installs and the like go through Pandesh's
 * own approved tools), nothing outside the selected workspace, no web, and no
 * hand-off to subagents that could carry their own looser rules. Editing files
 * inside the workspace is the delegated task itself.
 */
export const OPENCODE_PERMISSION = {
  bash: 'deny',
  edit: 'allow',
  external_directory: 'deny',
  webfetch: 'deny',
  websearch: 'deny',
  task: 'deny',
  execute: 'deny',
  browser: 'deny',
  doom_loop: 'deny',
} as const;

/** Built-in agents re-pinned to the policy, so no agent definition can widen it. */
const OPENCODE_AGENTS = ['build', 'plan', 'general', 'explore'] as const;

export function withPandeshPermissions<T extends Record<string, unknown>>(config: T): T & { permission: typeof OPENCODE_PERMISSION } {
  return {
    ...config,
    permission: OPENCODE_PERMISSION,
    agent: Object.fromEntries(OPENCODE_AGENTS.map((name) => [name, { permission: OPENCODE_PERMISSION }])),
  };
}

/**
 * The environment OpenCode runs in. The person's global OpenCode config (and
 * any agents or permissions it defines) is never loaded: config comes only
 * from Pandesh, both inline and from the workspace file.
 */
export function openCodeEnv(workspaceRoot: string, config: Record<string, unknown>, extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const isolatedConfigHome = path.join(os.tmpdir(), 'pandesh-opencode-config');
  fs.mkdirSync(isolatedConfigHome, { recursive: true });
  return {
    ...process.env,
    OPENCODE_DISABLE_AUTOUPDATE: '1',
    // OpenCode prefers an inherited PWD over the spawn cwd, so a Core started from a terminal would work in that terminal's folder.
    PWD: workspaceRoot,
    XDG_CONFIG_HOME: isolatedConfigHome,
    OPENCODE_CONFIG_CONTENT: JSON.stringify(config),
    ...extra,
  };
}

export function findOpenCodeExe(): string {
  return openCodeCandidates().find((candidate) => candidate && fs.existsSync(candidate)) ?? 'opencode';
}

/** Finds a free TCP port on localhost */
export async function getFreePort(startPort = 18170): Promise<number> {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.listen(0, '127.0.0.1', () => {
      const address = server.address() as net.AddressInfo;
      const port = address.port;
      server.close(() => resolve(port));
    });
    server.on('error', () => {
      resolve(startPort + Math.floor(Math.random() * 1000));
    });
  });
}

export interface OpenCodeRunContext {
  db: CoreDatabase;
  broadcaster: EventBroadcaster;
  attemptId: string;
  requestId: string;
  conversationId: string;
  workspaceRoot: string;
  prompt: string;
  model?: string;
  fenceToken: string;
  signal?: AbortSignal;
  manageAttemptLifecycle?: boolean;
}

export class OpenCodeEngine {
  private static activeServers = new Map<string, { port: number; process: cp.ChildProcess; serverUrl: string; password: string }>();

  static async ensureServer(workspaceRoot: string): Promise<{ port: number; serverUrl: string; password: string }> {
    const existing = this.activeServers.get(workspaceRoot);
    if (existing && !existing.process.killed) {
      try {
        const ping = await fetch(existing.serverUrl + '/api/session', {
          signal: AbortSignal.timeout(500),
          headers: { Authorization: `Basic ${Buffer.from(`opencode:${existing.password}`).toString('base64')}` },
        });
        if (ping.ok) return { port: existing.port, serverUrl: existing.serverUrl, password: existing.password };
      } catch {
        // needs restart
      }
    }

    // Configure workspace .opencode/opencode.json
    const opencodeDir = path.join(workspaceRoot, '.opencode');
    fs.mkdirSync(opencodeDir, { recursive: true });
    const configPath = path.join(opencodeDir, 'opencode.json');
    const config = withPandeshPermissions({
      $schema: 'https://opencode.ai/config.json',
      autoupdate: false,
      share: 'disabled',
      provider: {
        ollama: {
          npm: '@ai-sdk/openai-compatible',
          name: 'Ollama',
          options: {
            baseURL: `${DEFAULT_OLLAMA_URL}/v1`,
            apiKey: 'ollama-no-key',
          },
          models: {
            'qwen3-coder:swift-27b': {
              name: 'qwen3-coder:swift-27b',
              tool_call: true,
              reasoning: false,
              limit: { context: 65536, output: 4096 },
            },
            'qwen3.8:27b-mtp-q4_K_M': {
              name: 'qwen3.8:27b-mtp-q4_K_M',
              tool_call: true,
              reasoning: false,
              limit: { context: 65536, output: 4096 },
            },
          },
        },
      },
      model: `ollama/${DEFAULT_MODEL}`,
    });
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf8');

    const port = await getFreePort();
    const serverUrl = `http://127.0.0.1:${port}`;
    // Per-session random credential: kept in memory, not written to workspace configuration.
    const password = randomBytes(32).toString('hex');
    const exe = findOpenCodeExe();
    const isCmd = process.platform === 'win32' && (exe.endsWith('.cmd') || exe.endsWith('.bat') || exe === 'opencode');

    const server = cp.spawn(exe, ['serve', '--hostname', '127.0.0.1', '--port', String(port)], {
      cwd: workspaceRoot,
      env: openCodeEnv(workspaceRoot, config, { OPENCODE_SERVER_PASSWORD: password, OPENCODE_PASSWORD: password }),
      stdio: 'ignore',
      shell: isCmd,
      windowsHide: true,
    });
    server.on('error', () => {});

    let up = false;
    for (let i = 0; i < 40 && !up; i++) {
      try {
        const r = await fetch(serverUrl + '/api/session', {
          signal: AbortSignal.timeout(500),
          headers: { Authorization: `Basic ${Buffer.from(`opencode:${password}`).toString('base64')}` },
        });
        up = r.ok;
      } catch {
        await new Promise((r) => setTimeout(r, 250));
      }
    }

    if (!up) {
      try { server.kill(); } catch {}
      throw new Error(`OpenCode server failed to start on ${serverUrl}`);
    }

    this.activeServers.set(workspaceRoot, { port, process: server, serverUrl, password });
    return { port, serverUrl, password };
  }

  static stopServer(workspaceRoot: string): void {
    const entry = this.activeServers.get(workspaceRoot);
    if (entry) {
      // Signal only the child process this adapter owns. PID-based taskkill risks PID reuse.
      try { if (!entry.process.killed) entry.process.kill(); } catch {}
      this.activeServers.delete(workspaceRoot);
    }
  }

  /**
   * Executes an autonomous coding objective in the given workspace using OpenCode.
   * Emits live events to KKD database and WebSocket broadcaster so Kaam ka Dhaaga stays updated.
   */
  static async executeCodingObjective(ctx: OpenCodeRunContext): Promise<EngineExecutionResult> {
    const { db, broadcaster, attemptId, requestId, conversationId, workspaceRoot, prompt, fenceToken, signal } = ctx;
    const actor = 'karkedikha:opencode';
    const startTime = Date.now();

    // Capture pre-execution file snapshot for verified artifact detection
    const snapshotPre = new Map<string, number>();
    const scanDir = (dir: string, depth = 0) => {
      if (depth > 4) return;
      try {
        const entries = fs.readdirSync(dir, { withFileTypes: true });
        for (const e of entries) {
          if (e.name === '.git' || e.name === 'node_modules' || e.name === '.opencode') continue;
          const full = path.join(dir, e.name);
          if (e.isFile()) {
            try { snapshotPre.set(full, fs.statSync(full).mtimeMs); } catch {}
          } else if (e.isDirectory()) {
            scanDir(full, depth + 1);
          }
        }
      } catch {}
    };
    scanDir(workspaceRoot);

    const manageLifecycle = ctx.manageAttemptLifecycle !== false;
    // Transition attempt to running if managing lifecycle
    if (manageLifecycle) {
      try {
        mutateWithBroadcast(db, broadcaster, () => {
          transitionAttempt(db, attemptId, { toStatus: 'running', fenceToken, actor });
        });
      } catch {}
    }

    safeRecordRuntimeEvent(db, broadcaster, attemptId, 'step_start', {
      step: 1,
      engine: 'opencode',
      mode: 'karke_dikha',
      workspace: workspaceRoot,
      prompt: prompt.slice(0, 300),
    }, actor);
    

    // Workspace-level opencode config pinned to Pandesh's permission policy
    const effectiveModel = ctx.model || DEFAULT_MODEL;
    // OpenCode talks to Ollama's /v1 endpoint; pin the model first so the run does not pay a cold load mid-session.
    await ensureModelResident(effectiveModel, { signal });
    const opencodeDir = path.join(workspaceRoot, '.opencode');
    const config = withPandeshPermissions({
        $schema: 'https://opencode.ai/config.json',
        autoupdate: false,
        share: 'disabled',
        provider: {
          ollama: {
            npm: '@ai-sdk/openai-compatible',
            name: 'Ollama',
            options: {
              baseURL: `${DEFAULT_OLLAMA_URL}/v1`,
              apiKey: 'ollama-no-key',
            },
            models: {
              'qwen3-coder:swift-27b': {
                name: 'qwen3-coder:swift-27b',
                tool_call: true,
                reasoning: false,
                limit: { context: 32768, output: 4096 },
              },
              'qwen3.8:27b-mtp-q4_K_M': {
                name: 'qwen3.8:27b-mtp-q4_K_M',
                tool_call: true,
                reasoning: false,
                limit: { context: 32768, output: 4096 },
              },
              [effectiveModel]: {
                name: effectiveModel,
                tool_call: true,
                reasoning: false,
                limit: { context: 32768, output: 4096 },
              },
            },
          },
        },
        model: `ollama/${effectiveModel}`,
        small_model: `ollama/${effectiveModel}`,
        enabled_providers: ['ollama'],
    });
    try {
      fs.mkdirSync(opencodeDir, { recursive: true });
      fs.writeFileSync(path.join(opencodeDir, 'opencode.json'), JSON.stringify(config, null, 2), 'utf8');
    } catch (err: any) {
      // A stale workspace config could still grant OpenCode more than Pandesh allows: do not run.
      const errMessage = `OpenCode was not started: Pandesh could not apply its permission policy in ${workspaceRoot} (${err?.message ?? err}).`;
      try {
        mutateWithBroadcast(db, broadcaster, () => {
          failAttempt(db, attemptId, { failureReason: errMessage, fenceToken, actor });
        });
      } catch {}
      safeRecordRuntimeEvent(db, broadcaster, attemptId, 'step_finish', { step: 1, status: 'failed', error: errMessage }, actor);
      return { success: false, reply: errMessage, error: errMessage, modifiedFiles: [], metrics: { totalMs: Date.now() - startTime } };
    }

    const exe = findOpenCodeExe();
    // OpenCode 2.x otherwise hands `run` to a shared background service that uses the global config, where the
    // default can be a cloud provider. A private server with the model named outright keeps this on local Ollama.
    const args = [
      'run',
      '--standalone',
      '--model', `ollama/${effectiveModel}`,
      '--format', 'json',
      prompt
    ];

    const isCmd = exe.endsWith('.cmd') || exe.endsWith('.bat');
    const child = cp.spawn(exe, args, {
      cwd: workspaceRoot,
      env: openCodeEnv(workspaceRoot, config),
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: isCmd,
      windowsHide: true,
    });

    let stdout = '';
    let stderr = '';
    const activeToolInvocations = new Map<string, string>(); // partId -> invocationId
    const toolCallsRecorded: Array<{ tool: string; args?: unknown; status?: string }> = [];

    if (signal) {
      signal.addEventListener('abort', () => {
        try { child.kill('SIGTERM'); } catch {}
      });
    }

    let lineBuf = '';
    child.stdout.on('data', (chunk) => {
      const text = chunk.toString();
      stdout += text;
      lineBuf += text;
      const lines = lineBuf.split(/\r?\n/);
      lineBuf = lines.pop() || '';

      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const ev = JSON.parse(line);
          const evType = ev.type || ev.part?.type;

          if (evType === 'tool_use' || ev.type === 'tool_use') {
            const toolName = ev.part?.tool || ev.tool || 'code_edit';
            const partId = ev.part?.id || `tool-${Date.now()}`;
            const state = ev.part?.state?.status || 'running';
            const args = ev.part?.state?.input || {};

            let invId = activeToolInvocations.get(partId);
            if (!invId) {
              let rec: any;
              try {
                mutateWithBroadcast(db, broadcaster, () => {
                  rec = startToolInvocation(db, {
                    attemptId,
                    toolName,
                    argsSummary: args,
                    actor,
                  });
                });
              } catch {}
              if (rec?.id) {
                invId = rec.id;
                activeToolInvocations.set(partId, rec.id as string);
              }

              safeRecordRuntimeEvent(db, broadcaster, attemptId, 'tool_call', { toolName, args, invocationId: invId }, actor);
              toolCallsRecorded.push({ tool: toolName, args, status: 'started' });
            }

            if (state === 'completed' || state === 'done' || state === 'success') {
              if (invId) {
                try {
                  mutateWithBroadcast(db, broadcaster, () => {
                    completeToolInvocation(db, invId!, {
                      status: 'succeeded',
                      exitCode: 0,
                      evidence: { tool: toolName, output: ev.part?.state?.output },
                      actor,
                    });
                  });
                } catch {}
              }
              safeRecordRuntimeEvent(db, broadcaster, attemptId, 'tool_result', { toolName, success: true, invocationId: invId }, actor);
              const done = [...toolCallsRecorded].reverse().find((call) => call.tool === toolName && call.status === 'started');
              if (done) done.status = 'succeeded';
              activeToolInvocations.delete(partId);
            } else if (state === 'failed' || state === 'error') {
              if (invId) {
                try {
                  mutateWithBroadcast(db, broadcaster, () => {
                    completeToolInvocation(db, invId!, {
                      status: 'failed',
                      exitCode: 1,
                      evidence: { tool: toolName, error: ev.part?.state?.error },
                      actor,
                    });
                  });
                } catch {}
              }
              const broke = [...toolCallsRecorded].reverse().find((call) => call.tool === toolName && call.status === 'started');
              if (broke) broke.status = 'failed';
              activeToolInvocations.delete(partId);
            }
          } else if (evType === 'text') {
            const chunkText = ev.part?.text || '';
            if (chunkText && broadcaster && typeof broadcaster.publishRuntimeToken === 'function') {
              broadcaster.publishRuntimeToken({
                attemptId,
                invocationId: 'opencode',
                delta: chunkText,
              });
            }
          }
        } catch {}
      }
    });

    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });

    // A process that could not even start has no stderr; keep its reason so the failure is diagnosable, not "code 1".
    let spawnError: string | null = null;
    const exitCode = await new Promise<number>((resolve) => {
      child.on('close', (code) => resolve(code ?? 0));
      child.on('error', (err) => { spawnError = `could not start OpenCode (${exe}): ${err.message}`; resolve(1); });
    });

    for (const [openPartId, openInvocationId] of activeToolInvocations) {
      try {
        mutateWithBroadcast(db, broadcaster, () => {
          completeToolInvocation(db, openInvocationId, {
            status: 'failed',
            exitCode: null,
            evidence: { error: 'OpenCode ended before this tool call reported a result' },
            actor,
          });
        });
      } catch { /* already settled */ }
      activeToolInvocations.delete(openPartId);
    }

    // Extract final response text
    const events = stdout
      .split(/\r?\n/)
      .map((l) => { try { return JSON.parse(l); } catch { return null; } })
      .filter(Boolean);

    let lastToolIdx = -1;
    events.forEach((e, i) => {
      if (e.type === 'tool_use' || e.part?.type === 'tool_use') lastToolIdx = i;
    });

    let reply = events
      .slice(lastToolIdx + 1)
      .filter((e) => e.type === 'text' || e.part?.type === 'text')
      .map((e) => e.part?.text || e.text || '')
      .join('\n')
      .trim();

    if (!reply) {
      reply = events
        .filter((e) => e.type === 'text' || e.part?.type === 'text')
        .map((e) => e.part?.text || e.text || '')
        .join('\n')
        .trim();
    }

    // Detect modified files
    const modifiedFiles: string[] = [];
    const scanPost = (dir: string, depth = 0) => {
      if (depth > 4) return;
      try {
        const entries = fs.readdirSync(dir, { withFileTypes: true });
        for (const e of entries) {
          if (e.name === '.git' || e.name === 'node_modules' || e.name === '.opencode') continue;
          const full = path.join(dir, e.name);
          if (e.isFile()) {
            try {
              const mtime = fs.statSync(full).mtimeMs;
              const pre = snapshotPre.get(full);
              if (pre === undefined || mtime > pre) {
                modifiedFiles.push(full);
              }
            } catch {}
          } else if (e.isDirectory()) {
            scanPost(full, depth + 1);
          }
        }
      } catch {}
    };
    scanPost(workspaceRoot);

    // Register discovered artifacts
    for (const filePath of modifiedFiles) {
      try {
        const fileName = path.basename(filePath);
        registerArtifact(db, {
          attemptId,
          conversationId,
          requestId,
          kind: 'file',
          title: fileName,
          mimeType: 'text/plain',
          absolutePath: filePath,
          source: 'opencode',
          actor: 'karkedikha:opencode',
          metadata: { workspaceRoot, relativePath: path.relative(workspaceRoot, filePath) },
        });
      } catch {}
    }

    // Append final message to conversation — only when this engine owns the turn. Delegated from the chat engine
    // (manageAttemptLifecycle: false), the chat engine writes the one reply, with Core's verified report (D12: M8 showed
    // a second, unverified assistant message and the attempt completed underneath the chat engine).
    if (reply && conversationId && manageLifecycle) {
      try {
        appendMessage(db, conversationId, {
          role: 'assistant',
          content: reply,
          actor,
        });
      } catch {}
    }

    const totalMs = Date.now() - startTime;
    try {
      recordExecutionQuality(db, attemptId, {
        eventType: 'final_verification_recorded',
        actor,
        metadata: {
          passed: exitCode === 0,
          totalMs,
          modifiedFilesCount: modifiedFiles.length,
          toolCallsCount: toolCallsRecorded.length,
        },
      });
    } catch {}

    if (signal?.aborted) {
      // The user stopped this work. Whatever was already written stays registered above;
      // the attempt is settled as cancelled (never completed or failed), and only once the worker has exited.
      if (manageLifecycle) {
        try {
          mutateWithBroadcast(db, broadcaster, () => {
            settleCancelledAttempt(db, attemptId, { actor, fenceToken });
          });
        } catch (e) {
          console.error('[opencodeEngine] settleCancelledAttempt error:', e);
        }
      }
      safeRecordRuntimeEvent(db, broadcaster, attemptId, 'step_finish', {
        step: 1,
        status: 'cancelled',
        modifiedFiles,
        totalMs,
      }, actor);
      return {
        success: false,
        reply: modifiedFiles.length > 0
          ? `Stopped. ${modifiedFiles.length} file(s) written before the stop were kept.`
          : 'Stopped before any files were written.',
        modifiedFiles,
        toolCalls: toolCallsRecorded,
        metrics: { totalMs },
      };
    }

    // A clean exit is not an outcome. Completed needs evidence: files that really changed, a tool call that really
    // succeeded, or an answer OpenCode actually wrote. Otherwise the attempt fails and says nothing was verified.
    const succeededToolCalls = toolCallsRecorded.filter((call) => call.status === 'succeeded').length;
    const outsideWrites = toolCallsRecorded
      .filter((call) => call.status === 'succeeded' && /^(write|edit|multiedit|patch)$/i.test(call.tool))
      .map((call) => { try { const a = JSON.parse(String(call.args)); return String(a.path ?? a.filePath ?? ''); } catch { return ''; } })
      .filter((target) => {
        if (!target || !path.isAbsolute(target)) return false;
        const rel = path.relative(workspaceRoot, target);
        return rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel);
      });
    const unverifiedReason = outsideWrites.length > 0
      ? `OpenCode wrote outside the selected workspace (${outsideWrites[0]}), so this is not reported as done. The file was left where it is; nothing in ${workspaceRoot} was verified.`
      : exitCode === 0 && modifiedFiles.length === 0 && succeededToolCalls === 0 && !reply
      ? (toolCallsRecorded.length > 0
        ? `OpenCode exited normally, but all ${toolCallsRecorded.length} of its tool calls failed, no file changed and it wrote no answer. Nothing was verified.`
        : 'OpenCode exited normally, but it wrote no answer, changed no file and ran no tool. Nothing was verified.')
      : null;

    if (exitCode === 0 && !unverifiedReason) {
      if (manageLifecycle) {
        try {
          mutateWithBroadcast(db, broadcaster, () => {
            transitionAttempt(db, attemptId, { toStatus: 'completed', fenceToken, actor });
          });
        } catch (e) {
          console.error('[opencodeEngine] transitionAttempt error:', e);
        }
      }
      safeRecordRuntimeEvent(db, broadcaster, attemptId, 'step_finish', {
        step: 1,
        status: 'completed',
        modifiedFiles,
        totalMs,
      }, actor);

      return {
        success: true,
        reply,
        modifiedFiles,
        toolCalls: toolCallsRecorded,
        metrics: { totalMs },
      };
    } else {
      const errMessage = spawnError ?? unverifiedReason ?? (stderr.slice(-300) || `OpenCode exited with code ${exitCode}, and printed nothing on its error stream (last output: ${stdout.slice(-160).replace(/\s+/g, ' ') || 'none'})`);
      if (manageLifecycle) {
        try {
          mutateWithBroadcast(db, broadcaster, () => {
            failAttempt(db, attemptId, {
              failureReason: errMessage,
              fenceToken,
              actor,
            });
          });
        } catch (e) {
          console.error('[opencodeEngine] failAttempt error:', e);
        }
      }
      safeRecordRuntimeEvent(db, broadcaster, attemptId, 'step_finish', {
        step: 1,
        status: 'failed',
        error: errMessage,
      }, actor);
      

      return {
        success: false,
        reply: reply || `Coding task failed: ${errMessage}`,
        error: errMessage,
        modifiedFiles,
        metrics: { totalMs },
      };
    }
  }
}

/**
 * OpenCode Engine Adapter implementing EngineAdapter interface
 */
export class OpenCodeEngineAdapter implements EngineAdapter {
  readonly id = 'opencode';
  readonly name = 'OpenCode Agent';
  readonly role = 'coding' as const;
  readonly description = 'Specialized autonomous coding engine using OpenCode';

  async isAvailable(): Promise<boolean> {
    try {
      const exe = findOpenCodeExe();
      if (fs.existsSync(exe)) return true;
      const res = cp.spawnSync(exe, ['--version'], { windowsHide: true });
      return res.status === 0;
    } catch {
      return false;
    }
  }

  async execute(prompt: string, options?: EngineExecutionOptions): Promise<EngineExecutionResult> {
    const workspaceRoot = options?.workingDirectory || process.cwd();
    const serverInfo = await OpenCodeEngine.ensureServer(workspaceRoot);
    const exe = findOpenCodeExe();
    const isCmd = process.platform === 'win32' && (exe.endsWith('.cmd') || exe.endsWith('.bat') || exe === 'opencode');

    // No --auto: it approves every permission not explicitly denied, which would let OpenCode act without Pandesh.
    const args = ['run', '--server', serverInfo.serverUrl, '--format', 'json', prompt];
    const res = cp.spawnSync(exe, args, {
      cwd: workspaceRoot,
      env: openCodeEnv(workspaceRoot, withPandeshPermissions({}), {
        OPENCODE_SERVER_PASSWORD: serverInfo.password,
        OPENCODE_PASSWORD: serverInfo.password,
      }),
      encoding: 'utf8',
      timeout: options?.timeoutMs || 120000,
      shell: isCmd,
      windowsHide: true,
    });

    const out = res.stdout || '';
    const events = out
      .split(/\r?\n/)
      .map((l) => { try { return JSON.parse(l); } catch { return null; } })
      .filter(Boolean);

    let lastToolIdx = -1;
    events.forEach((e, i) => {
      if (e.type === 'tool_use' || e.part?.type === 'tool_use') lastToolIdx = i;
    });

    const reply = events
      .slice(lastToolIdx + 1)
      .filter((e) => e.type === 'text' || e.part?.type === 'text')
      .map((e) => e.part?.text || e.text || '')
      .join('\n')
      .trim();

    return {
      success: res.status === 0,
      reply: reply || (res.status === 0 ? 'Completed' : 'Execution error'),
      error: res.status !== 0 ? res.stderr : undefined,
    };
  }
}

EngineRegistry.register(new OpenCodeEngineAdapter());
