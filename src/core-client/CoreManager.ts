import * as vscode from 'vscode';
import * as path from 'node:path';
import { CoreLauncher, CoreLauncherOptions, defaultCorePath } from './CoreLauncher';
import { CoreClient } from './CoreClient';
import { getOrCreateCoreToken } from './tokenStore';
import { getOrCreateClientId } from './clientId';
import { Config } from '../config/Config';
import { startupTelemetry } from '../services/StartupTelemetry';
import type { CoreConnectionStatus } from './ConnectionState';
import type { StoryEventRecord, RuntimeEventRecord, RuntimeTokenFrame } from '../../core/shared/wireTypes';

/**
 * Resolves the Core data directory this extension host should use — one
 * Core per VS Code profile, not one Core for the whole OS user.
 *
 * `core/env/dataDir.ts`'s own default (`%LOCALAPPDATA%\KarkeDikha` etc.) is
 * a single machine-wide path shared by *every* VS Code profile, while
 * `getOrCreateCoreToken` generates its bearer token from `context.secrets` —
 * SecretStorage, which VS Code scopes per profile. Two different profiles
 * therefore generate two different tokens but were both being pointed at
 * the exact same Core singleton: whichever profile's Core happened to be
 * running first would permanently reject every other profile's client with
 * `authentication_failed` (M31 §5 correctly refuses to spawn a second Core
 * against a live-but-wrong-token one — that guard was never the bug).
 *
 * Fix: anchor the data directory at `context.globalStorageUri` instead of
 * the OS-wide default. That URI is the VS Code-provided, extension- and
 * profile-scoped stable storage location — exactly the same scope
 * SecretStorage already uses for the token, so a Core's dataDir and its
 * expected token are now always co-scoped by construction:
 *   - two windows in the SAME profile resolve the same `globalStorageUri`
 *     → the same dataDir → they legitimately share one Core.
 *   - two DIFFERENT profiles resolve different `globalStorageUri` values
 *     (VS Code guarantees this — see AI_OS docs / M31 architecture note)
 *     → different dataDirs → never collide, never see each other's Core.
 *   - restarting the same profile resolves the same path again — it's a
 *     stable, deterministic filesystem location, not a random one.
 *
 * `KARKEDIKHA_DATA_DIR` (the acceptance/test override) keeps strictly
 * higher precedence: when it's set, this returns `undefined` so
 * `CoreLauncher`'s own `resolveDataDir()` applies it exactly as before —
 * this function never competes with that override.
 */
export function resolveProfileScopedCoreDataDir(
  context: Pick<vscode.ExtensionContext, 'globalStorageUri'>,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  const override = env.KARKEDIKHA_DATA_DIR;
  if (override && override.trim().length > 0) {
    return undefined;
  }
  const globalStorage = context.globalStorageUri?.fsPath;
  if (!globalStorage) return undefined;
  return path.join(globalStorage, 'core-data');
}

/**
 * Bounded backoff schedule (ms) for the background reconnect loop below.
 * Roughly 75s of total headroom past the launcher's own 10s startup
 * timeout — long enough to ride out a slow cold start (first-ever DB init
 * on this machine, antivirus-scanned binary, etc.) without retrying
 * forever.
 */
const RECONNECT_BACKOFF_MS = [3_000, 6_000, 12_000, 24_000, 30_000];

/**
 * Extension-side singleton facade over CoreLauncher + CoreClient. Owns the
 * one CoreClient instance for this VS Code window; never creates a second
 * one, never falls back to a local Board store when Core is
 * unavailable. `dispose()` disconnects this window's client only — it must
 * never shut down the Core itself (other windows may still be using it).
 */
export class CoreManager implements vscode.Disposable {
  private client: CoreClient | undefined;
  private launcher: CoreLauncher | undefined;
  private token: string | undefined;
  private clientId: string | undefined;
  private bundledCoreVersion: string | undefined;
  private status: CoreConnectionStatus = { state: 'starting' };
  private readonly statusEmitter = new vscode.EventEmitter<CoreConnectionStatus>();
  readonly onStatusChange = this.statusEmitter.event;
  private readonly eventEmitter = new vscode.EventEmitter<StoryEventRecord>();
  readonly onStoryEvent = this.eventEmitter.event;
  /** M32 Priority 4: forwards Core's `runtime_event` channel (attempt/tool/model
   * invocation lifecycle) to this window's execution-relay subscribers (AgentPanel). */
  private readonly runtimeEventEmitter = new vscode.EventEmitter<RuntimeEventRecord>();
  readonly onRuntimeEvent = this.runtimeEventEmitter.event;
  /** Ephemeral live token deltas — see `RuntimeTokenFrame`'s doc comment. */
  private readonly runtimeTokenEmitter = new vscode.EventEmitter<RuntimeTokenFrame>();
  readonly onRuntimeToken = this.runtimeTokenEmitter.event;
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  private disposed = false;

  /**
   * `launcherFactory` exists purely as a test seam (default: the real
   * `CoreLauncher`) so the background reconnect loop below can be verified
   * deterministically with a scripted launcher, without spawning a real
   * Core process or depending on wall-clock time.
   */
  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly launcherFactory: (options: CoreLauncherOptions) => CoreLauncher = (options) => new CoreLauncher(options),
  ) {}

  getStatus(): CoreConnectionStatus {
    return this.status;
  }

  getClient(): CoreClient | undefined {
    return this.client;
  }

  private setStatus(status: CoreConnectionStatus): void {
    this.status = status;
    this.statusEmitter.fire(status);
  }

  private async ensureLauncher(): Promise<CoreLauncher> {
    if (this.launcher) return this.launcher;
    this.token = await getOrCreateCoreToken(this.context.secrets);
    this.clientId = await getOrCreateClientId(this.context.globalState);
    this.bundledCoreVersion = (this.context.extension.packageJSON as { version?: string }).version ?? '0.0.0';
    this.launcher = this.launcherFactory({
      corePath: defaultCorePath(this.context.extensionUri.fsPath),
      token: this.token,
      bundledCoreVersion: this.bundledCoreVersion,
      searxngUrl: Config.getSearxngUrl(),
      dataDir: resolveProfileScopedCoreDataDir(this.context),
      log: (message) => console.log(`[CoreLauncher] ${message}`),
    });
    startupTelemetry.mark('core_launcher_ready');
    return this.launcher;
  }

  /**
   * Connects the one window-scoped client and waits until client registration
   * and the initial durable snapshot have completed. Callers must not expose a
   * restoration-capable webview while this promise is unresolved: doing so can
   * make AgentPanel observe `getClient() === undefined`, complete a no-op
   * restoration, and permanently miss the durable conversation ledger for that
   * desktop session.
   */
  private async connectFromOutcome(outcome: Awaited<ReturnType<CoreLauncher['ensureCoreRunning']>>): Promise<void> {
    if (outcome.state !== 'connected') {
      this.setStatus(
        outcome.state === 'incompatible'
          ? { state: 'incompatible', detail: outcome.detail, coreVersion: outcome.info.coreVersion, apiVersion: outcome.info.apiVersion }
          : { state: outcome.state, detail: outcome.detail },
      );
      return;
    }
    startupTelemetry.mark('core_connected');
    const client = new CoreClient({
      baseUrl: outcome.baseUrl,
      token: this.token!,
      clientId: this.clientId!,
      clientVersion: this.bundledCoreVersion!,
      onStatusChange: (status) => this.setStatus(status),
      onStoryEvent: (event) => this.eventEmitter.fire(event),
      onRuntimeEvent: (event) => this.runtimeEventEmitter.fire(event),
      onRuntimeToken: (frame) => this.runtimeTokenEmitter.fire(frame),
    });
    this.client = client;
    try {
      await client.start();
      startupTelemetry.mark('initial_snapshot_ready');
    } catch (err) {
      client.dispose();
      if (this.client === client) this.client = undefined;
      this.setStatus({ state: 'unavailable', detail: `failed to initialize client session: ${(err as Error).message}` });
    }
  }

  async start(): Promise<void> {
    this.cancelReconnectLoop();
    this.setStatus({ state: 'starting' });
    const launcher = await this.ensureLauncher();
    const outcome = await launcher.ensureCoreRunning();
    await this.connectFromOutcome(outcome);
    this.scheduleReconnectIfTransient();
  }

  /** Explicit user-invoked restart (the `Restart KarkeDikha Core` command): unconditional authenticated shutdown + relaunch, then reconnects this window's client. */
  async restart(): Promise<void> {
    this.cancelReconnectLoop();
    this.client?.dispose();
    this.client = undefined;
    this.setStatus({ state: 'starting' });
    const launcher = await this.ensureLauncher();
    const outcome = await launcher.restartCore();
    await this.connectFromOutcome(outcome);
    this.scheduleReconnectIfTransient();
  }

  /**
   * Background reconnect for the "never connected in the first place" gap:
   * `CoreClient`'s own reconnect-with-backoff (see CoreClient.ts) only runs
   * once a client has actually been constructed after a successful launch —
   * it never gets a chance to run if the launcher itself didn't reach
   * 'connected' (e.g. a cold first-ever start exceeding the launcher's own
   * 10s timeout). This closes that gap with the same bounded-backoff shape,
   * so readiness updates on its own without the user reopening VS Code.
   *
   * Deliberately narrow: only retries on 'unavailable' — a plausibly
   * transient condition (slow cold start, a dead/stale discovery record).
   * 'authentication_failed', 'incompatible' and 'database_failed' are left
   * alone: per M31 §5, a live Core that simply rejects this window's
   * credentials must never trigger spawning a second one, and retrying a
   * probe against the same wrong token or an incompatible/corrupt Core
   * would never succeed anyway — those need explicit user action (the
   * "Restart KarkeDikha Core" command), not silent retries.
   */
  private scheduleReconnectIfTransient(attempt = 0): void {
    if (this.disposed || this.status.state !== 'unavailable' || attempt >= RECONNECT_BACKOFF_MS.length) {
      return;
    }
    const delay = RECONNECT_BACKOFF_MS[attempt];
    this.reconnectTimer = setTimeout(() => {
      void this.attemptReconnect(attempt);
    }, delay);
  }

  private async attemptReconnect(attempt: number): Promise<void> {
    if (this.disposed || this.status.state !== 'unavailable') return;
    this.setStatus({ state: 'reconnecting', detail: `attempting to reach KarkeDikha Core (try ${attempt + 2})` });
    const launcher = await this.ensureLauncher();
    const outcome = await launcher.ensureCoreRunning();
    await this.connectFromOutcome(outcome);
    this.scheduleReconnectIfTransient(attempt + 1);
  }

  private cancelReconnectLoop(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }
  }

  dispose(): void {
    this.disposed = true;
    this.cancelReconnectLoop();
    this.client?.dispose();
    this.statusEmitter.dispose();
    this.eventEmitter.dispose();
    this.runtimeEventEmitter.dispose();
    this.runtimeTokenEmitter.dispose();
  }
}
