/**
 * KarkeDikha Core process entry point. Launched detached via
 * `ELECTRON_RUN_AS_NODE=1 <electron-binary> out-core/core.js`; must never be
 * imported from the Extension Host (see M31 architecture — the Core runs
 * outside the Extension Host process entirely).
 *
 * Required environment variables:
 *   KARKEDIKHA_CORE_TOKEN     - bearer token clients must present (never logged)
 *   KARKEDIKHA_DATA_DIR       - override for the global data dir (tests only; real
 *                               installs resolve the OS-appropriate default)
 *   KARKEDIKHA_CORE_PORT      - optional fixed port (default: OS-assigned ephemeral)
 *   KARKEDIKHA_OPENROUTER_API_KEY - host-injected OpenRouter key (never logged)
 */
import { execFile } from 'node:child_process';
import * as crypto from 'node:crypto';
import { resolveDataDir, resolvePaths } from './env/dataDir';
import { openCoreDatabase } from './db/openCore';
import { CoreDatabaseFailedError } from './db/preflight';
import { failDeadExecutorAttemptsOnBoot, scanOrphanedAttemptsOnBoot } from './domain/bootReconciliation';
import { createWeatherCapabilityAdapter } from './runtime/weatherCapability';
import { createFilesystemCapabilityAdapter } from './runtime/filesystemCapability';
import { createNetworkDriveCapabilityAdapter } from './runtime/networkDriveCapability';
import { createSystemManagementCapabilityAdapter } from './runtime/systemManagementCapability';
import { createPortManagementCapabilityAdapter } from './runtime/portManagementCapability';
import { createIntelligenceScoutCapabilityAdapter } from './runtime/intelligenceScoutCapability';
import { createIntelligenceScout, type IntelligenceScout } from './runtime/intelligenceScout';
import { createComputerUseCapabilityAdapter } from './runtime/computerUseCapability';
import { createHermesSkillCapabilityAdapter } from './runtime/hermesSkillCapability';
import { createPortProcessManager } from './runtime/portManager';
import { acquireSingleton } from './singleton/acquireSingleton';
import { writeDiscoveryRecord, removeDiscoveryRecord } from './discovery/record';
import { startApiServer } from './api/server';
import { attachWsServer } from './ws/server';
import { EventBroadcaster } from './ws/broadcaster';
import { latestSequence } from './domain/events';
import type { CoreInfo } from './shared/wireTypes';
import { CORE_API_VERSION } from './shared/wireTypes';
import { hashCoreBundle } from './runtime/coreBundle';
import type { CoreDatabase } from './db/connection';
import { LocalAutonomySecurityKernel } from './security/kernel';
import { GovernedCapabilityRegistry, createWorkspaceCapabilityAdapter } from './runtime/governedCapability';
import { createGithubCapabilityAdapter, type GithubCommandExecutor } from './runtime/githubCapability';
import { createResearchCapabilityAdapter } from './runtime/researchCapability';
import { createMemoryCapabilityAdapter } from './runtime/memoryCapability';
import { createBrowserCapabilityAdapter } from './runtime/browserCapability';
import { createImageStudioCapabilityAdapter } from './runtime/imageStudioCapability';
import { resolveHostBrowserBin } from './runtime/hostBrowserBin';
import { buildConnectorAdapters } from './runtime/connectors/connectorDefinitions';
import type { ConnectorAdapter } from './runtime/connectors/connectorCapability';
import { createGwsGmailProbe, createGwsGmailExecutor, createGwsGmailPrepare, defaultGwsGmailConfigDir, type GwsGmailAdapterConfig, type GwsGmailDraftBindingStore } from './runtime/connectors/gwsGmailAdapter';
import { getGmailAccessToken, getGmailAccountEmail, googleScopeGranted } from './runtime/connectors/gmailAccessTokenStore';
import { CALENDAR_EVENTS_SCOPE, createGwsCalendarExecutor, createGwsCalendarPrepare, createGwsCalendarProbe, defaultGwsCalendarConfigDir } from './runtime/connectors/gwsCalendarAdapter';
import { recordGmailDraftBinding, getGmailDraftBinding } from './domain/gmailDrafts';
import { createGmailOrganizeStore } from './domain/gmailChangePlans';
import { GMAIL_MODIFY_SCOPE } from './runtime/connectors/gmailOrganize';
import { recordRuntimeEvent } from './domain/runtimeEvents';
import { configureDailyBriefRoutine, getDailyBriefRoutine } from './domain/assistantRoutine';
import type { ConnectorId } from './shared/wireTypes';
import { localRerouteEnvironment } from './runtime/autoRerouteRuntime';

/**
 * Acceptance-only escape hatch: when set, the GitHub capability shells out
 * to `node <this script> <args>` instead of the real `gh` on PATH. This
 * exists only because `execFile('gh', ...)` without a shell (the real
 * `defaultExecutor` in `githubCapability.ts`) cannot resolve a PATH-scoped
 * `.cmd`/`.bat` fake `gh` on Windows: Win32 `CreateProcess` auto-appends
 * `.exe` to an extensionless command and never falls back to `.cmd`/`.bat`
 * without a shell, so a fake `gh.cmd` is silently skipped in favor of any
 * real `gh.exe` elsewhere on PATH, regardless of directory order. Invoking
 * `node <script>` sidesteps that entirely (`node.exe` is always resolvable,
 * and the fake script is passed as an explicit argument, no PATH search
 * involved) while still shelling out to a real child process with the same
 * argv/cwd/timeout/signal contract `GithubCommandExecutor` requires — this
 * swaps only the external command, never the approval/dispatch policy.
 * Unset (the default) leaves production behavior exactly as it was: the
 * real `defaultExecutor` shelling out to `gh`.
 */
function testGithubExecutorOverride(): GithubCommandExecutor | undefined {
  const scriptPath = process.env.KARKEDIKHA_TEST_GH_EXECUTOR_SCRIPT;
  if (!scriptPath) return undefined;
  return (args, opts) =>
    new Promise((resolve) => {
      execFile(
        process.execPath,
        [scriptPath, ...args],
        { cwd: opts.cwd, windowsHide: true, maxBuffer: 8 * 1024 * 1024, encoding: 'utf8', timeout: opts.timeoutMs, signal: opts.signal },
        (err, stdout, stderr) => {
          const code = err && typeof (err as NodeJS.ErrnoException & { code?: number }).code === 'number'
            ? (err as unknown as { code: number }).code
            : err ? 1 : 0;
          resolve({ stdout: String(stdout ?? ''), stderr: String(stderr ?? err?.message ?? ''), code });
        },
      );
    });
}

/**
 * M38: external-service capabilities (GitHub, governed research) are reached
 * through `POST /v1/capabilities/dispatch` (the extension-host Forge/legacy
 * tool-calling path) AND through `RuntimeExecutor`'s real packaged Saath Kar
 * agent loop — both dispatch the same governed decision/approval/evidence
 * path (`core/domain/capabilityDispatch.ts`), never a second authority.
 *
 * One `GovernedCapabilityRegistry` is shared by the HTTP dispatch route and
 * `RuntimeExecutor`, including the workspace adapter. Workspace reads remain
 * immediate while consequential workspace calls use `dispatchCapability`.
 * This ensures `run_command` cannot bypass durable mutation approval. It
 * exposes the pre-existing `run_command`/`read_file` definitions while routing
 * their execution through the approval-gated `dispatchCapability` path. The
 * GitHub capability
 * is registered only when a governed repository is explicitly configured —
 * an unconfigured capability is simply absent from the tool set (honest
 * absence), not a fake always-on blocker.
 */
/**
 * Jarvis Connector Foundation: unlike GitHub (opt-in, absent when
 * unconfigured), Gmail/Google Calendar/WhatsApp/Printer are the fixed
 * Everyday Tools catalog set and must always be registered so the registry
 * can truthfully report `not_configured` rather than silently omitting them
 * (see core/domain/connectors.ts).
 *
 * Gmail's `probe`/`executor` are backed by the pinned `gws` transport
 * (core/runtime/connectors/gwsGmailAdapter.ts) — see AI_OS_ARCHITECTURE.md
 * "Google Workspace CLI (`gws`) as connector transport" and "Gmail draft-bound
 * send safety" for the design. `isConfigured()` (the fixed
 * `CONNECTOR_CREDENTIAL_ENV.gmail` env var, set by Desktop only when a
 * refresh token is stored) reports whether Gmail is *connected*; the actual
 * short-lived access token used for every live `gws` call instead comes from
 * `gmailAccessTokenStore.ts`, an in-memory slot Desktop pushes into over an
 * authenticated loopback call so a token refresh never requires restarting
 * this Core process. Live calls also require `KARKEDIKHA_GWS_BIN` (the
 * pinned, digest-verified binary) to be staged. Google Calendar uses the same
 * grant and token (gwsCalendarAdapter.ts) and is usable only when Google
 * granted the calendar.events scope. WhatsApp/Printer still have no
 * `probe`/`executor` — they perform no live action; a future milestone wires
 * a real adapter behind this same seam.
 */
function buildConnectorRegistry(dataDir: string, db: CoreDatabase): Map<ConnectorId, ConnectorAdapter> {
  const bindings: GwsGmailDraftBindingStore = {
    record: (content) => recordGmailDraftBinding(db, { content }),
    get: (draftId) => getGmailDraftBinding(db, draftId),
  };
  const gmailAdapterConfig: GwsGmailAdapterConfig = {
    getAccessToken: () => getGmailAccessToken(),
    getAccountEmail: () => getGmailAccountEmail(),
    configDir: defaultGwsGmailConfigDir(dataDir),
    bindings,
    organize: {
      store: createGmailOrganizeStore(db),
      // Incremental consent: inbox changes need gmail.modify, which Desktop requests only when the user opts in.
      hasModifyScope: () => googleScopeGranted(GMAIL_MODIFY_SCOPE),
      onProgress: (event) => {
        try {
          recordRuntimeEvent(db, { domain: 'connector', entityId: 'gmail', eventType: 'gmail_organize_progress', actor: 'core', metadata: { ...event } });
        } catch { /* progress is advisory; a failed event never fails the tool */ }
      },
    },
  };
  // Google Calendar rides the same OAuth grant and access token as Gmail; it is
  // only usable when Google actually granted the calendar.events scope.
  const calendarAdapterConfig = {
    getAccessToken: () => getGmailAccessToken(),
    getAccountEmail: () => getGmailAccountEmail(),
    hasCalendarScope: () => googleScopeGranted(CALENDAR_EVENTS_SCOPE),
    configDir: defaultGwsCalendarConfigDir(dataDir),
  };
  return buildConnectorAdapters({
    gmail: {
      isConnected: () => getGmailAccountEmail() !== null,
      probe: createGwsGmailProbe(gmailAdapterConfig),
      executor: createGwsGmailExecutor(gmailAdapterConfig),
      prepare: createGwsGmailPrepare(gmailAdapterConfig),
    },
    google_calendar: {
      isConnected: () => getGmailAccountEmail() !== null && googleScopeGranted(CALENDAR_EVENTS_SCOPE),
      notConfiguredReason: () => (getGmailAccountEmail() !== null
        ? 'Google did not grant Calendar access for this sign-in. Disconnect and connect Google again to add it.'
        : 'Google is not connected. Connect Google to use Calendar.'),
      probe: createGwsCalendarProbe(calendarAdapterConfig),
      executor: createGwsCalendarExecutor(calendarAdapterConfig),
      prepare: createGwsCalendarPrepare(calendarAdapterConfig),
    },
  });
}

function buildCapabilityRegistry(dataDir: string, db: CoreDatabase, connectors: Map<ConnectorId, ConnectorAdapter>, scout: IntelligenceScout): GovernedCapabilityRegistry {
  const research = createResearchCapabilityAdapter();
  const githubRepository = process.env.KARKEDIKHA_GITHUB_REPOSITORY;
  const github = githubRepository
    ? createGithubCapabilityAdapter({ repository: githubRepository, cwd: dataDir, executor: testGithubExecutorOverride() })
    : undefined;
  // M39: one shared memory adapter lets the HTTP route and RuntimeExecutor
  // reach one governed memory capability and approval authority.
  const memory = createMemoryCapabilityAdapter({ db });
  const imageStudioRoot = process.env.KARKEDIKHA_IMAGE_STUDIO_ROOT
    ?? (process.platform === 'win32' ? 'C:\\Projects\\ImageGeneration' : '/opt/ImageGeneration');

  const registry = new GovernedCapabilityRegistry()
    .register(createWorkspaceCapabilityAdapter())
    .register(research)
    .register(memory)
    .register(createImageStudioCapabilityAdapter({ db, studioRoot: imageStudioRoot }))
    .register(createBrowserCapabilityAdapter({ browserBin: resolveHostBrowserBin() }))
    .register(createComputerUseCapabilityAdapter({ dataDir }))
    .register(createHermesSkillCapabilityAdapter())
    .register(createWeatherCapabilityAdapter())
    .register(createFilesystemCapabilityAdapter())
    .register(createNetworkDriveCapabilityAdapter())
    .register(createSystemManagementCapabilityAdapter())
  .register(createPortManagementCapabilityAdapter({ dataDir }))
  .register(createIntelligenceScoutCapabilityAdapter({ dataDir, db, scout }));
  if (github) {
    registry.register(github);
  }
  for (const adapter of connectors.values()) {
    registry.register(adapter);
  }
  return registry;
}

// Baked in at build time by esbuild.core.js via a `define` replacement. core/index.ts is only
// ever executed as the bundled out-core/core.js (spawned as a detached child process — see
// core/test/coreProcess.test.ts); it is never imported directly by any test or dev-time runner.
// A `require('../package.json')` fallback was tried here previously and is deliberately not
// used: even guarded behind a dead `typeof` branch, esbuild's bundler still resolves and inlines
// the entire package.json (including the "scripts" section, full of internal harness file paths)
// into the shipped Core bundle before minification can prove the branch unreachable.
declare const __KARKEDIKHA_CORE_VERSION__: string | undefined;

function resolveCoreVersion(): string {
  return typeof __KARKEDIKHA_CORE_VERSION__ !== 'undefined' ? __KARKEDIKHA_CORE_VERSION__ : '0.0.0-dev';
}

function redactedLog(message: string): void {
  // Never write the token or full Authorization headers here; this is the only logging surface
  // for the Core process (stdio is 'ignore' when spawned detached in production, so in practice
  // this only matters for the manual/dev launch path and diagnostics).
  // eslint-disable-next-line no-console
  console.log(`[karkedikha-core ${new Date().toISOString()}] ${message}`);
}

async function main(): Promise<void> {
  const token = process.env.KARKEDIKHA_CORE_TOKEN;
  if (!token) {
    console.error(`[karkedikha-core ${new Date().toISOString()}] KARKEDIKHA_CORE_TOKEN is not set; refusing to start unauthenticated.`);
    process.exit(1);
  }

  const dataDir = resolveDataDir();
  const paths = resolvePaths(dataDir);
  const coreVersion = resolveCoreVersion();
  const startedAt = new Date().toISOString();

  let db: CoreDatabase;
  try {
    ({ db } = openCoreDatabase(paths.databasePath));
  } catch (err) {
    if (err instanceof CoreDatabaseFailedError) {
      console.error(`[karkedikha-core ${new Date().toISOString()}] database_failed: ${err.diagnosticReason}`);
    } else {
      console.error(`[karkedikha-core ${new Date().toISOString()}] database_failed: unexpected error opening database`, err);
    }
    process.exit(1);
    return;
  }

  try {
    const settled = failDeadExecutorAttemptsOnBoot(db);
    if (settled.length > 0) {
      redactedLog(`boot reconciliation: settled ${settled.length} attempt(s) left by a dead executor without replay (${settled.map((a) => `${a.attemptId}:${a.status}->${a.outcome}`).join(', ')})`);
    }
  } catch (err) {
    redactedLog(`boot reconciliation: dead-executor settlement failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  const bootReconciliation = scanOrphanedAttemptsOnBoot(db);
  if (bootReconciliation.orphaned.length > 0) {
    redactedLog(
      `boot reconciliation: ${bootReconciliation.orphaned.length} orphaned attempt(s) require reconciliation `
      + `(${bootReconciliation.orphaned.map((a) => `${a.attemptId}:${a.status}`).join(', ')}); `
      + 'will be classified requires_reconciliation on the next client rehydration',
    );
  } else if (bootReconciliation.scanned > 0) {
    redactedLog(`boot reconciliation: ${bootReconciliation.scanned} active attempt(s) found, none orphaned`);
  }

  const instanceId = crypto.randomUUID();
  const broadcaster = new EventBroadcaster();
  const requestedPort = process.env.KARKEDIKHA_CORE_PORT ? Number(process.env.KARKEDIKHA_CORE_PORT) : undefined;
  const connectorRegistry = buildConnectorRegistry(dataDir, db);
  // One Intelligence Scout instance is shared by the capability the model
  // reaches and the scheduler that fires a watch, so both see the same
  // durable watch list and the same last-seen versions.
  const scout = createIntelligenceScout({ dataDir });
  const capabilityRegistry = buildCapabilityRegistry(dataDir, db, connectorRegistry, scout);

  // The daily brief routine is NOT created here.
  //
  // A proactive routine that speaks to the user on its own schedule is
  // something the user has to ask for: an assistant that starts reporting
  // every morning because it was installed is not a personal assistant, it
  // is a notification nobody consented to. The routine is created when the
  // operator asks for it — `configureDailyBriefRoutine`, driven by Home →
  // "Daily brief" — and it stays off until then. The follow-up check is
  // different: it only ever acts on a promise the user actually made, so it
  // needs no separate consent.

  const bundleHash = hashCoreBundle(process.argv[1]);
  const api = await startApiServer({
    db,
    token,
    broadcaster,
    dataDir,
    // The packaged Saath Kar loop and direct capability API share one
    // registry and therefore one workspace-mutation approval boundary.
    executorOptions: { dataDir, governedCapabilities: capabilityRegistry, connectorRegistry, rerouteEnvironment: localRerouteEnvironment },
    capabilityRegistry,
    connectorRegistry,
    scout,
    scheduler: true,
    port: requestedPort,
    coreInfo: (): CoreInfo => ({
      coreVersion,
      apiVersion: CORE_API_VERSION,
      instanceId,
      startedAt,
      nodeVersion: process.version,
      electronVersion: process.versions.electron ?? null,
      dataDir,
      bundleHash,
    }),
    onShutdown: () => {
      redactedLog('authenticated shutdown requested, exiting');
      shutdown().finally(() => process.exit(0));
    },
  });

  const singleton = acquireSingleton({
    lockFilePath: paths.lockFilePath,
    db,
    port: api.port,
    apiVersion: CORE_API_VERSION,
    coreVersion,
    instanceId,
  });

  if (!singleton.acquired) {
    redactedLog(`another Core instance already owns this database (${singleton.reason}); exiting`);
    await api.close();
    db.close();
    process.exit(0);
    return;
  }

  const singletonHandle = singleton.handle;
  singletonHandle.startHeartbeat();

  // Register this Core instance as a Pandesh-managed service so launcher and
  // port tools can discover its endpoint and prove ownership (PID + start).
  try {
    const portManager = createPortProcessManager({ dataDir });
    portManager.register({
      name: 'karkeDikha-core',
      port: api.port,
      pid: process.pid,
      ownedByPandesh: true,
      executable: process.execPath,
      // The unauthenticated liveness route; `/health` requires the bearer token.
      healthUrl: `http://127.0.0.1:${api.port}/v1/health`,
      // The real start time of this process, not "now": a recorded value that
      // was never true would make the PID-reuse guard unreliable.
      processStartMs: Date.now() - Math.round(process.uptime() * 1000),
    });
    // Ownership PROVENANCE. The registry flag above only records a claim;
    // this durable record is the evidence that Pandesh itself started this
    // process, and it is what the shared ownership boundary checks before it
    // is ever allowed to terminate anything. Only trusted internal code
    // writes provenance — a model-reachable registration cannot.
    portManager.recordOwnership({
      pid: process.pid,
      creationTimeMs: Date.now() - Math.round(process.uptime() * 1000),
      executablePath: process.execPath,
      source: 'core:boot',
    });
  } catch (err) {
    redactedLog(`port manager registration failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  writeDiscoveryRecord(paths.discoveryRecordPath, {
    pid: process.pid,
    port: api.port,
    apiVersion: CORE_API_VERSION,
    coreVersion,
    instanceId,
    startedAtIso: startedAt,
  });

  const wsHandle = attachWsServer({
    httpServer: api.server,
    token,
    broadcaster,
    instanceId,
    latestSequence: () => latestSequence(db),
  });

  redactedLog(
    `listening on 127.0.0.1:${api.port}, instance ${instanceId}, coreVersion ${coreVersion}, bundleHash ${bundleHash ?? 'unknown'}, apiVersion ${CORE_API_VERSION}, node ${process.version}, electron ${process.versions.electron ?? 'n/a'}, dataDir ${dataDir}`,
  );

  let shuttingDown = false;
  async function shutdown(): Promise<void> {
    if (shuttingDown) return;
    shuttingDown = true;
    wsHandle.close();
    await api.close();
    singletonHandle.release();
    removeDiscoveryRecord(paths.discoveryRecordPath);
    db.close();
  }

  process.on('SIGTERM', () => shutdown().finally(() => process.exit(0)));
  process.on('SIGINT', () => shutdown().finally(() => process.exit(0)));
}

main().catch((err) => {
  console.error(`[karkedikha-core ${new Date().toISOString()}] fatal startup error:`, err);
  process.exit(1);
});
