import * as crypto from 'node:crypto';
import * as http from 'node:http';
import { URL } from 'node:url';
import type { CoreDatabase } from '../db/connection';
import { CoreError } from '../domain/errors';
import { verifyToken, extractBearerToken } from '../auth/token';
import { toHttpError } from './errors';
import { buildRouter, type CoreInfoProvider } from './routes';
import type { AuthenticatedPrincipal, PrincipalRole } from '../security/types';
import type { EventBroadcaster } from '../ws/broadcaster';
import { newId } from '../domain/ids';
import { RuntimeExecutor, type RuntimeExecutorOptions } from '../runtime/executor';
import { hashCoreBundle } from '../runtime/coreBundle';
import { hasInFlightCapabilityExecutions } from '../domain/capabilityDispatch';
import { GovernedResearchRunner, type GovernedResearchRunnerOptions } from '../runtime/researchRunner';
import { startScheduledTaskLoop } from '../runtime/scheduler';
import type { IntelligenceScout } from '../runtime/intelligenceScout';
import { startCancellationRecoveryLoop } from '../runtime/cancellationRecovery';
import { startDevStoryLoop } from '../runtime/kandev/devStories';
import { startFollowUpCheckLoop } from '../runtime/followUpRoutine';
import { startBackgroundTaskLoop } from '../runtime/backgroundWorker';
import { matchAttachmentUploadRoute, handleAttachmentUpload } from './attachmentUpload';
import { GovernedCapabilityRegistry, createWorkspaceCapabilityAdapter } from '../runtime/governedCapability';
import { createMemoryCapabilityAdapter } from '../runtime/memoryCapability';
import { createBrowserCapabilityAdapter } from '../runtime/browserCapability';
import { resolveHostBrowserBin } from '../runtime/hostBrowserBin';
import { buildConnectorAdapters } from '../runtime/connectors/connectorDefinitions';
import type { ConnectorAdapter } from '../runtime/connectors/connectorCapability';
import type { ConnectorId } from '../shared/wireTypes';
import type { ModelBackend } from '../runtime/modelBackend';

const MAX_BODY_BYTES = 1_000_000; // 1MB bound on request bodies
const UNAUTHENTICATED_ROUTES = new Set(['GET /v1/health']);

export interface StartApiServerOptions {
  db: CoreDatabase;
  token: string;
  operatorToken?: string;
  hostToken?: string;
  broadcaster: EventBroadcaster;
  coreInfo: CoreInfoProvider;
  onShutdown: () => void;
  /** Core data directory root — attachment bytes are stored under
   * `<dataDir>/attachments/...`, never inside the repository. */
  dataDir: string;
  port?: number;
  /** Optional injected executor (tests supply a fake model backend). Defaults to
   * a RuntimeExecutor wired to the real Ollama backend. */
  executor?: RuntimeExecutor;
  executorOptions?: RuntimeExecutorOptions;
  researchRunner?: GovernedResearchRunner;
  researchRunnerOptions?: Partial<GovernedResearchRunnerOptions>;
  /** Run durable scheduled tasks from this server (production Core only). */
  scheduler?: boolean;
  /** M38: the governed capability fabric external-service tool calls (GitHub,
   * etc.) dispatch through. Defaults to a workspace-only registry so existing
   * callers that never pass one keep identical behavior. */
  capabilityRegistry?: GovernedCapabilityRegistry;
  /** Jarvis Connector Foundation: the Gmail/Google Calendar/WhatsApp/Printer
   * adapters registered into `capabilityRegistry`, kept separately addressable
   * so `/v1/connectors` and the tier permission gate
   * (core/domain/connectorDispatch.ts) can look one up by `ConnectorId`
   * without re-deriving it from the generic registry. Defaults to all four
   * connectors, unconfigured, matching `capabilityRegistry`'s own default. */
  connectorRegistry?: Map<ConnectorId, ConnectorAdapter>;
  /** The Intelligence Scout, so the scheduler can fire a durable watch. */
  scout?: IntelligenceScout;
  /** Optional environment source for attachment processing. Supplying this is
   * useful for isolated Core tests; production defaults to `process.env`. */
  localProcessingEnv?: NodeJS.ProcessEnv;
  /** Test-only override for Gmail thread summarization's model backend
   * (`POST /v1/gmail/summarize-thread`). Production always uses a fresh,
   * local-only `OllamaModelBackend`, independent of `executor`'s own backend. */
  gmailSummaryBackend?: ModelBackend;
}

export interface RunningApiServer {
  server: http.Server;
  port: number;
  close(): Promise<void>;
}

function readBody(req: http.IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new CoreError('invalid_request', `request body exceeds ${MAX_BODY_BYTES} bytes`));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (chunks.length === 0) {
        resolve(undefined);
        return;
      }
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(new CoreError('invalid_request', 'request body is not valid JSON'));
      }
    });
    req.on('error', reject);
  });
}


export function deriveRequestPrincipal(
  req: http.IncomingMessage,
  optionsToken: string,
  operatorToken: string,
  hostToken: string,
  clientId: string,
): AuthenticatedPrincipal {
  const authHeader = req.headers.authorization;
  const bearerToken = extractBearerToken(authHeader);
  const operatorHeaderToken = req.headers['x-operator-token'] as string | undefined;
  const hostHeaderToken = req.headers['x-host-token'] as string | undefined;
  const callerTypeHeader = (req.headers['x-caller-type'] ?? req.headers['x-principal-type']) as string | undefined;

  // 1. Check for verified Operator authority
  if (
    (operatorHeaderToken && verifyToken(operatorHeaderToken, operatorToken)) ||
    (bearerToken && verifyToken(bearerToken, operatorToken))
  ) {
    return {
      role: 'host_operator',
      id: 'operator:host',
      isTrustedOperator: true,
      isTrustedHost: true,
      isModelOrTool: false,
      source: 'host_transport',
    };
  }

  // 2. Check for verified Trusted Host authority (Desktop / JARVIS)
  if (
    (hostHeaderToken && verifyToken(hostHeaderToken, hostToken)) ||
    (bearerToken && verifyToken(bearerToken, hostToken))
  ) {
    return {
      role: 'desktop_host',
      id: 'host:jarvis',
      isTrustedOperator: false,
      isTrustedHost: true,
      isModelOrTool: false,
      source: 'host_transport',
    };
  }

  // 3. Check for Model / Tool / Autonomous Runtime callers
  const isModelOrTool = callerTypeHeader === 'model' ||
    callerTypeHeader === 'tool' ||
    callerTypeHeader === 'runtime' ||
    callerTypeHeader === 'autonomous' ||
    clientId.startsWith('model') ||
    clientId.startsWith('tool');

  if (isModelOrTool) {
    const role: PrincipalRole = callerTypeHeader === 'tool' ? 'tool_call' : 'model_runtime';
    return {
      role,
      id: `agent:${clientId}`,
      isTrustedOperator: false,
      isTrustedHost: false,
      isModelOrTool: true,
      source: 'untrusted_client',
    };
  }

  // 4. Standard authenticated agent/client
  if (bearerToken && verifyToken(bearerToken, optionsToken)) {
    return {
      role: 'agent_client',
      id: `client:${clientId}`,
      isTrustedOperator: false,
      isTrustedHost: false,
      isModelOrTool: false,
      source: 'untrusted_client',
    };
  }

  // 5. Unknown / unauthenticated
  return {
    role: 'unknown',
    id: 'unknown',
    isTrustedOperator: false,
    isTrustedHost: false,
    isModelOrTool: false,
    source: 'untrusted_client',
  };
}

export function startApiServer(options: StartApiServerOptions): Promise<RunningApiServer> {
  const executor =
    options.executor ?? new RuntimeExecutor(options.db, options.broadcaster, options.executorOptions);
  const researchRunner = options.researchRunner ?? new GovernedResearchRunner(options.db, {
    backend: options.executorOptions?.backend ?? executor.researchModelBackend(),
    defaultModel: executor.researchDefaultModel(),
    ...options.researchRunnerOptions,
  });
  // Jarvis Connector Foundation: always built (all four, unconfigured by
  // default) so a server started without an explicit registry still exposes
  // truthful `not_configured` connector state rather than omitting them.
  const connectorRegistry = options.connectorRegistry ?? buildConnectorAdapters();
  // M39: the memory capability is part of the default registry so an API
  // server started without an explicit registry (tests, embedded hosts) still
  // reaches the same single governed memory path production uses.
  const capabilityRegistry = options.capabilityRegistry
    ?? (() => {
      const registry = new GovernedCapabilityRegistry()
        .register(createWorkspaceCapabilityAdapter())
        .register(createMemoryCapabilityAdapter({ db: options.db }))
        .register(createBrowserCapabilityAdapter({ browserBin: resolveHostBrowserBin() }));
      for (const adapter of connectorRegistry.values()) registry.register(adapter);
      return registry;
    })();
  const coreInfo: CoreInfoProvider = () => {
    const info = options.coreInfo();
    return {
      ...info,
      bundleHash: info.bundleHash ?? hashCoreBundle(process.argv[1]),
      busy: info.busy ?? (executor.activeCount() > 0 || hasInFlightCapabilityExecutions()),
    };
  };
  const operatorToken = options.operatorToken ?? process.env.KARKEDIKHA_OPERATOR_TOKEN ?? crypto.randomBytes(32).toString('hex');
  const hostToken = options.hostToken ?? process.env.KARKEDIKHA_HOST_TOKEN ?? crypto.randomBytes(32).toString('hex');
  if (options.scheduler) {
    startScheduledTaskLoop(options.db, options.broadcaster, executor, 30_000, {
      connectorRegistry,
      cwd: options.dataDir,
      ...(options.scout ? { scout: options.scout } : {}),
    });
    startDevStoryLoop(options.db, options.broadcaster);
    // The promise keeper: open commitments whose due moment has arrived are
    // checked against live mail. It runs in Core, so it keeps working while
    // the desktop window is closed, and it only ever reads.
    startFollowUpCheckLoop(options.db, options.broadcaster, 60_000, {
      connectorRegistry,
      cwd: options.dataDir,
    });
    startBackgroundTaskLoop(options.db, options.broadcaster, 5_000, {
      connectorRegistry,
      cwd: options.dataDir,
    });
  }
  // A cancellation whose owner stopped heart-beating must still reach a terminal
  // state, even when no client is watching at the time.
  startCancellationRecoveryLoop(options.db, options.broadcaster, executor);
  const router = buildRouter(options.broadcaster, coreInfo, options.onShutdown, executor, researchRunner, capabilityRegistry, connectorRegistry, options.gmailSummaryBackend);

  const server = http.createServer(async (req, res) => {
    const correlationId = newId('corr');
    res.setHeader('X-Correlation-Id', correlationId);
    try {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      const routeKey = `${req.method} ${url.pathname}`;

      if (!UNAUTHENTICATED_ROUTES.has(routeKey)) {
        const token = extractBearerToken(req.headers.authorization);
        if (!verifyToken(token, options.token)) {
          const { status, body } = toHttpError(new CoreError('unauthenticated', 'missing or invalid bearer token'), correlationId);
          res.writeHead(status, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(body));
          return;
        }
      }

      const clientId = (req.headers['x-client-id'] as string | undefined) ?? 'unknown-client';

      // M36: bounded authenticated binary upload. Bypasses the JSON router and
      // the 1 MiB JSON body cap entirely — the raw request stream is piped
      // straight to a bounded, hashed, atomically-renamed temp file. Handled
      // here (after auth, before the generic JSON `readBody`) rather than as a
      // normal router route because it needs direct access to the raw
      // http.IncomingMessage stream and to `dataDir`.
      const uploadMatch = matchAttachmentUploadRoute(req.method ?? '', url.pathname);
      if (uploadMatch) {
        await handleAttachmentUpload(req, res, uploadMatch.attachmentId, {
          db: options.db,
          dataDir: options.dataDir,
          clientId,
          actor: `client:${clientId}`,
          correlationId,
          localProcessingEnv: options.localProcessingEnv,
        });
        return;
      }

      const matched = router.match(req.method ?? 'GET', url.pathname);
      if (!matched) {
        const { status, body } = toHttpError(new CoreError('not_found', `no route for ${routeKey}`), correlationId);
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(body));
        return;
      }

      const body = req.method === 'GET' ? undefined : await readBody(req);
      const idempotencyKey = req.headers['idempotency-key'] as string | undefined;

      const principal = deriveRequestPrincipal(req, options.token, operatorToken, hostToken, clientId);

      const result = await matched.handler(
        {
          db: options.db,
          clientId,
          actor: principal.id,
          principal,
          correlationId,
          query: url.searchParams,
          params: matched.match.params,
          body,
          idempotencyKey,
        },
        matched.match,
      );
      res.writeHead(result.status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result.body));
    } catch (err) {
      const { status, body } = toHttpError(err, correlationId);
      if (!res.headersSent) {
        res.writeHead(status, { 'Content-Type': 'application/json' });
      }
      res.end(JSON.stringify(body));
    }
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port ?? 0, '127.0.0.1', () => {
      server.removeListener('error', reject);
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      resolve({
        server,
        port,
        close() {
          return new Promise((res, rej) => {
            server.close((err) => (err ? rej(err) : res()));
          });
        },
      });
    });
  });
}
