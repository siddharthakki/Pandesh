import { Router } from './router';
import type { ApiContext, ApiResult } from './context';
import { CoreError } from '../domain/errors';
import { sharedCloudCredentials } from '../runtime/cloudCredentials';
import { listCloudModels, testCloudConnection, SELF_HOSTED_PUBLIC_REFUSAL } from '../runtime/cloudProviderProbe';
import { ProviderCatalog, isPrivateEndpoint } from '../platform/providerCatalog';
import { withIdempotency, lookupIdempotencyResult } from '../domain/idempotency';
import { latestSequence, listEventsAfter } from '../domain/events';
import * as projects from '../domain/projects';
import * as repositories from '../domain/repositories';
import * as stories from '../domain/stories';
import * as devStories from '../runtime/kandev/devStories';
import { KandevClient } from '../runtime/kandev/kandevClient';

const kandevClient = new KandevClient();
import * as dependencies from '../domain/dependencies';
import { registerClientDevice } from '../domain/clientDevices';
import { importLegacyBoard, type LegacyImportRequest } from '../migration/importLegacyBoard';
import type { EventBroadcaster } from '../ws/broadcaster';
import type {
  BoardSnapshot,
  CoreInfo,
  StoryStatus,
  StoryType,
  DependencyType,
  RepositoryKind,
  ConversationMode,
  MessageRole,
  RequestedMode,
  ResolvedMode,
  AttemptStatus,
  AttemptKind,
  ApprovalKind,
  ModelSelectionEvidence,
  RepositoryContextPackage,
  AttemptRetryStrategy,
  ExecutionQualityEventType,
} from '../shared/wireTypes';
import type { RepositoryLocationCapability } from '../shared/wireTypes';
import * as conversations from '../domain/conversations';
import * as conversationLedger from '../domain/conversationLedger';
import * as conversationWorkingState from '../domain/conversationWorkingState';
import * as attachments from '../domain/attachments';
import * as artifacts from '../domain/artifacts';
import * as requests from '../domain/requests';
import * as attempts from '../domain/attempts';
import { listTaskOverview } from '../domain/taskOverview';
import * as modelInvocations from '../domain/modelInvocations';
import * as toolInvocations from '../domain/toolInvocations';
import * as approvals from '../domain/approvals';
import * as checkpoints from '../domain/checkpoints';
import * as everydayTools from '../domain/everydayTools';
import * as commandQueue from '../domain/commandQueue';
import * as karkeDikha from '../domain/karkeDikhaLifecycle';
import { latestRuntimeSequence, listRuntimeEventsAfter, recordRuntimeEvent } from '../domain/runtimeEvents';
import { isTerminalAttemptStatus } from '../domain/attemptTransitions';
import { steerPiAttempt } from '../runtime/piAgentEngine';
import { getTaskOutcome, objectiveFromRequest, updateTaskOutcome } from '../domain/taskOutcomes';
import { classifyRequest } from '../domain/routing';
import { buildContextPolicy } from '../domain/contextPolicy';
import { classifyAttemptRecovery } from '../domain/recovery';
import { submitRequest } from '../domain/submission';
import { getAttemptContext } from '../domain/attemptContext';
import { listWorkspaceAttemptRehydration } from '../domain/attemptRehydration';
import { listRecentWorkspaceCapabilityActions } from '../domain/capabilityActionHistory';
import { listTaskHistory, getTaskHistoryDetail } from '../domain/history';
import type { RuntimeExecutor } from '../runtime/executor';
import { GovernedCapabilityRegistry, createWorkspaceCapabilityAdapter } from '../runtime/governedCapability';
import { resolveCapabilityApproval, cancelCapabilityAction, listCapabilityActions } from '../domain/capabilityDispatch';
import { dispatchConnectorAction } from '../domain/connectorDispatch';
import { LocalAutonomySecurityKernel } from '../security/kernel';
import { getConnectorStatus, listConnectorStatuses, setConnectorPermission } from '../domain/connectors';
import { buildAssistantBrief, renderAssistantBriefMarkdown } from '../runtime/assistantBrief';
import {
  configureDailyBriefRoutine,
  disableDailyBriefRoutine,
  getDailyBriefRoutine,
} from '../domain/assistantRoutine';
import { buildConnectorAdapters } from '../runtime/connectors/connectorDefinitions';
import { setGmailAccessToken, clearGmailAccessToken } from '../runtime/connectors/gmailAccessTokenStore';
import { summarizeGmailThreadLocally, type GmailSummaryMessageInput } from '../runtime/gmailSummary';
import { OllamaModelBackend, type ModelBackend } from '../runtime/modelBackend';
import type { ConnectorAdapter } from '../runtime/connectors/connectorCapability';
import type { ConnectorId } from '../shared/wireTypes';
import { findAttemptIdByPendingApproval } from '../domain/attemptLoopContinuation';
import { attemptRetryEligibility } from '../domain/retryPolicy';
import * as research from '../domain/research';
import * as workbench from '../domain/workbench';
import * as engineeringOrganization from '../domain/engineeringOrganization';
import { researchProviderName, type GovernedResearchRunner } from '../runtime/researchRunner';
import { fetchOllamaCatalog, withContextWindows } from '../runtime/ollamaCatalog';
import { autoRoutingCandidateModels } from '../domain/modelRouting';

const MAX_LIST_LIMIT = 200;

function requireIdempotencyKey(ctx: ApiContext): string {
  if (!ctx.idempotencyKey) {
    throw new CoreError('invalid_request', 'Idempotency-Key header is required for mutating requests');
  }
  return ctx.idempotencyKey;
}

function asRecord(body: unknown): Record<string, unknown> {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw new CoreError('invalid_request', 'request body must be a JSON object');
  }
  return body as Record<string, unknown>;
}

function requireString(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new CoreError('invalid_request', `'${key}' is required and must be a non-empty string`);
  }
  return value;
}

function requireNumber(record: Record<string, unknown>, key: string): number {
  const value = record[key];
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new CoreError('invalid_request', `'${key}' is required and must be numeric`);
  }
  return value;
}

function optionalNumber(query: URLSearchParams, key: string): number | undefined {
  const raw = query.get(key);
  if (raw === null) return undefined;
  const n = Number(raw);
  if (!Number.isFinite(n)) throw new CoreError('invalid_request', `'${key}' must be numeric`);
  return n;
}

/** Broadcasts any story_events created by `fn` for `storyId` after it runs, via before/after sequence diffing. */
function withBroadcast<T>(ctx: ApiContext, broadcaster: EventBroadcaster, storyId: string, fn: () => T): T {
  const before = latestSequence(ctx.db);
  const result = fn();
  const newEvents = listEventsAfter(ctx.db, before, 100).filter((e) => e.storyId === storyId);
  for (const event of newEvents) broadcaster.publish(event);
  return result;
}

/** Same as withBroadcast but for the M32 runtime_events channel — broadcasts any
 * runtime_events created by `fn` regardless of entity, since a single API call can
 * touch multiple entities (e.g. creating an attempt also records a request-linked event). */
function withRuntimeBroadcast<T>(ctx: ApiContext, broadcaster: EventBroadcaster, fn: () => T): T {
  const before = latestRuntimeSequence(ctx.db);
  const result = fn();
  const newEvents = listRuntimeEventsAfter(ctx.db, before, 200);
  for (const event of newEvents) broadcaster.publishRuntime(event);
  return result;
}

export interface CoreInfoProvider {
  (): CoreInfo;
}

export function buildRouter(
  broadcaster: EventBroadcaster,
  coreInfo: CoreInfoProvider,
  onShutdown: () => void,
  executor?: RuntimeExecutor,
  researchRunner?: GovernedResearchRunner,
  capabilityRegistry?: GovernedCapabilityRegistry,
  connectorRegistry?: Map<ConnectorId, ConnectorAdapter>,
  // Deliberately independent of `executor`'s own backend (which may be
  // OpenRouter-selected) — Gmail summarization must be structurally
  // incapable of reaching a cloud model. Tests inject a fake; production
  // always gets a fresh local-only OllamaModelBackend.
  gmailSummaryBackend?: ModelBackend,
): Router<ApiContext, ApiResult> {
  const router = new Router<ApiContext, ApiResult>();
  const capabilities = capabilityRegistry ?? new GovernedCapabilityRegistry().register(createWorkspaceCapabilityAdapter());
  const connectors = connectorRegistry ?? buildConnectorAdapters();
  const summaryBackend = gmailSummaryBackend ?? new OllamaModelBackend();

  router.get('/v1/health', () => ({ status: 200, body: { status: 'ok' } }));

  router.get('/v1/core/info', () => ({ status: 200, body: coreInfo() }));

  // --- Cloud provider credentials (OrcaRouter) ---
  // The host owns the secret in SecretStorage and delivers it here so it takes effect without restarting Core.
  // Held in memory only: these routes intentionally bypass withIdempotency (which would persist the request
  // body) and never echo the key back.
  router.get('/v1/providers', () => ({
    status: 200,
    body: { providers: sharedCloudCredentials.providers().map(provider => ({ provider, ...sharedCloudCredentials.status(provider) })) },
  }));
  router.get('/v1/providers/:provider', (_ctx, match) => ({
    status: 200,
    body: sharedCloudCredentials.status(match.params.provider),
  }));
  router.post('/v1/providers/:provider/credential', (ctx, match) => {
    const body = asRecord(ctx.body);
    // A self-hosted provider is only free on a private address; a public one is refused before anything is stored.
    const providerRules = new ProviderCatalog().get(match.params.provider)?.modelRules?.freeness;
    if (providerRules?.kind === 'self-hosted' && !isPrivateEndpoint(requireString(body, 'baseUrl'))) {
      throw new CoreError('invalid_request', SELF_HOSTED_PUBLIC_REFUSAL);
    }
    try {
      sharedCloudCredentials.set(match.params.provider, {
        baseUrl: requireString(body, 'baseUrl'),
        apiKey: requireString(body, 'apiKey'),
      });
    } catch (error) {
      if (error instanceof CoreError) throw error;
      throw new CoreError('invalid_request', error instanceof Error ? error.message : 'invalid credential');
    }
    return { status: 200, body: sharedCloudCredentials.status(match.params.provider) };
  });
  router.delete('/v1/providers/:provider/credential', (_ctx, match) => {
    sharedCloudCredentials.clear(match.params.provider);
    return { status: 200, body: sharedCloudCredentials.status(match.params.provider) };
  });
  // Free cloud pool: the catalog, real model discovery and one fixed public connection test. A key is only ever
  // read from the in-memory credential store; a test runs only against a model already verified free.
  const cloudCatalog = new ProviderCatalog();
  router.get('/v1/cloud/catalog', () => ({
    status: 200,
    body: {
      catalogVersion: cloudCatalog.version,
      providers: cloudCatalog.list().map(provider => ({
        id: provider.id,
        displayName: provider.displayName,
        freeTier: provider.freeTier,
        paymentMethodRequired: provider.paymentMethodRequired,
        signupUrl: provider.signupUrl,
        apiKeysUrl: provider.apiKeysUrl,
        docsUrl: provider.docsUrl,
        requiresBaseUrlInput: provider.requiresBaseUrlInput === true,
        baseUrl: provider.baseUrl,
        privacyWarning: provider.privacyWarning ?? null,
        lastVerifiedAt: provider.lastVerifiedAt,
        configured: sharedCloudCredentials.status(provider.id).configured,
      })),
    },
  }));
  router.post('/v1/cloud/providers/:provider/models', async (_ctx, match) => {
    const provider = cloudCatalog.get(match.params.provider);
    if (!provider) throw new CoreError('not_found', `Unknown cloud provider ${match.params.provider}`);
    const credential = sharedCloudCredentials.get(provider.id);
    if (!credential) return { status: 409, body: { error: 'not_configured', message: 'Add an API key for this provider first.' } };
    return { status: 200, body: await listCloudModels(provider, credential) };
  });
  router.post('/v1/cloud/providers/:provider/test', async (ctx, match) => {
    const provider = cloudCatalog.get(match.params.provider);
    if (!provider) throw new CoreError('not_found', `Unknown cloud provider ${match.params.provider}`);
    const credential = sharedCloudCredentials.get(provider.id);
    if (!credential) return { status: 409, body: { error: 'not_configured', message: 'Add an API key for this provider first.' } };
    const model = requireString(asRecord(ctx.body), 'model');
    const listing = await listCloudModels(provider, credential);
    if (!listing.ok) return { status: 200, body: { ok: false, listing, test: null } };
    if (!listing.pool.some(entry => entry.id === model)) {
      return { status: 422, body: { error: 'model_not_free', message: 'That model is not in the verified free pool, so it was not called.' } };
    }
    return { status: 200, body: { ok: true, listing, test: await testCloudConnection(credential, model) } };
  });
  router.delete('/v1/providers', () => {
    sharedCloudCredentials.clearAll();
    return { status: 200, body: { providers: [] } };
  });

  router.post('/v1/core/shutdown', (ctx) => {
    const key = requireIdempotencyKey(ctx);
    return withIdempotency(ctx.db, { key, clientId: ctx.clientId, routeId: 'core.shutdown' }, ctx.body, () => {
      setImmediate(() => onShutdown());
      return { status: 202, body: { status: 'shutting_down' } };
    });
  });

  // --- Projects ---
  router.get('/v1/projects', (ctx) => {
    const status = ctx.query.get('status') as 'active' | 'archived' | null;
    const limit = optionalNumber(ctx.query, 'limit');
    const offset = optionalNumber(ctx.query, 'offset');
    const list = projects.listProjects(ctx.db, {
      status: status ?? undefined,
      limit: limit !== undefined ? Math.min(limit, MAX_LIST_LIMIT) : undefined,
      offset,
    });
    return { status: 200, body: { projects: list } };
  });

  router.post('/v1/projects', (ctx) => {
    const key = requireIdempotencyKey(ctx);
    const body = asRecord(ctx.body);
    return withIdempotency(ctx.db, { key, clientId: ctx.clientId, routeId: 'projects.create' }, ctx.body, () => {
      const created = projects.createProject(ctx.db, {
        name: requireString(body, 'name'),
        aliases: Array.isArray(body.aliases) ? (body.aliases as string[]) : undefined,
        description: (body.description as string) ?? null,
        productContext: (body.productContext as Record<string, unknown>) ?? null,
        policyMetadata: (body.policyMetadata as Record<string, unknown>) ?? null,
      });
      return { status: 201, body: created };
    });
  });

  router.get('/v1/projects/:id', (ctx, match) => ({ status: 200, body: projects.getProject(ctx.db, match.params.id) }));

  router.patch('/v1/projects/:id', (ctx, match) => {
    const key = requireIdempotencyKey(ctx);
    const body = asRecord(ctx.body);
    return withIdempotency(ctx.db, { key, clientId: ctx.clientId, routeId: `projects.update:${match.params.id}` }, ctx.body, () => {
      const updated = projects.updateProject(ctx.db, match.params.id, {
        name: body.name as string | undefined,
        description: body.description as string | null | undefined,
        defaultRepositoryId: body.defaultRepositoryId as string | null | undefined,
        productContext: body.productContext as Record<string, unknown> | null | undefined,
        policyMetadata: body.policyMetadata as Record<string, unknown> | null | undefined,
        expectedRevision: body.expectedRevision as number | undefined,
      });
      return { status: 200, body: updated };
    });
  });

  router.post('/v1/projects/:id/archive', (ctx, match) => {
    const key = requireIdempotencyKey(ctx);
    return withIdempotency(ctx.db, { key, clientId: ctx.clientId, routeId: `projects.archive:${match.params.id}` }, ctx.body, () => ({
      status: 200,
      body: projects.archiveProject(ctx.db, match.params.id),
    }));
  });

  // --- Repositories ---
  router.get('/v1/repositories', (ctx) => {
    const projectId = ctx.query.get('projectId') ?? undefined;
    return { status: 200, body: { repositories: repositories.listRepositories(ctx.db, { projectId }) } };
  });

  router.post('/v1/repositories', (ctx) => {
    const key = requireIdempotencyKey(ctx);
    const body = asRecord(ctx.body);
    return withIdempotency(ctx.db, { key, clientId: ctx.clientId, routeId: 'repositories.create' }, ctx.body, () => ({
      status: 201,
      body: repositories.createRepository(ctx.db, {
        projectId: requireString(body, 'projectId'),
        name: requireString(body, 'name'),
        remoteUrl: (body.remoteUrl as string) ?? null,
        defaultBranch: (body.defaultBranch as string) ?? null,
        kind: requireString(body, 'kind') as RepositoryKind,
      }),
    }));
  });

  router.get('/v1/repositories/:id', (ctx, match) => ({ status: 200, body: repositories.getRepository(ctx.db, match.params.id) }));

  router.patch('/v1/repositories/:id', (ctx, match) => {
    const key = requireIdempotencyKey(ctx);
    const body = asRecord(ctx.body);
    return withIdempotency(ctx.db, { key, clientId: ctx.clientId, routeId: `repositories.update:${match.params.id}` }, ctx.body, () => ({
      status: 200,
      body: repositories.updateRepository(ctx.db, match.params.id, {
        name: body.name as string | undefined,
        remoteUrl: body.remoteUrl as string | null | undefined,
        defaultBranch: body.defaultBranch as string | null | undefined,
        expectedRevision: body.expectedRevision as number | undefined,
      }),
    }));
  });

  router.post('/v1/repositories/:id/locations', (ctx, match) => {
    const key = requireIdempotencyKey(ctx);
    const body = asRecord(ctx.body);
    return withIdempotency(ctx.db, { key, clientId: ctx.clientId, routeId: `repositories.location:${match.params.id}` }, ctx.body, () => ({
      status: 201,
      body: repositories.registerRepositoryLocation(ctx.db, {
        repositoryId: match.params.id,
        nodeIdentity: requireString(body, 'nodeIdentity'),
        localPath: requireString(body, 'localPath'),
        availability: (body.availability as 'available' | 'unavailable') ?? 'available',
        gitCapable: Boolean(body.gitCapable),
        remoteCapable: Boolean(body.remoteCapable),
        repositoryRootIdentity: (body.repositoryRootIdentity as string) ?? null,
        currentBranch: (body.currentBranch as string) ?? null,
        isClean: body.isClean === undefined ? null : Boolean(body.isClean),
        capability: requireString(body, 'capability') as RepositoryLocationCapability,
      }),
    }));
  });

  router.post('/v1/repositories/:id/archive', (ctx, match) => {
    const key = requireIdempotencyKey(ctx);
    return withIdempotency(ctx.db, { key, clientId: ctx.clientId, routeId: `repositories.archive:${match.params.id}` }, ctx.body, () => ({
      status: 200,
      body: repositories.archiveRepository(ctx.db, match.params.id),
    }));
  });

  // --- Development stories executed by Kandev (core/runtime/kandev/devStories.ts) ---
  router.get('/v1/dev-stories', async (ctx) => ({
    status: 200,
    body: await devStories.devStoryStatus(ctx.db, kandevClient, ctx.query.get('projectId') ?? undefined),
  }));
  router.get('/v1/dev-stories/:id', async (ctx, match) => {
    // Bearer authentication already passed in the server. A model/tool/unidentified caller (a worker, for one) gets no task detail.
    const principal = ctx.principal;
    if (!principal || principal.isModelOrTool || principal.role === 'unknown') {
      return { status: 403, body: { error: 'forbidden', reason: 'Task details need an authenticated interactive client.' } };
    }
    return { status: 200, body: await devStories.devStoryDetail(ctx.db, kandevClient, match.params.id) };
  });
  router.post('/v1/dev-stories/plan', (ctx) => ({
    status: 201,
    body: devStories.planDevStories(ctx.db, asRecord(ctx.body) as unknown as devStories.PlanInput),
  }));
  router.post('/v1/dev-stories/dispatch', async (ctx) => {
    const body = asRecord(ctx.body);
    const storyIds = Array.isArray(body.storyIds) ? body.storyIds.map(String) : undefined;
    return { status: 200, body: { dispatched: await devStories.dispatchDevStories(ctx.db, kandevClient, { projectId: requireString(body, 'projectId'), storyIds }) } };
  });
  router.post('/v1/dev-stories/stop-all', async (ctx) => {
    const body = asRecord(ctx.body);
    return { status: 200, body: await devStories.stopAllDevStories(ctx.db, kandevClient, typeof body.reason === 'string' ? body.reason : undefined) };
  });
  router.post('/v1/dev-stories/:id/reassign', async (ctx, match) => {
    const body = asRecord(ctx.body);
    const story = await devStories.reassignDevStory(ctx.db, kandevClient, match.params.id, requireString(body, 'agent') as devStories.DevAgent, typeof body.model === 'string' ? body.model : undefined);
    return { status: 200, body: story };
  });
  router.post('/v1/dev-stories/:id/retry', async (ctx, match) => {
    const body = asRecord(ctx.body);
    await devStories.retryDevStory(ctx.db, kandevClient, match.params.id, typeof body.note === 'string' ? body.note : undefined);
    return { status: 200, body: { ok: true } };
  });
  router.post('/v1/dev-stories/:id/verify-existing', async (ctx, match) => {
    // Bearer authentication already passed in the server. This also stops a model/tool/unidentified caller (which
    // includes a worker) from triggering integration of its own output.
    const principal = ctx.principal;
    if (!principal || principal.isModelOrTool || principal.role === 'unknown') {
      return { status: 403, body: { error: 'forbidden', reason: 'Verify Existing Work needs an authenticated interactive client.' } };
    }
    const body = asRecord(ctx.body);
    return { status: 200, body: await devStories.verifyExistingDevStory(ctx.db, kandevClient, match.params.id, typeof body.note === 'string' ? body.note : undefined) };
  });
  router.post('/v1/dev-stories/:id/approve-review', async (ctx, match) => {
    const body = asRecord(ctx.body);
    await devStories.approveDevStoryReview(ctx.db, kandevClient, match.params.id, typeof body.note === 'string' ? body.note : undefined);
    return { status: 200, body: { ok: true } };
  });
  router.post('/v1/dev-stories/:id/device-verified', (ctx, match) => {
    const body = asRecord(ctx.body);
    devStories.confirmDeviceVerification(ctx.db, match.params.id, body.ok !== false, typeof body.note === 'string' ? body.note : undefined);
    return { status: 200, body: { ok: true } };
  });
  router.post('/v1/dev-stories/:id/permissions/:pendingId', async (ctx, match) => {
    const body = asRecord(ctx.body);
    // Only the Panda host decides for a person, proven by the verified host token. The X-Client-Id header is client-chosen and
    // proves nothing: anything holding the Core bearer token (a worker, a script) could send "desktop_x" and Allow its own request.
    const principal = ctx.principal;
    if (!principal?.isTrustedHost || principal.source !== 'host_transport' || principal.isModelOrTool) return { status: 403, body: { error: 'forbidden', reason: 'Worker approvals can only be decided from Panda.' } };
    const who = principal.id;
    await devStories.decideDevPermission(ctx.db, kandevClient, match.params.id, match.params.pendingId, body.allow === true, `${who} via ${body.via === 'phone' ? 'phone page' : 'Panda window'}`);
    return { status: 200, body: { ok: true } };
  });

  // --- Stories ---
  router.get('/v1/stories', (ctx) => {
    const projectId = ctx.query.get('projectId') ?? undefined;
    const status = (ctx.query.get('status') as StoryStatus | null) ?? undefined;
    const includeArchived = ctx.query.get('includeArchived') === 'true';
    const limit = optionalNumber(ctx.query, 'limit');
    const offset = optionalNumber(ctx.query, 'offset');
    const list = stories.listStories(ctx.db, {
      projectId,
      status,
      includeArchived,
      limit: limit !== undefined ? Math.min(limit, MAX_LIST_LIMIT) : undefined,
      offset,
    });
    return { status: 200, body: { stories: list } };
  });

  router.post('/v1/stories', (ctx) => {
    const key = requireIdempotencyKey(ctx);
    const body = asRecord(ctx.body);
    return withIdempotency(ctx.db, { key, clientId: ctx.clientId, routeId: 'stories.create' }, ctx.body, () => {
      const created = stories.createStory(ctx.db, {
        projectId: requireString(body, 'projectId'),
        repositoryId: (body.repositoryId as string) ?? null,
        title: requireString(body, 'title'),
        description: (body.description as string) ?? '',
        acceptanceCriteria: Array.isArray(body.acceptanceCriteria) ? (body.acceptanceCriteria as string[]) : undefined,
        priority: (body.priority as string) ?? null,
        status: body.status as StoryStatus | undefined,
        storyType: requireString(body, 'storyType') as StoryType,
        parentId: (body.parentId as string) ?? null,
        assignee: (body.assignee as Record<string, unknown>) ?? null,
        source: (body.source as Record<string, unknown>) ?? null,
        actor: ctx.actor,
        clientId: ctx.clientId,
        idempotencyKey: key,
      });
      broadcaster.publish({
        sequence: 0,
        id: '',
        storyId: created.id,
        eventType: 'story_created',
        actor: ctx.actor,
        clientId: ctx.clientId,
        idempotencyKey: key,
        createdAt: created.createdAt,
        metadata: {},
        resultingRevision: created.revision,
      });
      return { status: 201, body: created };
    });
  });

  router.get('/v1/stories/:id', (ctx, match) => ({ status: 200, body: stories.getStory(ctx.db, match.params.id) }));

  router.patch('/v1/stories/:id', (ctx, match) => {
    const key = requireIdempotencyKey(ctx);
    const body = asRecord(ctx.body);
    return withIdempotency(ctx.db, { key, clientId: ctx.clientId, routeId: `stories.update:${match.params.id}` }, ctx.body, () =>
      withBroadcast(ctx, broadcaster, match.params.id, () => ({
        status: 200,
        body: stories.updateStory(ctx.db, match.params.id, {
          title: body.title as string | undefined,
          description: body.description as string | undefined,
          acceptanceCriteria: Array.isArray(body.acceptanceCriteria) ? (body.acceptanceCriteria as string[]) : undefined,
          priority: body.priority as string | null | undefined,
          assignee: body.assignee as Record<string, unknown> | null | undefined,
          expectedRevision: body.expectedRevision as number | undefined,
          actor: ctx.actor,
          clientId: ctx.clientId,
          idempotencyKey: key,
        }),
      })),
    );
  });

  router.post('/v1/stories/:id/transition', (ctx, match) => {
    const key = requireIdempotencyKey(ctx);
    const body = asRecord(ctx.body);
    return withIdempotency(ctx.db, { key, clientId: ctx.clientId, routeId: `stories.transition:${match.params.id}` }, ctx.body, () =>
      withBroadcast(ctx, broadcaster, match.params.id, () => ({
        status: 200,
        body: stories.transitionStory(ctx.db, match.params.id, {
          toStatus: requireString(body, 'toStatus') as StoryStatus,
          expectedRevision: body.expectedRevision as number | undefined,
          reason: body.reason as string | undefined,
          actor: ctx.actor,
          clientId: ctx.clientId,
          idempotencyKey: key,
        }),
      })),
    );
  });

  router.post('/v1/stories/:id/archive', (ctx, match) => {
    const key = requireIdempotencyKey(ctx);
    return withIdempotency(ctx.db, { key, clientId: ctx.clientId, routeId: `stories.archive:${match.params.id}` }, ctx.body, () =>
      withBroadcast(ctx, broadcaster, match.params.id, () => ({
        status: 200,
        body: stories.archiveStory(ctx.db, match.params.id, { actor: ctx.actor, clientId: ctx.clientId, idempotencyKey: key }),
      })),
    );
  });

  router.post('/v1/stories/:id/comments', (ctx, match) => {
    const key = requireIdempotencyKey(ctx);
    const body = asRecord(ctx.body);
    return withIdempotency(ctx.db, { key, clientId: ctx.clientId, routeId: `stories.comment:${match.params.id}` }, ctx.body, () =>
      withBroadcast(ctx, broadcaster, match.params.id, () => ({
        status: 201,
        body: stories.addComment(ctx.db, match.params.id, {
          author: ctx.actor,
          body: requireString(body, 'body'),
          clientId: ctx.clientId,
          idempotencyKey: key,
        }),
      })),
    );
  });

  router.post('/v1/stories/:id/dependencies', (ctx, match) => {
    const key = requireIdempotencyKey(ctx);
    const body = asRecord(ctx.body);
    return withIdempotency(ctx.db, { key, clientId: ctx.clientId, routeId: `stories.dependency:${match.params.id}` }, ctx.body, () =>
      withBroadcast(ctx, broadcaster, match.params.id, () => ({
        status: 201,
        body: dependencies.addDependency(ctx.db, {
          storyId: match.params.id,
          dependsOnStoryId: requireString(body, 'dependsOnStoryId'),
          dependencyType: requireString(body, 'dependencyType') as DependencyType,
          actor: ctx.actor,
          clientId: ctx.clientId,
          idempotencyKey: key,
        }),
      })),
    );
  });

  // --- Board & events ---
  router.get('/v1/board/snapshot', (ctx) => {
    const projectId = ctx.query.get('projectId') ?? undefined;
    // includeArchived: true — clients (e.g. LocalBoardPanel) do their own Active/History split
    // client-side via each story's archivedAt; excluding archived stories here made the History
    // view permanently empty regardless of what the client asked for.
    const snapshot: BoardSnapshot = {
      latestSequence: latestSequence(ctx.db),
      projects: projects.listProjects(ctx.db, { limit: MAX_LIST_LIMIT }),
      stories: stories.listStories(ctx.db, { projectId, includeArchived: true, limit: MAX_LIST_LIMIT }),
      serverTimeIso: new Date().toISOString(),
    };
    return { status: 200, body: snapshot };
  });

  router.get('/v1/events', (ctx) => {
    const after = optionalNumber(ctx.query, 'after') ?? 0;
    const limit = Math.min(optionalNumber(ctx.query, 'limit') ?? 200, MAX_LIST_LIMIT);
    return { status: 200, body: { events: listEventsAfter(ctx.db, after, limit) } };
  });

  // --- M37: Core-owned engineering-company lifecycle ---
  router.post('/v1/engineering/product-requests', (ctx) => {
    const key = requireIdempotencyKey(ctx); const body = asRecord(ctx.body);
    return withIdempotency(ctx.db, { key, clientId: ctx.clientId, routeId: 'engineering.product-request.create' }, ctx.body, () => ({
      status: 201,
      body: engineeringOrganization.createProductRequest(ctx.db, {
        projectId: requireString(body, 'projectId'), repositoryId: body.repositoryId as string | null | undefined,
        title: requireString(body, 'title'), goal: requireString(body, 'goal'),
        acceptanceCriteria: Array.isArray(body.acceptanceCriteria) ? body.acceptanceCriteria as string[] : [],
        definitionOfReady: Array.isArray(body.definitionOfReady) ? body.definitionOfReady as string[] : [],
        definitionOfDone: Array.isArray(body.definitionOfDone) ? body.definitionOfDone as string[] : [],
        dependencies: Array.isArray(body.dependencies) ? body.dependencies as string[] : [], estimatedPoints: requireNumber(body, 'estimatedPoints'), actor: ctx.actor, clientId: ctx.clientId,
      }),
    }));
  });
  router.post('/v1/engineering/product-requests/:id/approve', (ctx, match) => {
    const key = requireIdempotencyKey(ctx);
    return withIdempotency(ctx.db, { key, clientId: ctx.clientId, routeId: `engineering.product-request.approve:${match.params.id}` }, ctx.body, () => ({ status: 200, body: engineeringOrganization.approveProductRequest(ctx.db, match.params.id, ctx.actor, ctx.clientId) }));
  });
  router.post('/v1/engineering/sprints', (ctx) => {
    const key = requireIdempotencyKey(ctx); const body = asRecord(ctx.body);
    return withIdempotency(ctx.db, { key, clientId: ctx.clientId, routeId: 'engineering.sprint.plan' }, ctx.body, () => ({ status: 201, body: engineeringOrganization.planSprint(ctx.db, { projectId: requireString(body, 'projectId'), repositoryId: body.repositoryId as string | null | undefined, name: requireString(body, 'name'), goal: requireString(body, 'goal'), capacityPoints: requireNumber(body, 'capacityPoints'), wipLimit: requireNumber(body, 'wipLimit'), storyIds: Array.isArray(body.storyIds) ? body.storyIds as string[] : [] }) }));
  });
  router.post('/v1/engineering/sprints/:id/start', (ctx, match) => {
    const key = requireIdempotencyKey(ctx);
    return withIdempotency(ctx.db, { key, clientId: ctx.clientId, routeId: `engineering.sprint.start:${match.params.id}` }, ctx.body, () => ({ status: 200, body: engineeringOrganization.startSprint(ctx.db, match.params.id) }));
  });
  router.post('/v1/engineering/sprints/:id/dispatch', (ctx, match) => {
    const key = requireIdempotencyKey(ctx); const body = asRecord(ctx.body);
    return withIdempotency(ctx.db, { key, clientId: ctx.clientId, routeId: `engineering.sprint.dispatch:${match.params.id}` }, ctx.body, () => ({ status: 200, body: engineeringOrganization.dispatchNext(ctx.db, { sprintId: match.params.id, workerIds: Array.isArray(body.workerIds) ? body.workerIds as string[] : [], leaseMs: requireNumber(body, 'leaseMs'), workspaceRoot: requireString(body, 'workspaceRoot'), selectedProvider: requireString(body, 'selectedProvider'), selectedModel: requireString(body, 'selectedModel'), actor: ctx.actor, clientId: ctx.clientId }) }));
  });
  router.post('/v1/engineering/ci/failure', (ctx) => {
    const key = requireIdempotencyKey(ctx); const body = asRecord(ctx.body);
    return withIdempotency(ctx.db, { key, clientId: ctx.clientId, routeId: 'engineering.ci.failure' }, ctx.body, () => ({ status: 201, body: engineeringOrganization.ingestCiFailure(ctx.db, { storyId: requireString(body, 'storyId'), sourceAttemptId: requireString(body, 'sourceAttemptId'), pullRequestUrl: requireString(body, 'pullRequestUrl'), headSha: requireString(body, 'headSha'), runId: requireString(body, 'runId'), failedChecks: Array.isArray(body.failedChecks) ? body.failedChecks as string[] : [], errorSummary: requireString(body, 'errorSummary'), actor: ctx.actor, clientId: ctx.clientId }) }));
  });
  router.post('/v1/engineering/ci/:runId/repair', (ctx, match) => {
    const key = requireIdempotencyKey(ctx); const body = asRecord(ctx.body);
    return withIdempotency(ctx.db, { key, clientId: ctx.clientId, routeId: `engineering.ci.repair:${match.params.runId}` }, ctx.body, () => ({ status: 200, body: engineeringOrganization.recordRepairEvidence(ctx.db, { failureRunId: match.params.runId, repairAttemptId: requireString(body, 'repairAttemptId'), replacementRunId: requireString(body, 'replacementRunId'), replacementHeadSha: requireString(body, 'replacementHeadSha'), regressionTests: Array.isArray(body.regressionTests) ? body.regressionTests as string[] : [], reviewed: body.reviewed === true }) }));
  });
  router.post('/v1/engineering/ci/:runId/replacement', (ctx, match) => {
    const key = requireIdempotencyKey(ctx); const body = asRecord(ctx.body);
    return withIdempotency(ctx.db, { key, clientId: ctx.clientId, routeId: `engineering.ci.replacement:${match.params.runId}` }, ctx.body, () => ({ status: 200, body: engineeringOrganization.observeReplacementCi(ctx.db, match.params.runId, requireString(body, 'replacementRunId'), requireString(body, 'headSha'), requireString(body, 'conclusion') as never) }));
  });
  router.post('/v1/engineering/ci/:runId/human-merge', (ctx, match) => {
    const key = requireIdempotencyKey(ctx); const body = asRecord(ctx.body);
    return withIdempotency(ctx.db, { key, clientId: ctx.clientId, routeId: `engineering.ci.human-merge:${match.params.runId}` }, ctx.body, () => ({ status: 200, body: engineeringOrganization.recordHumanMerge(ctx.db, { failureRunId: match.params.runId, mergedBy: requireString(body, 'mergedBy'), mergedAt: requireString(body, 'mergedAt') }) }));
  });
  router.post('/v1/engineering/sprints/:id/close', (ctx, match) => {
    const key = requireIdempotencyKey(ctx);
    return withIdempotency(ctx.db, { key, clientId: ctx.clientId, routeId: `engineering.sprint.close:${match.params.id}` }, ctx.body, () => ({ status: 200, body: engineeringOrganization.closeSprint(ctx.db, match.params.id) }));
  });
  router.get('/v1/engineering/snapshot', (ctx) => ({ status: 200, body: engineeringOrganization.organizationSnapshot(ctx.db, requireString({ projectId: ctx.query.get('projectId') }, 'projectId')) }));

  // --- Client registration ---
  router.post('/v1/clients/register', (ctx) => {
    const body = asRecord(ctx.body);
    return {
      status: 200,
      body: registerClientDevice(ctx.db, {
        id: ctx.clientId,
        clientType: requireString(body, 'clientType') as 'vscode' | 'desktop' | 'ios' | 'headless',
        clientVersion: requireString(body, 'clientVersion'),
        deviceLabel: (body.deviceLabel as string) ?? null,
      }),
    };
  });

  // --- M35 correction: one workspace-scoped conversation ledger ---
  router.get('/v1/workspace-conversation-ledger', (ctx) => ({
    status: 200,
    body: conversationLedger.getWorkspaceConversationLedger(
      ctx.db,
      String(ctx.query.get('workspaceIdentity') ?? ''),
    ),
  }));

  router.post('/v1/workspace-conversation-ledger/bind', (ctx) => {
    const key = requireIdempotencyKey(ctx);
    const body = asRecord(ctx.body);
    return withIdempotency(ctx.db, { key, clientId: ctx.clientId, routeId: 'workspace-conversation-ledger.bind' }, ctx.body, () => ({
      status: 200,
      body: conversationLedger.bindWorkspaceConversation(ctx.db, {
        workspaceIdentity: requireString(body, 'workspaceIdentity'),
        localConversationId: requireString(body, 'localConversationId'),
        conversationId: requireString(body, 'conversationId'),
        title: (body.title as string) ?? null,
        makeCurrent: body.makeCurrent !== false,
        migrationMetadata: (body.migrationMetadata as Record<string, unknown>) ?? {},
      }),
    }));
  });

  router.post('/v1/workspace-conversation-ledger/select', (ctx) => {
    const key = requireIdempotencyKey(ctx);
    const body = asRecord(ctx.body);
    return withIdempotency(ctx.db, { key, clientId: ctx.clientId, routeId: 'workspace-conversation-ledger.select' }, ctx.body, () => ({
      status: 200,
      body: conversationLedger.selectWorkspaceConversation(
        ctx.db,
        requireString(body, 'workspaceIdentity'),
        requireString(body, 'localConversationId'),
      ),
    }));
  });

  router.post('/v1/workspace-conversation-ledger/archive', (ctx) => {
    const key = requireIdempotencyKey(ctx);
    const body = asRecord(ctx.body);
    return withIdempotency(ctx.db, { key, clientId: ctx.clientId, routeId: 'workspace-conversation-ledger.archive' }, ctx.body, () => ({
      status: 200,
      body: conversationLedger.archiveWorkspaceConversation(ctx.db, {
        workspaceIdentity: requireString(body, 'workspaceIdentity'),
        localConversationId: requireString(body, 'localConversationId'),
        actor: ctx.actor,
        clientId: ctx.clientId,
      }),
    }));
  });

  // --- M32: Conversations (now containers for all three visible modes) ---
  router.get('/v1/conversations', (ctx) => {
    const mode = (ctx.query.get('mode') as ConversationMode | null) ?? undefined;
    const includeArchived = ctx.query.get('includeArchived') === 'true';
    return { status: 200, body: { conversations: workbench.listConversationRail(ctx.db, { mode, includeArchived }) } };
  });

  router.post('/v1/conversations', (ctx) => {
    const key = requireIdempotencyKey(ctx);
    const body = asRecord(ctx.body);
    return withIdempotency(ctx.db, { key, clientId: ctx.clientId, routeId: 'conversations.create' }, ctx.body, () =>
      withRuntimeBroadcast(ctx, broadcaster, () => ({
        status: 201,
        body: conversations.createConversation(ctx.db, {
          mode: requireString(body, 'mode') as ConversationMode,
          projectId: (body.projectId as string) ?? null,
          repositoryId: (body.repositoryId as string) ?? null,
          title: (body.title as string) ?? null,
          actor: ctx.actor,
          clientId: ctx.clientId,
        }),
      })),
    );
  });

  // M36 workbench reads are intentionally registered before `:id` routes so
  // the fixed `search` segment can never be mistaken for a conversation id.
  router.get('/v1/conversations/search', (ctx) => ({
    status: 200,
    body: { results: workbench.searchConversations(ctx.db, String(ctx.query.get('query') ?? ''), optionalNumber(ctx.query, 'limit') ?? undefined) },
  }));

  router.get('/v1/conversations/:id', (ctx, match) => ({ status: 200, body: conversations.getConversation(ctx.db, match.params.id) }));

  router.post('/v1/conversations/:id/archive', (ctx, match) => {
    const key = requireIdempotencyKey(ctx);
    return withIdempotency(ctx.db, { key, clientId: ctx.clientId, routeId: `conversations.archive:${match.params.id}` }, ctx.body, () =>
      withRuntimeBroadcast(ctx, broadcaster, () => ({
        status: 200,
        body: conversations.archiveConversation(ctx.db, match.params.id, { actor: ctx.actor, clientId: ctx.clientId }),
      })),
    );
  });

  // Jarvis Conversations rail Checkpoint 1: archive must be recoverable.
  router.post('/v1/conversations/:id/unarchive', (ctx, match) => {
    const key = requireIdempotencyKey(ctx);
    return withIdempotency(ctx.db, { key, clientId: ctx.clientId, routeId: `conversations.unarchive:${match.params.id}` }, ctx.body, () =>
      withRuntimeBroadcast(ctx, broadcaster, () => ({
        status: 200,
        body: conversations.unarchiveConversation(ctx.db, match.params.id, { actor: ctx.actor, clientId: ctx.clientId }),
      })),
    );
  });

  router.post('/v1/conversations/:id/rename', (ctx, match) => {
    const key = requireIdempotencyKey(ctx);
    const body = asRecord(ctx.body);
    return withIdempotency(ctx.db, { key, clientId: ctx.clientId, routeId: `conversations.rename:${match.params.id}` }, ctx.body, () =>
      withRuntimeBroadcast(ctx, broadcaster, () => ({
        status: 200,
        body: conversations.renameConversation(ctx.db, match.params.id, { title: requireString(body, 'title'), actor: ctx.actor, clientId: ctx.clientId }),
      })),
    );
  });

  router.post('/v1/conversations/:id/pin', (ctx, match) => {
    const key = requireIdempotencyKey(ctx);
    return withIdempotency(ctx.db, { key, clientId: ctx.clientId, routeId: `conversations.pin:${match.params.id}` }, ctx.body, () =>
      withRuntimeBroadcast(ctx, broadcaster, () => ({
        status: 200,
        body: conversations.pinConversation(ctx.db, match.params.id, { actor: ctx.actor, clientId: ctx.clientId }),
      })),
    );
  });

  router.post('/v1/conversations/:id/unpin', (ctx, match) => {
    const key = requireIdempotencyKey(ctx);
    return withIdempotency(ctx.db, { key, clientId: ctx.clientId, routeId: `conversations.unpin:${match.params.id}` }, ctx.body, () =>
      withRuntimeBroadcast(ctx, broadcaster, () => ({
        status: 200,
        body: conversations.unpinConversation(ctx.db, match.params.id, { actor: ctx.actor, clientId: ctx.clientId }),
      })),
    );
  });

  router.get('/v1/conversations/:id/messages', (ctx, match) => {
    const limit = optionalNumber(ctx.query, 'limit');
    const afterSeq = optionalNumber(ctx.query, 'afterSeq');
    return {
      status: 200,
      body: { messages: conversations.listMessages(ctx.db, match.params.id, { limit, afterSeq }) },
    };
  });

  router.post('/v1/conversations/:id/messages', (ctx, match) => {
    const body = asRecord(ctx.body);
    const role = requireString(body, 'role') as MessageRole;
    const content = requireString(body, 'content');
    const modelInvocationId = typeof body.modelInvocationId === 'string' ? body.modelInvocationId : null;
    return withRuntimeBroadcast(ctx, broadcaster, () => ({
      status: 201,
      body: conversations.appendMessage(ctx.db, match.params.id, {
        role,
        content,
        modelInvocationId,
        actor: ctx.actor,
        clientId: ctx.clientId,
      }),
    }));
  });

  // --- M36: durable attachments (first vertical slice) ---
  router.get('/v1/conversations/:id/attachments', (ctx, match) => ({
    status: 200,
    body: { attachments: attachments.listAttachmentsForConversation(ctx.db, match.params.id) },
  }));

  router.post('/v1/conversations/:id/attachments', (ctx, match) => {
    const key = requireIdempotencyKey(ctx);
    const body = asRecord(ctx.body);
    return withIdempotency(ctx.db, { key, clientId: ctx.clientId, routeId: `attachments.create:${match.params.id}` }, ctx.body, () => ({
      status: 201,
      body: attachments.createPendingAttachment(ctx.db, {
        conversationId: match.params.id,
        originalName: requireString(body, 'originalName'),
        declaredMimeType: requireString(body, 'declaredMimeType'),
        kind: requireString(body, 'kind') as 'text' | 'image',
        byteSize: requireNumber(body, 'byteSize'),
        actor: ctx.actor,
        clientId: ctx.clientId,
      }),
    }));
  });

  router.get('/v1/attachments/:id', (ctx, match) => ({ status: 200, body: attachments.getAttachment(ctx.db, match.params.id) }));

  // Shared artifact subsystem. Registration is authenticated and host-only in
  // Desktop: no renderer IPC exposes arbitrary paths. Core verifies bytes and
  // persists their digest before returning a ready record.
  router.get('/v1/artifacts', (ctx) => ({
    status: 200,
    body: { artifacts: artifacts.listArtifacts(ctx.db, (ctx.query.get('conversationId') as string | null) ?? undefined) },
  }));
  router.get('/v1/artifacts/:id', (ctx, match) => ({ status: 200, body: artifacts.getArtifact(ctx.db, match.params.id) }));
  router.post('/v1/artifacts', (ctx) => {
    const key = requireIdempotencyKey(ctx); const body = asRecord(ctx.body);
    return withIdempotency(ctx.db, { key, clientId: ctx.clientId, routeId: 'artifacts.register' }, ctx.body, () => ({
      status: 201,
      body: artifacts.registerArtifact(ctx.db, {
        conversationId: (body.conversationId as string) ?? null,
        requestId: (body.requestId as string) ?? null,
        attemptId: (body.attemptId as string) ?? null,
        kind: requireString(body, 'kind') as import('../shared/wireTypes').ArtifactKind,
        title: requireString(body, 'title'), mimeType: requireString(body, 'mimeType'),
        absolutePath: requireString(body, 'absolutePath'), source: requireString(body, 'source'),
        metadata: (body.metadata as Record<string, unknown>) ?? {}, actor: ctx.actor, clientId: ctx.clientId,
      }),
    }));
  });

  // Restart restoration (M36): the exact attachments linked to each message in
  // this conversation, keyed by messageId — lets a client rebuild attachment
  // chips/provenance from Core records instead of retained webview state.
  router.get('/v1/conversations/:id/message-attachments', (ctx, match) => ({
    status: 200,
    body: { byMessage: attachments.listAttachmentsByMessageForConversation(ctx.db, match.params.id) },
  }));

  // M36 governed research: this is the only path that can create a research
  // request. It writes approval state only; no provider or source request is
  // possible until the matching durable envelope is explicitly approved.
  router.post('/v1/conversations/:id/research', (ctx, match) => {
    const key = requireIdempotencyKey(ctx); const body = asRecord(ctx.body);
    return withIdempotency(ctx.db, { key, clientId: ctx.clientId, routeId: `research.create:${match.params.id}` }, ctx.body, () =>
      withRuntimeBroadcast(ctx, broadcaster, () => ({ status: 201, body: research.createResearchSession(ctx.db, { conversationId: match.params.id, query: requireString(body, 'query'), provider: researchProviderName(), actor: ctx.actor, clientId: ctx.clientId }) })));
  });

  router.get('/v1/conversations/:id/branch', (ctx, match) => ({ status: 200, body: { branch: workbench.getConversationBranch(ctx.db, match.params.id) } }));
  router.post('/v1/conversations/:id/branch', (ctx, match) => {
    const key = requireIdempotencyKey(ctx); const body = asRecord(ctx.body);
    return withIdempotency(ctx.db, { key, clientId: ctx.clientId, routeId: `conversations.branch:${match.params.id}` }, ctx.body, () =>
      withRuntimeBroadcast(ctx, broadcaster, () => ({ status: 201, body: workbench.branchConversation(ctx.db, { parentConversationId: match.params.id, branchPointMessageId: requireString(body, 'branchPointMessageId'), title: (body.title as string) ?? null, actor: ctx.actor, clientId: ctx.clientId }) })),
    );
  });
  router.get('/v1/conversations/:id/alternatives', (ctx, match) => ({ status: 200, body: { alternatives: workbench.listResponseAlternatives(ctx.db, match.params.id, (ctx.query.get('userMessageId') as string | null) ?? undefined) } }));
  router.post('/v1/conversations/:id/alternatives/:alternativeId/select', (ctx, match) => {
    const key = requireIdempotencyKey(ctx);
    return withIdempotency(ctx.db, { key, clientId: ctx.clientId, routeId: `conversations.selectAlternative:${match.params.id}:${match.params.alternativeId}` }, ctx.body, () =>
      withRuntimeBroadcast(ctx, broadcaster, () => ({ status: 200, body: workbench.setActiveResponseAlternative(ctx.db, { conversationId: match.params.id, alternativeId: match.params.alternativeId, actor: ctx.actor, clientId: ctx.clientId }) })),
    );
  });
  router.get('/v1/conversations/:id/export', (ctx, match) => {
    const value = workbench.exportConversation(ctx.db, match.params.id);
    return ctx.query.get('format') === 'markdown'
      ? { status: 200, body: { format: 'markdown', content: workbench.renderConversationMarkdown(value) } }
      : { status: 200, body: { format: 'json', content: value } };
  });
  router.get('/v1/conversations/:id/research', (ctx, match) => ({ status: 200, body: { research: research.listResearchForConversation(ctx.db, match.params.id) } }));

  // --- Durable Conversational Continuity V1: bounded per-conversation working state ---
  // Read is workspace-scoped and fails closed (returns null) for another
  // workspace/profile, so a restored panel can never surface a different
  // project's objective.
  router.get('/v1/conversations/:id/working-state', (ctx, match) => ({
    status: 200,
    body: {
      workingState: conversationWorkingState.getConversationWorkingState(
        ctx.db,
        match.params.id,
        String(ctx.query.get('workspaceIdentity') ?? ''),
      ),
    },
  }));

  router.post('/v1/conversations/:id/working-state', (ctx, match) => {
    const key = requireIdempotencyKey(ctx);
    const body = asRecord(ctx.body);
    return withIdempotency(ctx.db, { key, clientId: ctx.clientId, routeId: 'conversations.working-state.save' }, ctx.body, () => ({
      status: 200,
      body: {
        workingState: conversationWorkingState.saveConversationWorkingState(ctx.db, match.params.id, {
          workspaceIdentity: requireString(body, 'workspaceIdentity'),
          startNewObjective: body.startNewObjective === true,
          currentObjective: requireString(body, 'currentObjective'),
          latestUserIntent: requireString(body, 'latestUserIntent'),
          latestExecutionPolicy: (body.latestExecutionPolicy as never) ?? null,
          relevantFiles: (body.relevantFiles as never) ?? [],
          relevantSymbols: (body.relevantSymbols as never) ?? [],
          userConstraints: (body.userConstraints as never) ?? [],
          latestFindingsSummary: (body.latestFindingsSummary as string) ?? null,
          pendingAction: (body.pendingAction as never) ?? null,
          latestTaskId: (body.latestTaskId as string) ?? null,
          latestProposalId: (body.latestProposalId as string) ?? null,
          latestValidationSummary: (body.latestValidationSummary as string) ?? null,
          pendingNewObjective: body.pendingNewObjective === true,
          awaitingObjectiveClarification: body.awaitingObjectiveClarification === true,
          actor: ctx.actor,
          clientId: ctx.clientId,
        }),
      },
    }));
  });

  router.delete('/v1/conversations/:id/working-state', (ctx, match) => {
    const workspaceIdentity = String(ctx.query.get('workspaceIdentity') ?? '');
    conversationWorkingState.clearConversationWorkingState(ctx.db, match.params.id, workspaceIdentity);
    return { status: 200, body: { cleared: true } };
  });

  router.get('/v1/research/:id', (ctx, match) => ({ status: 200, body: { session: research.getResearchSession(ctx.db, match.params.id), sources: research.listResearchSources(ctx.db, match.params.id) } }));
  router.post('/v1/research/:id/resolve', (ctx, match) => {
    const key = requireIdempotencyKey(ctx); const body = asRecord(ctx.body);
    return withIdempotency(ctx.db, { key, clientId: ctx.clientId, routeId: `research.resolve:${match.params.id}` }, ctx.body, () => withRuntimeBroadcast(ctx, broadcaster, () => {
      const session = research.resolveResearchApproval(ctx.db, match.params.id, { approvalId: requireString(body, 'approvalId'), requestedActionDigest: requireString(body, 'requestedActionDigest'), resolution: requireString(body, 'resolution') as 'approved' | 'rejected', actor: ctx.actor, clientId: ctx.clientId });
      if (session.state === 'running') researchRunner?.execute(session.id);
      return { status: 200, body: session };
    }));
  });
  router.get('/v1/messages/:id/citations', (ctx, match) => ({ status: 200, body: { citations: research.listCitationsForMessage(ctx.db, match.params.id) } }));

  router.post('/v1/attachments/:id/delete', (ctx, match) => {
    const key = requireIdempotencyKey(ctx);
    return withIdempotency(ctx.db, { key, clientId: ctx.clientId, routeId: `attachments.delete:${match.params.id}` }, ctx.body, () => ({
      status: 200,
      body: attachments.softDeleteAttachment(ctx.db, match.params.id, { actor: ctx.actor, clientId: ctx.clientId }),
    }));
  });

  router.post('/v1/conversations/:id/messages', (ctx, match) => {
    const key = requireIdempotencyKey(ctx);
    const body = asRecord(ctx.body);
    return withIdempotency(ctx.db, { key, clientId: ctx.clientId, routeId: `conversations.message:${match.params.id}` }, ctx.body, () =>
      withRuntimeBroadcast(ctx, broadcaster, () => ({
        status: 201,
        body: conversations.appendMessage(ctx.db, match.params.id, {
          role: requireString(body, 'role') as MessageRole,
          content: requireString(body, 'content'),
          modelInvocationId: (body.modelInvocationId as string) ?? null,
          actor: ctx.actor,
          clientId: ctx.clientId,
        }),
      })),
    );
  });

  // --- M32: Auto-mode routing (server-owned, deterministic, current-request-only) ---
  router.post('/v1/routing/classify', (ctx) => {
    const body = asRecord(ctx.body);
    const hasWorkspace = body.hasWorkspace === undefined ? true : Boolean(body.hasWorkspace);
    const gitCapable = body.gitCapable === undefined ? true : Boolean(body.gitCapable);
    const decision = classifyRequest(requireString(body, 'currentMessage'), { hasWorkspace, gitCapable });
    const contextPolicy = buildContextPolicy(decision.resolvedMode, {
      hasConversation: Boolean(body.conversationId),
      hasRepository: hasWorkspace,
      hasStory: Boolean(body.storyId),
    });
    return { status: 200, body: { ...decision, contextPolicy } };
  });

  // --- M32: Immutable request envelopes ---
  router.post('/v1/requests', (ctx) => {
    const key = requireIdempotencyKey(ctx);
    const body = asRecord(ctx.body);
    return withIdempotency(ctx.db, { key, clientId: ctx.clientId, routeId: 'requests.create' }, ctx.body, () =>
      withRuntimeBroadcast(ctx, broadcaster, () => ({
        status: 201,
        body: requests.createRequest(ctx.db, {
          clientId: ctx.clientId,
          currentMessage: requireString(body, 'currentMessage'),
          requestedMode: requireString(body, 'requestedMode') as RequestedMode,
          resolvedMode: requireString(body, 'resolvedMode') as ResolvedMode,
          routeReason: requireString(body, 'routeReason'),
          conversationId: (body.conversationId as string) ?? null,
          storyId: (body.storyId as string) ?? null,
          projectId: (body.projectId as string) ?? null,
          repositoryId: (body.repositoryId as string) ?? null,
          repositoryLocationId: (body.repositoryLocationId as string) ?? null,
          requestedProvider: (body.requestedProvider as string) ?? null,
          requestedModel: (body.requestedModel as string) ?? null,
          toolPermissionPolicy: (body.toolPermissionPolicy as Record<string, unknown>) ?? {},
          contextPolicy: (body.contextPolicy as requests.CreateRequestInput['contextPolicy']) ?? {
            includeConversationHistory: false,
            includeProjectContext: false,
            includeRepositoryContext: false,
            includeGlobalStoryContext: false,
          },
          correlationId: (body.correlationId as string) ?? key,
          idempotencyKey: key,
        }),
      })),
    );
  });

  router.get('/v1/requests/:id', (ctx, match) => ({ status: 200, body: requests.getRequest(ctx.db, match.params.id) }));

  // --- M32 correction (audit F1/F5): one atomic submission path. Replaces the
  // classify-then-create-request-then-create-attempt three-round-trip pattern
  // above with a single transaction that owns routing, request creation, and
  // first-attempt creation together — no producer can create a request with a
  // client-invented resolvedMode, and no request can exist without an attempt.
  router.post('/v1/submit', async (ctx) => {
    const key = requireIdempotencyKey(ctx);
    const body = asRecord(ctx.body);
    if (body.autoSelectModel === true && (
      body.modelSelection !== undefined
      || body.requestedProvider !== undefined
      || body.requestedModel !== undefined
    )) {
      throw new CoreError('invalid_request', 'autoSelectModel cannot be combined with explicit provider or model selection');
    }
    const wantsAutoRouting = body.autoSelectModel === true && !body.modelSelection;
    // A duplicate/retried submit with an already-terminal idempotency key
    // replays its cached response inside withIdempotency without touching
    // routing at all — skip the live catalog round-trip so a retry of a
    // completed submission is not made to wait on Ollama's reachability.
    const isDuplicateSubmit = wantsAutoRouting
      && lookupIdempotencyResult(ctx.db, { key, clientId: ctx.clientId, routeId: 'submit' }) !== undefined;
    const installedModelsCatalog = wantsAutoRouting && !isDuplicateSubmit
      ? await withContextWindows(await fetchOllamaCatalog(), autoRoutingCandidateModels())
      : undefined;
    return withIdempotency(ctx.db, { key, clientId: ctx.clientId, routeId: 'submit' }, ctx.body, () =>
      withRuntimeBroadcast(ctx, broadcaster, () => {
        const hasWorkspace = body.hasWorkspace === undefined ? true : Boolean(body.hasWorkspace);
        const gitCapable = body.gitCapable === undefined ? true : Boolean(body.gitCapable);
        const selection = body.modelSelection as ModelSelectionEvidence | undefined;
        const defaults = executor?.contextDefaults();
        const result = submitRequest(ctx.db, {
          clientId: ctx.clientId,
          currentMessage: requireString(body, 'currentMessage'),
          requestedMode: requireString(body, 'requestedMode') as RequestedMode,
          conversationId: (body.conversationId as string) ?? null,
          storyId: (body.storyId as string) ?? null,
          projectId: (body.projectId as string) ?? null,
          repositoryId: (body.repositoryId as string) ?? null,
          repositoryLocationId: (body.repositoryLocationId as string) ?? null,
          requestedProvider: (body.requestedProvider as string) ?? null,
          requestedModel: (body.requestedModel as string) ?? null,
          workspaceRoot: (body.workspaceRoot as string) ?? null,
          selectedProvider: wantsAutoRouting ? null : selection?.selectedProvider ?? (body.requestedProvider as string) ?? defaults?.selectedProvider,
          selectedModel: wantsAutoRouting ? null : selection?.selectedModel ?? (body.requestedModel as string) ?? defaults?.selectedModel,
          modelSelection: selection,
          installedModelsCatalog,
          contextWindowOverrideTokens: typeof body.contextWindowOverrideTokens === 'number' ? body.contextWindowOverrideTokens : undefined,
          repositoryContext: body.repositoryContext as RepositoryContextPackage | undefined,
          effectiveAllowedTools: Array.isArray((body.toolPermissionPolicy as { allowedTools?: unknown } | undefined)?.allowedTools)
            ? ((body.toolPermissionPolicy as { allowedTools: string[] }).allowedTools)
            : defaults?.allowedTools,
          toolPermissionPolicy: (body.toolPermissionPolicy as Record<string, unknown>) ?? {},
          capability: { hasWorkspace, gitCapable },
          correlationId: (body.correlationId as string) ?? key,
          idempotencyKey: key,
          attachmentIds: Array.isArray(body.attachmentIds) ? (body.attachmentIds as string[]) : undefined,
        });
        return { status: 201, body: result };
      }),
    );
  });

  // A regeneration is a new Core attempt over the original user turn.  It
  // deliberately does not append a second user message and does not create a
  // research session; it reuses the durable prior context/evidence only.
  router.post('/v1/conversations/:id/regenerate', (ctx, match) => {
    const key = requireIdempotencyKey(ctx); const body = asRecord(ctx.body);
    return withIdempotency(ctx.db, { key, clientId: ctx.clientId, routeId: `conversations.regenerate:${match.params.id}` }, ctx.body, () =>
      withRuntimeBroadcast(ctx, broadcaster, () => {
        const originalId = requireString(body, 'assistantMessageId');
        const history = conversations.listMessages(ctx.db, match.params.id, { limit: 2000 });
        const assistantIndex = history.findIndex(message => message.id === originalId && message.role === 'assistant');
        if (assistantIndex < 0) throw new CoreError('not_found', 'assistant response is not available in this conversation');
        const user = [...history.slice(0, assistantIndex)].reverse().find(message => message.role === 'user');
        if (!user) throw new CoreError('invalid_transition', 'assistant response has no preceding user turn to regenerate');
        const modelRow = ctx.db.get<{ selectedProvider: string; selectedModel: string; modelSelection: string | null; repositoryContext: string | null }>(
          `SELECT ac.selectedProvider, ac.selectedModel, ac.modelSelection, ac.repositoryContext FROM conversation_messages m
           JOIN model_invocations mi ON mi.id = m.modelInvocationId JOIN attempt_contexts ac ON ac.attemptId = mi.attemptId WHERE m.id = ?`, [originalId],
        );
        const defaults = executor?.contextDefaults();
        const selection = modelRow?.modelSelection ? JSON.parse(modelRow.modelSelection) as ModelSelectionEvidence : undefined;
        const result = submitRequest(ctx.db, {
          clientId: ctx.clientId, currentMessage: user.content, requestedMode: 'baat_kar', conversationId: match.params.id,
          requestedProvider: modelRow?.selectedProvider ?? defaults?.selectedProvider ?? null,
          requestedModel: modelRow?.selectedModel ?? defaults?.selectedModel ?? null,
          selectedProvider: modelRow?.selectedProvider ?? defaults?.selectedProvider ?? null,
          selectedModel: modelRow?.selectedModel ?? defaults?.selectedModel ?? null,
          modelSelection: selection,
          repositoryContext: modelRow?.repositoryContext ? JSON.parse(modelRow.repositoryContext) as RepositoryContextPackage : undefined,
          effectiveAllowedTools: [], toolPermissionPolicy: {}, capability: { hasWorkspace: Boolean(modelRow?.repositoryContext), gitCapable: false },
          correlationId: key, idempotencyKey: key, reuseUserMessageId: user.id, regenerateAssistantMessageId: originalId,
        });
        if (!executor) throw new CoreError('internal_error', 'no runtime executor is configured on this Core');
        void executor.execute(result.attempt.id).catch(() => { /* terminal failure is durably recorded */ });
        return { status: 201, body: result };
      }),
    );
  });

  // --- M32: Execution attempts ---
  router.post('/v1/attempts', (ctx) => {
    const key = requireIdempotencyKey(ctx);
    const body = asRecord(ctx.body);
    return withIdempotency(ctx.db, { key, clientId: ctx.clientId, routeId: 'attempts.create' }, ctx.body, () =>
      withRuntimeBroadcast(ctx, broadcaster, () => ({
        status: 201,
        body: attempts.createAttempt(ctx.db, {
          requestId: requireString(body, 'requestId'),
          kind: requireString(body, 'kind') as AttemptKind,
          actor: ctx.actor,
          clientId: ctx.clientId,
          context: {
            workspaceRoot: (body.workspaceRoot as string) ?? (requireString(body, 'kind') === 'saath_kar' ? executor?.contextDefaults().workspaceRoot : null),
            selectedProvider: executor?.contextDefaults().selectedProvider,
            selectedModel: executor?.contextDefaults().selectedModel,
            allowedTools: requireString(body, 'kind') === 'saath_kar' ? executor?.contextDefaults().allowedTools : [],
          },
        }),
      })),
    );
  });

  // Tasks screen: durable attempts with model, worker, current activity and last event.
  router.get('/v1/tasks/overview', (ctx) => ({
    status: 200,
    body: { tasks: listTaskOverview(ctx.db, optionalNumber(ctx.query, 'limit') ?? 20) },
  }));

  router.get('/v1/attempts', (ctx) => {
    const requestId = ctx.query.get('requestId') ?? undefined;
    const status = (ctx.query.get('status') as AttemptStatus | null) ?? undefined;
    const activeOnly = ctx.query.get('activeOnly') === 'true';
    const limit = optionalNumber(ctx.query, 'limit');
    const offset = optionalNumber(ctx.query, 'offset');
    return { status: 200, body: { attempts: attempts.listAttempts(ctx.db, { requestId, status, activeOnly, limit, offset }) } };
  });

  router.get('/v1/attempts/:id', (ctx, match) => ({ status: 200, body: attempts.getAttempt(ctx.db, match.params.id) }));
  router.get('/v1/attempts/:id/context', (ctx, match) => ({ status: 200, body: getAttemptContext(ctx.db, match.params.id) }));

  // --- M32 Priority 1: Core-owned execution ---
  // Kicks off in-process execution of an attempt (model call runs inside the
  // Core, not the Extension Host). Fire-and-forget: returns 202 immediately;
  // progress is observed via the runtime_event / runtime_token WS channel and
  // attempt polling. Because the Core is a separate process, execution survives
  // the Extension Host/webview going away.
  router.post('/v1/attempts/:id/execute', (ctx, match) => {
    console.log(`[karkedikha-core ${new Date().toISOString()}] attemptId=${match.params.id} stage=execute_received`);
    const key = requireIdempotencyKey(ctx);
    return withIdempotency(ctx.db, { key, clientId: ctx.clientId, routeId: `attempts.execute:${match.params.id}` }, ctx.body, () => {
      const attempt = attempts.getAttempt(ctx.db, match.params.id);
      if (!executor) {
        throw new CoreError('internal_error', 'no runtime executor is configured on this Core');
      }
      const body = (ctx.body ?? {}) as Record<string, unknown>;
      const workingDirectory = typeof body.workingDirectory === 'string' ? body.workingDirectory : undefined;
      executor.validateAttemptContext(match.params.id, { workingDirectory });
      // Do not await — execution runs in-process independently of this request.
      void executor.execute(match.params.id, { workingDirectory }).catch((err) => { console.error('[karkedikha-core EXECUTION FAILED]', err); });
      return { status: 202, body: { status: 'accepted', attemptId: attempt.id } };
    });
  });

  // --- M32: Activity — inspection works with no repository, no vscode dependency ---
  router.get('/v1/attempts/:id/recovery', (ctx, match) => {
    const attempt = attempts.getAttempt(ctx.db, match.params.id);
    const attemptApprovals = approvals.listApprovalsForAttempt(ctx.db, match.params.id);
    const context = getAttemptContext(ctx.db, match.params.id);
    return {
      status: 200,
      body: {
        classification: classifyAttemptRecovery(attempt, attemptApprovals, new Date().toISOString()),
        contextIdentity: context.contextIdentity,
        contextHash: context.contextHash,
      },
    };
  });

  // --- M33: durable task-history projection (additive, strictly read-only) ---
  router.get('/v1/history/tasks', (ctx) => {
    const limit = optionalNumber(ctx.query, 'limit');
    const offset = optionalNumber(ctx.query, 'offset');
    const workspaceRoot = ctx.query.get('workspaceRoot') ?? undefined;
    return { status: 200, body: { tasks: listTaskHistory(ctx.db, { limit, offset, workspaceRoot }) } };
  });

  router.get('/v1/history/tasks/:id', (ctx, match) => ({
    status: 200,
    body: getTaskHistoryDetail(ctx.db, match.params.id),
  }));

  router.get('/v1/workspaces/attempt-rehydration', (ctx) => {
    const workspaceRoot = ctx.query.get('workspaceRoot');
    if (!workspaceRoot) throw new CoreError('invalid_request', 'workspaceRoot is required');
    return { status: 200, body: listWorkspaceAttemptRehydration(ctx.db, workspaceRoot) };
  });

  // M38: read-only capability-card display query, independent of the
  // active-only execution-rehydration route above — see
  // core/domain/capabilityActionHistory.ts. Never creates an attempt/
  // approval/idempotency row; a resolved/denied card must keep restoring
  // for display even after its attempt has gone terminal.
  router.get('/v1/workspaces/recent-capability-actions', (ctx) => {
    const workspaceRoot = ctx.query.get('workspaceRoot');
    if (!workspaceRoot) throw new CoreError('invalid_request', 'workspaceRoot is required');
    return {
      status: 200,
      body: listRecentWorkspaceCapabilityActions(ctx.db, {
        workspaceRoot,
        limit: optionalNumber(ctx.query, 'limit'),
        since: ctx.query.get('since') ?? undefined,
      }),
    };
  });

  router.post('/v1/attempts/:id/transition', (ctx, match) => {
    const key = requireIdempotencyKey(ctx);
    const body = asRecord(ctx.body);
    return withIdempotency(ctx.db, { key, clientId: ctx.clientId, routeId: `attempts.transition:${match.params.id}` }, ctx.body, () =>
      withRuntimeBroadcast(ctx, broadcaster, () => ({
        status: 200,
        body: attempts.transitionAttempt(ctx.db, match.params.id, {
          toStatus: requireString(body, 'toStatus') as AttemptStatus,
          expectedRevision: body.expectedRevision as number | undefined,
          reason: body.reason as string | undefined,
          actor: ctx.actor,
          clientId: ctx.clientId,
        }),
      })),
    );
  });

  router.post('/v1/attempts/:id/fail', (ctx, match) => {
    const key = requireIdempotencyKey(ctx);
    const body = asRecord(ctx.body);
    return withIdempotency(ctx.db, { key, clientId: ctx.clientId, routeId: `attempts.fail:${match.params.id}` }, ctx.body, () =>
      withRuntimeBroadcast(ctx, broadcaster, () => ({
        status: 200,
        body: attempts.failAttempt(ctx.db, match.params.id, {
          failureReason: requireString(body, 'failureReason'),
          expectedRevision: body.expectedRevision as number | undefined,
          actor: ctx.actor,
          clientId: ctx.clientId,
        }),
      })),
    );
  });

  // Idempotent by design (not just via Idempotency-Key): repeated cancel clicks are no-ops.
  router.post('/v1/attempts/:id/cancel', (ctx, match) => {
    const key = requireIdempotencyKey(ctx);
    return withIdempotency(ctx.db, { key, clientId: ctx.clientId, routeId: `attempts.cancel:${match.params.id}` }, ctx.body, () =>
      withRuntimeBroadcast(ctx, broadcaster, () => {
        const result = attempts.requestCancelAttempt(ctx.db, match.params.id, { actor: ctx.actor, clientId: ctx.clientId });
        // Real cancellation: abort the live in-process model call, not just the status flag.
        executor?.cancel(match.params.id);
        return { status: 200, body: result };
      }),
    );
  });

  // Steering: an instruction the user adds while a task is working. It is recorded in the conversation like any
  // user message and handed to the live run; it never restarts the task and never creates a second one.
  router.post('/v1/attempts/:id/steer', (ctx, match) => {
    const key = requireIdempotencyKey(ctx);
    const body = asRecord(ctx.body);
    const text = typeof body.text === 'string' ? body.text.trim() : '';
    if (!text) throw new CoreError('invalid_request', 'text is required');
    return withIdempotency(ctx.db, { key, clientId: ctx.clientId, routeId: `attempts.steer:${match.params.id}` }, ctx.body, () =>
      withRuntimeBroadcast(ctx, broadcaster, () => {
        const attempt = attempts.getAttempt(ctx.db, match.params.id);
        if (isTerminalAttemptStatus(attempt.status)) {
          return { status: 200, body: { accepted: false, reason: 'That task has already finished.' } };
        }
        const correction = body.correction === true;
        const result = steerPiAttempt(match.params.id, text, { correction });
        if (!result.accepted) return { status: 200, body: result };
        const request = requests.getRequest(ctx.db, attempt.requestId);
        if (request.conversationId) {
          conversations.appendMessage(ctx.db, request.conversationId, { role: 'user', content: text, actor: ctx.actor, clientId: ctx.clientId });
        }
        // A correction changes what the task is for: the durable task record says so, on the same task identity.
        if (correction) {
          try {
            if (getTaskOutcome(ctx.db, match.params.id)) {
              updateTaskOutcome(ctx.db, { attemptId: match.params.id, objective: objectiveFromRequest(`${request.currentMessage} — corrected by the user: ${text}`) });
            }
          } catch { /* the correction itself was accepted; the record keeps its previous objective */ }
        }
        recordRuntimeEvent(ctx.db, {
          domain: 'attempt', entityId: match.params.id, eventType: correction ? 'attempt_corrected' : 'attempt_steered', actor: ctx.actor, clientId: ctx.clientId,
          metadata: { chars: text.length, ...(correction ? { mode: result.mode ?? 'steered' } : {}) },
        });
        return { status: 200, body: { accepted: true, ...(correction ? { mode: result.mode ?? 'steered' } : {}) } };
      }),
    );
  });

  router.post('/v1/attempts/:id/confirm-cancelled', (ctx, match) => {
    const key = requireIdempotencyKey(ctx);
    return withIdempotency(ctx.db, { key, clientId: ctx.clientId, routeId: `attempts.confirmCancelled:${match.params.id}` }, ctx.body, () =>
      withRuntimeBroadcast(ctx, broadcaster, () => ({
        status: 200,
        body: attempts.confirmAttemptCancelled(ctx.db, match.params.id, { actor: ctx.actor, clientId: ctx.clientId }),
      })),
    );
  });

  router.post('/v1/attempts/:id/retry', (ctx, match) => {
    const key = requireIdempotencyKey(ctx);
    const body = asRecord(ctx.body);
    return withIdempotency(ctx.db, { key, clientId: ctx.clientId, routeId: `attempts.retry:${match.params.id}` }, ctx.body, () =>
      withRuntimeBroadcast(ctx, broadcaster, () => ({
        status: 201,
        body: attempts.retryAttempt(ctx.db, {
          predecessorAttemptId: match.params.id,
          actor: ctx.actor,
          clientId: ctx.clientId,
          idempotencyKey: key,
          strategy: body.strategy as AttemptRetryStrategy | undefined,
          guidance: (body.guidance as string) ?? null,
          selectedProvider: (body.selectedProvider as string) ?? null,
          selectedModel: (body.selectedModel as string) ?? null,
          modelSelection: body.modelSelection as ModelSelectionEvidence | undefined,
        }),
      })),
    );
  });

  router.get('/v1/attempts/:id/retry-eligibility', (ctx, match) => ({
    status: 200,
    body: attemptRetryEligibility(ctx.db, match.params.id),
  }));

  router.post('/v1/attempts/:id/claim', (ctx, match) => {
    const key = requireIdempotencyKey(ctx);
    const body = asRecord(ctx.body);
    return withIdempotency(ctx.db, { key, clientId: ctx.clientId, routeId: `attempts.claim:${match.params.id}` }, ctx.body, () =>
      withRuntimeBroadcast(ctx, broadcaster, () => ({
        status: 200,
        body: attempts.claimAttempt(ctx.db, match.params.id, {
          claimOwner: requireString(body, 'claimOwner'),
          leaseMs: (body.leaseMs as number) ?? 30_000,
          actor: ctx.actor,
          clientId: ctx.clientId,
        }),
      })),
    );
  });

  // --- M32 correction: Core-owned Karke Dikha lifecycle, M15 worker protocol ---
  router.post('/v1/karke-dikha/attempts/:id/claim', (ctx, match) => {
    const key = requireIdempotencyKey(ctx);
    const body = asRecord(ctx.body);
    return withIdempotency(ctx.db, { key, clientId: ctx.clientId, routeId: `karkeDikha.claim:${match.params.id}` }, ctx.body, () =>
      withRuntimeBroadcast(ctx, broadcaster, () => ({
        status: 200,
        body: karkeDikha.claimKarkeDikhaAttempt(ctx.db, match.params.id, {
          owner: requireString(body, 'owner'),
          leaseMs: body.leaseMs as number | undefined,
          actor: ctx.actor,
          clientId: ctx.clientId,
        }),
      })),
    );
  });

  router.post('/v1/karke-dikha/attempts/:id/heartbeat', (ctx, match) => {
    const key = requireIdempotencyKey(ctx);
    const body = asRecord(ctx.body);
    return withIdempotency(ctx.db, { key, clientId: ctx.clientId, routeId: `karkeDikha.heartbeat:${match.params.id}` }, ctx.body, () => ({
      status: 200,
      body: karkeDikha.renewKarkeDikhaLease(ctx.db, match.params.id, {
        fenceToken: requireString(body, 'fenceToken'),
        owner: requireString(body, 'owner'),
        frozenContextHash: requireString(body, 'frozenContextHash'),
        leaseMs: body.leaseMs as number | undefined,
      }),
    }));
  });

  router.post('/v1/karke-dikha/attempts/:id/execution-quality', (ctx, match) => {
    const key = requireIdempotencyKey(ctx);
    const body = asRecord(ctx.body);
    return withIdempotency(ctx.db, { key, clientId: ctx.clientId, routeId: `karkeDikha.executionQuality:${match.params.id}` }, ctx.body, () =>
      withRuntimeBroadcast(ctx, broadcaster, () => ({
        status: 201,
        body: karkeDikha.recordKarkeDikhaExecutionQuality(ctx.db, match.params.id, {
          fenceToken: requireString(body, 'fenceToken'),
          owner: requireString(body, 'owner'),
          frozenContextHash: requireString(body, 'frozenContextHash'),
          eventType: requireString(body, 'eventType') as ExecutionQualityEventType,
          metadata: asRecord(body.metadata),
          actor: ctx.actor,
          clientId: ctx.clientId,
          idempotencyKey: key,
        }),
      })),
    );
  });

  router.post('/v1/karke-dikha/attempts/:id/approvals', (ctx, match) => {
    const key = requireIdempotencyKey(ctx);
    const body = asRecord(ctx.body);
    return withIdempotency(ctx.db, { key, clientId: ctx.clientId, routeId: `karkeDikha.approval:${match.params.id}` }, ctx.body, () =>
      withRuntimeBroadcast(ctx, broadcaster, () => ({
        status: 201,
        body: karkeDikha.requestKarkeDikhaApproval(ctx.db, match.params.id, {
          fenceToken: requireString(body, 'fenceToken'),
          owner: requireString(body, 'owner'),
          frozenContextHash: requireString(body, 'frozenContextHash'),
          kind: requireString(body, 'kind') as 'proposal' | 'mutation',
          summary: (body.summary as Record<string, unknown>) ?? {},
          actor: ctx.actor,
          clientId: ctx.clientId,
        }),
      })),
    );
  });

  // No response replay cache here: duplicate/replayed approval decisions must
  // reach the domain and fail closed against the consumed envelope.
  router.post('/v1/karke-dikha/approvals/:id/resolve', (ctx, match) => {
    const key = requireIdempotencyKey(ctx);
    const body = asRecord(ctx.body);
    return withRuntimeBroadcast(ctx, broadcaster, () => ({
      status: 200,
      body: karkeDikha.resolveKarkeDikhaApproval(ctx.db, match.params.id, {
        fenceToken: requireString(body, 'fenceToken'),
        owner: requireString(body, 'owner'),
        frozenContextHash: requireString(body, 'frozenContextHash'),
        resolution: requireString(body, 'resolution') as 'approved' | 'rejected',
        disposition: body.disposition as 'cancel' | 'revise' | undefined,
        attemptId: requireString(body, 'attemptId'),
        gate: requireString(body, 'gate') as ApprovalKind,
        expectedAttemptRevision: requireNumber(body, 'expectedAttemptRevision'),
        expectedAttemptStatus: requireString(body, 'expectedAttemptStatus') as AttemptStatus,
        requestedActionDigest: requireString(body, 'requestedActionDigest'),
        expectedRevision: requireNumber(body, 'expectedRevision'),
        actor: ctx.actor,
        clientId: ctx.clientId,
        idempotencyKey: key,
      }),
    }));
  });

  router.post('/v1/karke-dikha/attempts/:id/validation/start', (ctx, match) => {
    const key = requireIdempotencyKey(ctx);
    const body = asRecord(ctx.body);
    return withIdempotency(ctx.db, { key, clientId: ctx.clientId, routeId: `karkeDikha.validation.start:${match.params.id}` }, ctx.body, () =>
      withRuntimeBroadcast(ctx, broadcaster, () => ({
        status: 200,
        body: karkeDikha.beginKarkeDikhaValidation(ctx.db, match.params.id, {
          fenceToken: requireString(body, 'fenceToken'),
          owner: requireString(body, 'owner'),
          frozenContextHash: requireString(body, 'frozenContextHash'),
          actor: ctx.actor,
          clientId: ctx.clientId,
        }),
      })),
    );
  });

  router.post('/v1/karke-dikha/attempts/:id/validation/report', (ctx, match) => {
    const key = requireIdempotencyKey(ctx);
    const body = asRecord(ctx.body);
    return withIdempotency(ctx.db, { key, clientId: ctx.clientId, routeId: `karkeDikha.validation.report:${match.params.id}` }, ctx.body, () =>
      withRuntimeBroadcast(ctx, broadcaster, () => ({
        status: 200,
        body: karkeDikha.reportKarkeDikhaValidation(ctx.db, match.params.id, {
          fenceToken: requireString(body, 'fenceToken'),
          owner: requireString(body, 'owner'),
          frozenContextHash: requireString(body, 'frozenContextHash'),
          evidence: asRecord(body.evidence) as unknown as karkeDikha.KarkeDikhaValidationEvidence,
          actor: ctx.actor,
          clientId: ctx.clientId,
        }),
      })),
    );
  });

  for (const terminal of ['complete', 'fail', 'cancel'] as const) {
    router.post(`/v1/karke-dikha/attempts/:id/${terminal}`, (ctx, match) => {
      const key = requireIdempotencyKey(ctx);
      const body = asRecord(ctx.body);
      return withIdempotency(ctx.db, { key, clientId: ctx.clientId, routeId: `karkeDikha.${terminal}:${match.params.id}` }, ctx.body, () =>
        withRuntimeBroadcast(ctx, broadcaster, () => {
          const common = {
            fenceToken: requireString(body, 'fenceToken'),
            owner: requireString(body, 'owner'),
            frozenContextHash: requireString(body, 'frozenContextHash'),
            actor: ctx.actor,
            clientId: ctx.clientId,
          };
          const result = terminal === 'complete'
            ? karkeDikha.completeKarkeDikhaAttempt(ctx.db, match.params.id, { ...common, summary: body.summary as Record<string, unknown> | undefined })
            : terminal === 'fail'
              ? karkeDikha.failKarkeDikhaAttempt(ctx.db, match.params.id, { ...common, failureReason: requireString(body, 'failureReason') })
              : karkeDikha.cancelKarkeDikhaAttempt(ctx.db, match.params.id, common);
          return { status: 200, body: result };
        }),
      );
    });
  }

  // --- M32: Model invocations (requested/actual model truth) ---
  router.post('/v1/attempts/:id/model-invocations', (ctx, match) => {
    const key = requireIdempotencyKey(ctx);
    const body = asRecord(ctx.body);
    return withIdempotency(ctx.db, { key, clientId: ctx.clientId, routeId: `modelInvocations.start:${match.params.id}` }, ctx.body, () =>
      withRuntimeBroadcast(ctx, broadcaster, () => ({
        status: 201,
        body: modelInvocations.startModelInvocation(ctx.db, {
          attemptId: match.params.id,
          requestedProvider: (body.requestedProvider as string) ?? null,
          requestedModel: (body.requestedModel as string) ?? null,
          policyProvider: (body.policyProvider as string) ?? null,
          policyModel: (body.policyModel as string) ?? null,
          actor: ctx.actor,
          clientId: ctx.clientId,
        }),
      })),
    );
  });

  router.get('/v1/attempts/:id/model-invocations', (ctx, match) => ({
    status: 200,
    body: { modelInvocations: modelInvocations.listModelInvocationsForAttempt(ctx.db, match.params.id) },
  }));

  router.post('/v1/model-invocations/:id/complete', (ctx, match) => {
    const key = requireIdempotencyKey(ctx);
    const body = asRecord(ctx.body);
    return withIdempotency(ctx.db, { key, clientId: ctx.clientId, routeId: `modelInvocations.complete:${match.params.id}` }, ctx.body, () =>
      withRuntimeBroadcast(ctx, broadcaster, () => ({
        status: 200,
        body: modelInvocations.completeModelInvocation(ctx.db, match.params.id, {
          status: requireString(body, 'status') as 'succeeded' | 'failed' | 'cancelled',
          actualProvider: (body.actualProvider as string) ?? null,
          actualModel: (body.actualModel as string) ?? null,
          fallbackUsed: Boolean(body.fallbackUsed),
          fallbackReason: (body.fallbackReason as string) ?? null,
          usageMetadata: (body.usageMetadata as Record<string, unknown>) ?? {},
          actor: ctx.actor,
          clientId: ctx.clientId,
        }),
      })),
    );
  });

  // --- M32: Tool invocations ---
  router.post('/v1/attempts/:id/tool-invocations', (ctx, match) => {
    const key = requireIdempotencyKey(ctx);
    const body = asRecord(ctx.body);
    return withIdempotency(ctx.db, { key, clientId: ctx.clientId, routeId: `toolInvocations.start:${match.params.id}` }, ctx.body, () =>
      withRuntimeBroadcast(ctx, broadcaster, () => ({
        status: 201,
        body: toolInvocations.startToolInvocation(ctx.db, {
          attemptId: match.params.id,
          toolName: requireString(body, 'toolName'),
          argsSummary: (body.argsSummary as Record<string, unknown>) ?? {},
          actor: ctx.actor,
          clientId: ctx.clientId,
        }),
      })),
    );
  });

  router.get('/v1/attempts/:id/tool-invocations', (ctx, match) => ({
    status: 200,
    body: { toolInvocations: toolInvocations.listToolInvocationsForAttempt(ctx.db, match.params.id) },
  }));

  router.post('/v1/tool-invocations/:id/complete', (ctx, match) => {
    const key = requireIdempotencyKey(ctx);
    const body = asRecord(ctx.body);
    return withIdempotency(ctx.db, { key, clientId: ctx.clientId, routeId: `toolInvocations.complete:${match.params.id}` }, ctx.body, () =>
      withRuntimeBroadcast(ctx, broadcaster, () => ({
        status: 200,
        body: toolInvocations.completeToolInvocation(ctx.db, match.params.id, {
          status: requireString(body, 'status') as 'succeeded' | 'failed' | 'cancelled',
          exitCode: body.exitCode === undefined ? null : (body.exitCode as number),
          evidence: (body.evidence as Record<string, unknown>) ?? {},
          actor: ctx.actor,
          clientId: ctx.clientId,
        }),
      })),
    );
  });

  // --- M32: Approvals ---
  router.post('/v1/attempts/:id/approvals', (ctx, match) => {
    const key = requireIdempotencyKey(ctx);
    const body = asRecord(ctx.body);
    return withIdempotency(ctx.db, { key, clientId: ctx.clientId, routeId: `approvals.create:${match.params.id}` }, ctx.body, () =>
      withRuntimeBroadcast(ctx, broadcaster, () => ({
        status: 201,
        body: approvals.createApproval(ctx.db, {
          attemptId: match.params.id,
          kind: requireString(body, 'kind') as ApprovalKind,
          summary: (body.summary as Record<string, unknown>) ?? {},
          actor: ctx.actor,
          clientId: ctx.clientId,
        }),
      })),
    );
  });

  router.get('/v1/attempts/:id/approvals', (ctx, match) => ({
    status: 200,
    body: { approvals: approvals.listApprovalsForAttempt(ctx.db, match.params.id) },
  }));

  router.get('/v1/approvals/pending', (ctx) => ({ status: 200, body: { approvals: approvals.listPendingApprovals(ctx.db) } }));

  // Approval resolution intentionally bypasses response replay caching: the
  // domain must see and reject every duplicate/replayed decision explicitly.
  router.post('/v1/approvals/:id/resolve', (ctx, match) => {
    const key = requireIdempotencyKey(ctx);
    const body = asRecord(ctx.body);
    return withRuntimeBroadcast(ctx, broadcaster, () => ({
        status: 200,
        body: approvals.resolveApproval(ctx.db, match.params.id, {
          resolution: requireString(body, 'resolution') as 'approved' | 'rejected',
          attemptId: requireString(body, 'attemptId'),
          gate: requireString(body, 'gate') as ApprovalKind,
          expectedAttemptRevision: requireNumber(body, 'expectedAttemptRevision'),
          expectedAttemptStatus: requireString(body, 'expectedAttemptStatus') as AttemptStatus,
          requestedActionDigest: requireString(body, 'requestedActionDigest'),
          frozenContextHash: requireString(body, 'frozenContextHash'),
          expectedRevision: body.expectedRevision as number | undefined,
          actor: ctx.actor,
          clientId: ctx.clientId,
          idempotencyKey: key,
        }),
      }));
  });

  // --- M38: Governed external capability dispatch ---
  // The single entry point for any caller (e.g. the extension-host Forge/agent
  // tool-calling path) reaching an external-service capability (GitHub, etc.).
  // Core owns the decision, approval envelope, evidence, and idempotency —
  // see core/domain/capabilityDispatch.ts. No idempotency-key wrapper here:
  // dispatchCapability is already idempotent by construction (matching
  // pending/approved/rejected approvals are found and reused, never re-created).
  router.post('/v1/capabilities/dispatch', async (ctx) => {
    const body = asRecord(ctx.body);
    // Jarvis Connector Foundation: a connector tool (Gmail/Google
    // Calendar/WhatsApp/Printer) is additionally gated on its
    // read/draft/execute permission tier before dispatchCapability's
    // unmodified approval/evidence/idempotency path runs; every other tool
    // (workspace/github/research/memory/browser) is unaffected.
    const result = await dispatchConnectorAction(ctx.db, capabilities, connectors, {
      correlationId: requireString(body, 'correlationId'),
      toolName: requireString(body, 'toolName'),
      arguments: (body.arguments as Record<string, unknown>) ?? {},
      cwd: requireString(body, 'cwd'),
      actor: ctx.actor,
      clientId: ctx.clientId,
    });
    return { status: 200, body: result };
  });

  // --- Jarvis Connector Foundation ---
  // Truthful registry status (requirement #1) and durable read/draft/execute
  // permission grants (requirement #2) for Gmail/Google Calendar/WhatsApp/
  // Printer. See core/domain/connectors.ts — dispatch itself stays on
  // /v1/capabilities/dispatch above, gated by connectorDispatch.ts.
  router.get('/v1/connectors', (ctx) => ({
    status: 200,
    body: { connectors: listConnectorStatuses(ctx.db, connectors) },
  }));

  // --- Pandesh: the Personal Assistant brief ---
  //
  // One read-only projection of everything the operator's day actually
  // contains. `external=1` additionally reads the live calendar and mailbox
  // through the very same connector adapters and read-permission grants the
  // agent loop uses; without it the brief is Core's own state only, which is
  // what a fast Home load wants.
  router.get('/v1/assistant/brief', async (ctx) => {
    const external = ctx.query.get('external') === '1' || ctx.query.get('external') === 'true';
    const brief = await buildAssistantBrief(ctx.db, {
      connectorRegistry: connectors,
      includeExternal: external,
    });
    return { status: 200, body: { brief, markdown: renderAssistantBriefMarkdown(brief) } };
  });

  // --- Pandesh: the one proactive routine (a daily brief) ---
  router.get('/v1/assistant/routine/daily-brief', (ctx) => ({
    status: 200,
    body: { routine: getDailyBriefRoutine(ctx.db) },
  }));

  router.post('/v1/assistant/routine/daily-brief', (ctx) => {
    const body = asRecord(ctx.body);
    const enabled = body.enabled === undefined ? true : Boolean(body.enabled);
    if (!enabled) {
      return { status: 200, body: { routine: disableDailyBriefRoutine(ctx.db) } };
    }
    return {
      status: 200,
      body: {
        routine: configureDailyBriefRoutine(ctx.db, {
          dailyTime: requireString(body, 'dailyTime'),
          timezone: typeof body.timezone === 'string' ? body.timezone : undefined,
          enabled: true,
        }),
      },
    };
  });

  /**
   * Answers a pending approval straight from the operator's own click on a
   * visible card — the Home card included.
   *
   * The approval envelope is read from the approval record itself, so it can
   * never be widened: it is exactly the envelope that was shown to the
   * operator. Every guard in `resolveCapabilityApproval` still applies — the
   * attempt revision, the attempt status, the requested-action digest and the
   * frozen context hash must all still match, so a stale card is refused
   * rather than applied.
   */
  router.post('/v1/assistant/approvals/:id/resolve', (ctx, match) => {
    const key = requireIdempotencyKey(ctx);
    const body = asRecord(ctx.body);
    const approval = approvals.getApproval(ctx.db, match.params.id);
    const result = withRuntimeBroadcast(ctx, broadcaster, () => ({
      approval: resolveCapabilityApproval(ctx.db, {
        approvalId: approval.id,
        resolution: requireString(body, 'resolution') as 'approved' | 'rejected',
        attemptId: approval.attemptId,
        expectedAttemptRevision: approval.expectedAttemptRevision,
        expectedAttemptStatus: approval.expectedAttemptStatus,
        requestedActionDigest: approval.requestedActionDigest,
        frozenContextHash: approval.frozenContextHash,
        actor: ctx.actor,
        clientId: ctx.clientId,
        idempotencyKey: key,
      }),
      resumedAttemptId: findAttemptIdByPendingApproval(ctx.db, approval.id) ?? null,
    }));
    if (result.resumedAttemptId && executor) {
      void executor.execute(result.resumedAttemptId);
    }
    return { status: 200, body: { ...result.approval, resumedAttemptId: result.resumedAttemptId } };
  });

  router.post('/v1/connectors/:id/permissions', (ctx, match) => {
    const key = requireIdempotencyKey(ctx);
    const body = asRecord(ctx.body);
    const connectorId = match.params.id as ConnectorId;
    if (!connectors.has(connectorId)) {
      throw new CoreError('not_found', `connector '${connectorId}' is not registered`);
    }
    return withIdempotency(ctx.db, { key, clientId: ctx.clientId, routeId: `connectors.permissions:${connectorId}` }, ctx.body, () => ({
      status: 200,
      body: {
        permissions: setConnectorPermission(ctx.db, {
          connectorId,
          tier: requireString(body, 'tier'),
          granted: Boolean(body.granted),
          actor: ctx.actor,
          clientId: ctx.clientId,
        }),
      },
    }));
  });

  // Gmail-only: Desktop mints and refreshes the short-lived OAuth access
  // token entirely outside Core (Core's own env is fixed at spawn time), then
  // pushes it here over this same authenticated loopback connection so a
  // refresh never requires restarting Core. Never persisted, never logged —
  // see runtime/connectors/gmailAccessTokenStore.ts. This is deliberately
  // Gmail-specific, not a generic connector-credential route: no other
  // connector has a live adapter to receive one yet.
  //
  // A token push is the one moment Core actually knows something changed for
  // Gmail, so it is also the moment that must re-probe: `health()` is cheap
  // and cached by design (never itself performs I/O — see
  // `connectorCapability.ts`), so without an explicit `probeHealth()` call
  // here the adapter would report "not been probed yet" forever after a
  // fresh/restarted Core, even once a valid token is pushed. Bounded by the
  // adapter's own probe timeout; never throws past a failed probe — a probe
  // failure is truthfully reported as this connector's health, not an HTTP
  // error, since the token push itself still succeeded.
  router.patch('/v1/connectors/gmail/access-token', async (ctx) => {
    const body = asRecord(ctx.body);
    const scopes = Array.isArray(body.scopes) ? body.scopes.filter((s): s is string => typeof s === 'string') : [];
    setGmailAccessToken(
      requireString(body, 'accessToken'),
      requireString(body, 'expiresAt'),
      requireString(body, 'accountEmail'),
      scopes,
    );
    // One Google grant backs both connectors: probe both so each reports its own truth
    // (Calendar stays unavailable, with a reason, when its scope was not granted).
    await Promise.all([connectors.get('gmail')?.probeHealth(), connectors.get('google_calendar')?.probeHealth()]);
    return {
      status: 200,
      body: {
        ok: true,
        connector: getConnectorStatus(ctx.db, connectors, 'gmail'),
        connectors: { gmail: getConnectorStatus(ctx.db, connectors, 'gmail'), google_calendar: getConnectorStatus(ctx.db, connectors, 'google_calendar') },
      },
    };
  });

  router.delete('/v1/connectors/gmail/access-token', async (ctx) => {
    clearGmailAccessToken();
    // Re-probe rather than assuming: with no access token the real probe
    // truthfully fails closed (gwsGmailAdapter's probe reports "no Gmail
    // access token available"), so a previously cached `available` can never
    // survive a disconnect and leave dispatch falsely open.
    await Promise.all([connectors.get('gmail')?.probeHealth(), connectors.get('google_calendar')?.probeHealth()]);
    return { status: 200, body: { ok: true, connector: getConnectorStatus(ctx.db, connectors, 'gmail') } };
  });

  // Explicit operator-triggered re-probe (Gmail diagnostics "Retry"), and
  // generically usable by any connector once it gains a real probe. Reuses
  // the same adapter instance and health authority as every other connector
  // route — this does not add a second registry or health source.
  router.post('/v1/connectors/:id/probe', async (ctx, match) => {
    const connectorId = match.params.id as ConnectorId;
    const adapter = connectors.get(connectorId);
    if (!adapter) {
      throw new CoreError('not_found', `connector '${connectorId}' is not registered`);
    }
    await adapter.probeHealth();
    return { status: 200, body: { connector: getConnectorStatus(ctx.db, connectors, connectorId) } };
  });

  // Local-only Gmail thread summarization — a raw, tool-free completion
  // (never the agent loop, never OpenRouter). See runtime/gmailSummary.ts.
  router.post('/v1/gmail/summarize-thread', async (ctx) => {
    const body = asRecord(ctx.body);
    const model = requireString(body, 'model');
    const rawMessages = Array.isArray(body.messages) ? body.messages : [];
    const messages: GmailSummaryMessageInput[] = rawMessages.map((m) => {
      const r = asRecord(m);
      return {
        from: typeof r.from === 'string' ? r.from : '',
        subject: typeof r.subject === 'string' ? r.subject : '',
        date: typeof r.date === 'string' ? r.date : '',
        bodyText: typeof r.bodyText === 'string' ? r.bodyText : '',
      };
    });
    if (!messages.length) throw new CoreError('invalid_request', "'messages' must be a non-empty array");
    const summary = await summarizeGmailThreadLocally({ backend: summaryBackend, model, messages });
    return { status: 200, body: { summary } };
  });

  // Approval resolution intentionally bypasses response replay caching, same
  // as /v1/approvals/:id/resolve — the domain must see every duplicate
  // decision explicitly rather than replaying a cached response.
  //
  // M38: an approval's own `attemptId` is the capability-dispatch anchor
  // attempt (core/domain/capabilityDispatch.ts), which is not necessarily
  // the Saath Kar attempt whose `RuntimeExecutor` model loop is actually
  // suspended on it (core/domain/attemptLoopContinuation.ts). When one is
  // found, Core resumes it here, in-process — approve or deny, exactly once,
  // fire-and-forget the same way `/v1/attempts/:id/execute` already is —
  // rather than requiring the caller to know about or separately trigger it.
  router.post('/v1/capabilities/approvals/:id/resolve', (ctx, match) => {
    const key = requireIdempotencyKey(ctx);
    const body = asRecord(ctx.body);
    const result = withRuntimeBroadcast(ctx, broadcaster, () => ({
      approval: resolveCapabilityApproval(ctx.db, {
        approvalId: match.params.id,
        resolution: requireString(body, 'resolution') as 'approved' | 'rejected',
        attemptId: requireString(body, 'attemptId'),
        expectedAttemptRevision: requireNumber(body, 'expectedAttemptRevision'),
        expectedAttemptStatus: requireString(body, 'expectedAttemptStatus') as AttemptStatus,
        requestedActionDigest: requireString(body, 'requestedActionDigest'),
        frozenContextHash: requireString(body, 'frozenContextHash'),
        actor: ctx.actor,
        clientId: ctx.clientId,
        idempotencyKey: key,
      }),
      resumedAttemptId: findAttemptIdByPendingApproval(ctx.db, match.params.id) ?? null,
    }));
    if (result.resumedAttemptId && executor) {
      void executor.execute(result.resumedAttemptId);
    }
    return { status: 200, body: { ...result.approval, resumedAttemptId: result.resumedAttemptId } };
  });

  // Idempotent: cancelling an already-cancelling/terminal attempt is a no-op
  // (see requestCancelAttempt), so no Idempotency-Key wrapper is needed.
  router.post('/v1/capabilities/attempts/:id/cancel', (ctx, match) => ({
    status: 200,
    body: cancelCapabilityAction(ctx.db, match.params.id, { actor: ctx.actor, clientId: ctx.clientId }),
  }));

  // Read-only restart/webview-recreation restoration query: never creates an
  // attempt/approval/idempotency row, just re-derives Core's existing durable
  // state for this correlationId (e.g. the extension's chat conversationId).
  router.get('/v1/capabilities/actions', (ctx) => ({
    status: 200,
    body: listCapabilityActions(ctx.db, {
      correlationId: requireString({ correlationId: ctx.query.get('correlationId') }, 'correlationId'),
      clientId: ctx.clientId,
    }),
  }));

  // --- M32: Checkpoints ---
  router.post('/v1/attempts/:id/checkpoints', (ctx, match) => {
    const key = requireIdempotencyKey(ctx);
    const body = asRecord(ctx.body);
    return withIdempotency(ctx.db, { key, clientId: ctx.clientId, routeId: `checkpoints.create:${match.params.id}` }, ctx.body, () =>
      withRuntimeBroadcast(ctx, broadcaster, () => ({
        status: 201,
        body: checkpoints.createCheckpoint(ctx.db, {
          attemptId: match.params.id,
          kind: requireString(body, 'kind'),
          metadata: (body.metadata as Record<string, unknown>) ?? {},
          actor: ctx.actor,
          clientId: ctx.clientId,
        }),
      })),
    );
  });

  router.get('/v1/attempts/:id/checkpoints', (ctx, match) => ({
    status: 200,
    body: { checkpoints: checkpoints.listCheckpointsForAttempt(ctx.db, match.params.id) },
  }));

  // --- M32: Runtime event replay (conversation/request/attempt/invocation/approval stream) ---
  router.get('/v1/runtime-events', (ctx) => {
    const after = optionalNumber(ctx.query, 'after') ?? 0;
    const limit = Math.min(optionalNumber(ctx.query, 'limit') ?? 200, MAX_LIST_LIMIT);
    return { status: 200, body: { events: listRuntimeEventsAfter(ctx.db, after, limit) } };
  });

  // --- Migration ---
  router.post('/v1/migration/import-legacy', (ctx) => {
    const key = requireIdempotencyKey(ctx);
    const body = ctx.body as LegacyImportRequest;
    return withIdempotency(ctx.db, { key, clientId: ctx.clientId, routeId: 'migration.import-legacy' }, ctx.body, () => ({
      status: 200,
      body: importLegacyBoard(ctx.db, body),
    }));
  });

  // --- Everyday Tools (Notes / Reminders) ---
  router.get('/v1/everyday/notes', (ctx) => ({
    status: 200,
    body: {
      notes: everydayTools.listNotes(ctx.db, {
        query: ctx.query.get('query') ?? undefined,
        limit: optionalNumber(ctx.query, 'limit') ?? undefined,
      }),
    },
  }));

  router.post('/v1/everyday/notes', (ctx) => {
    const key = requireIdempotencyKey(ctx);
    const body = asRecord(ctx.body);
    return withIdempotency(ctx.db, { key, clientId: ctx.clientId, routeId: 'everyday.notes.create' }, ctx.body, () => ({
      status: 201,
      body: everydayTools.createNote(ctx.db, {
        title: typeof body.title === 'string' ? body.title : undefined,
        body: requireString(body, 'body'),
      }),
    }));
  });

  router.get('/v1/everyday/notes/:id', (ctx, match) => ({
    status: 200,
    body: everydayTools.getNote(ctx.db, match.params.id),
  }));

  router.patch('/v1/everyday/notes/:id', (ctx, match) => {
    const key = requireIdempotencyKey(ctx);
    const body = asRecord(ctx.body);
    return withIdempotency(ctx.db, { key, clientId: ctx.clientId, routeId: `everyday.notes.update:${match.params.id}` }, ctx.body, () => ({
      status: 200,
      body: everydayTools.updateNote(ctx.db, match.params.id, {
        title: typeof body.title === 'string' ? body.title : undefined,
        body: typeof body.body === 'string' ? body.body : undefined,
      }),
    }));
  });

  router.delete('/v1/everyday/notes/:id', (ctx, match) => {
    const key = requireIdempotencyKey(ctx);
    return withIdempotency(ctx.db, { key, clientId: ctx.clientId, routeId: `everyday.notes.delete:${match.params.id}` }, ctx.body, () => ({
      status: 200,
      body: everydayTools.deleteNote(ctx.db, match.params.id),
    }));
  });

  router.get('/v1/everyday/reminders', (ctx) => {
    const statusRaw = ctx.query.get('status');
    const status = statusRaw === 'open' || statusRaw === 'all'
      || statusRaw === 'scheduled' || statusRaw === 'completed'
      || statusRaw === 'cancelled' || statusRaw === 'notified'
      ? statusRaw
      : 'open';
    return {
      status: 200,
      body: {
        reminders: everydayTools.listReminders(ctx.db, {
          status,
          limit: optionalNumber(ctx.query, 'limit') ?? undefined,
        }),
        due: everydayTools.listDueReminders(ctx.db),
      },
    };
  });

  router.post('/v1/everyday/reminders', (ctx) => {
    const key = requireIdempotencyKey(ctx);
    const body = asRecord(ctx.body);
    return withIdempotency(ctx.db, { key, clientId: ctx.clientId, routeId: 'everyday.reminders.create' }, ctx.body, () => ({
      status: 201,
      body: everydayTools.createReminder(ctx.db, {
        title: requireString(body, 'title'),
        body: typeof body.body === 'string' ? body.body : undefined,
        dueAt: requireString(body, 'dueAt'),
        timezone: typeof body.timezone === 'string' ? body.timezone : undefined,
      }),
    }));
  });

  router.get('/v1/everyday/reminders/:id', (ctx, match) => ({
    status: 200,
    body: everydayTools.toReminderView(everydayTools.getReminder(ctx.db, match.params.id)),
  }));

  router.post('/v1/everyday/reminders/:id/complete', (ctx, match) => {
    const key = requireIdempotencyKey(ctx);
    return withIdempotency(ctx.db, { key, clientId: ctx.clientId, routeId: `everyday.reminders.complete:${match.params.id}` }, ctx.body, () => ({
      status: 200,
      body: everydayTools.toReminderView(everydayTools.completeReminder(ctx.db, match.params.id)),
    }));
  });

  router.post('/v1/everyday/reminders/:id/cancel', (ctx, match) => {
    const key = requireIdempotencyKey(ctx);
    return withIdempotency(ctx.db, { key, clientId: ctx.clientId, routeId: `everyday.reminders.cancel:${match.params.id}` }, ctx.body, () => ({
      status: 200,
      body: everydayTools.toReminderView(everydayTools.cancelReminder(ctx.db, match.params.id)),
    }));
  });

  router.post('/v1/everyday/reminders/:id/notified', (ctx, match) => {
    const key = requireIdempotencyKey(ctx);
    return withIdempotency(ctx.db, { key, clientId: ctx.clientId, routeId: `everyday.reminders.notified:${match.params.id}` }, ctx.body, () => ({
      status: 200,
      body: everydayTools.toReminderView(everydayTools.markReminderNotified(ctx.db, match.params.id)),
    }));
  });

  // --- Durable Command Queue ---
  router.get('/v1/command-queue', (ctx) => ({
    status: 200,
    body: commandQueue.queueSnapshot(ctx.db),
  }));

  router.post('/v1/command-queue', (ctx) => {
    const key = requireIdempotencyKey(ctx);
    const body = asRecord(ctx.body);
    return withIdempotency(ctx.db, { key, clientId: ctx.clientId, routeId: 'command-queue.enqueue' }, ctx.body, () => ({
      status: 201,
      body: commandQueue.enqueueCommand(ctx.db, {
        instruction: requireString(body, 'instruction'),
        title: typeof body.title === 'string' ? body.title : undefined,
        source: body.source === 'voice' || body.source === 'ui' ? body.source : 'text',
        dependsOnId: typeof body.dependsOnId === 'string' ? body.dependsOnId : null,
      }),
    }));
  });

  router.patch('/v1/command-queue/:id', (ctx, match) => {
    const key = requireIdempotencyKey(ctx);
    const body = asRecord(ctx.body);
    return withIdempotency(ctx.db, { key, clientId: ctx.clientId, routeId: `command-queue.edit:${match.params.id}` }, ctx.body, () => ({
      status: 200,
      body: commandQueue.editCommand(ctx.db, match.params.id, {
        instruction: typeof body.instruction === 'string' ? body.instruction : undefined,
        title: typeof body.title === 'string' ? body.title : undefined,
      }),
    }));
  });

  router.post('/v1/command-queue/:id/reorder', (ctx, match) => {
    const key = requireIdempotencyKey(ctx);
    const body = asRecord(ctx.body);
    return withIdempotency(ctx.db, { key, clientId: ctx.clientId, routeId: `command-queue.reorder:${match.params.id}` }, ctx.body, () => ({
      status: 200,
      body: commandQueue.reorderCommand(ctx.db, match.params.id, requireNumber(body, 'ordinal')),
    }));
  });

  router.post('/v1/command-queue/:id/skip', (ctx, match) => {
    const key = requireIdempotencyKey(ctx);
    return withIdempotency(ctx.db, { key, clientId: ctx.clientId, routeId: `command-queue.skip:${match.params.id}` }, ctx.body, () => ({
      status: 200,
      body: commandQueue.skipCommand(ctx.db, match.params.id),
    }));
  });

  router.post('/v1/command-queue/:id/postpone', (ctx, match) => {
    const key = requireIdempotencyKey(ctx);
    const body = asRecord(ctx.body);
    return withIdempotency(ctx.db, { key, clientId: ctx.clientId, routeId: `command-queue.postpone:${match.params.id}` }, ctx.body, () => ({
      status: 200,
      body: commandQueue.postponeCommand(ctx.db, match.params.id, requireString(body, 'until')),
    }));
  });

  router.post('/v1/command-queue/:id/remove', (ctx, match) => {
    const key = requireIdempotencyKey(ctx);
    return withIdempotency(ctx.db, { key, clientId: ctx.clientId, routeId: `command-queue.remove:${match.params.id}` }, ctx.body, () => ({
      status: 200,
      body: commandQueue.removeCommand(ctx.db, match.params.id),
    }));
  });

  router.post('/v1/command-queue/offer-next', (ctx) => {
    const key = requireIdempotencyKey(ctx);
    return withIdempotency(ctx.db, { key, clientId: ctx.clientId, routeId: 'command-queue.offer-next' }, ctx.body, () => ({
      status: 200,
      body: { item: commandQueue.offerNextConfirmation(ctx.db, Date.now(), commandQueue.resolveConfirmationMs()) },
    }));
  });

  router.post('/v1/command-queue/:id/confirm-run', (ctx, match) => {
    const key = requireIdempotencyKey(ctx);
    const body = asRecord(ctx.body);
    return withIdempotency(ctx.db, { key, clientId: ctx.clientId, routeId: `command-queue.confirm:${match.params.id}` }, ctx.body, () => ({
      status: 200,
      body: commandQueue.confirmRun(
        ctx.db,
        match.params.id,
        requireString(body, 'token'),
        requireNumber(body, 'revision'),
      ),
    }));
  });

  router.post('/v1/command-queue/:id/complete', (ctx, match) => {
    const key = requireIdempotencyKey(ctx);
    const body = asRecord(ctx.body);
    return withIdempotency(ctx.db, { key, clientId: ctx.clientId, routeId: `command-queue.complete:${match.params.id}` }, ctx.body, () => ({
      status: 200,
      body: commandQueue.completeCommand(ctx.db, match.params.id, {
        outcome: typeof body.outcome === 'string' ? body.outcome : undefined,
        attemptId: typeof body.attemptId === 'string' ? body.attemptId : undefined,
        requestId: typeof body.requestId === 'string' ? body.requestId : undefined,
      }),
    }));
  });

  router.post('/v1/command-queue/:id/fail', (ctx, match) => {
    const key = requireIdempotencyKey(ctx);
    const body = asRecord(ctx.body);
    return withIdempotency(ctx.db, { key, clientId: ctx.clientId, routeId: `command-queue.fail:${match.params.id}` }, ctx.body, () => ({
      status: 200,
      body: commandQueue.failCommand(ctx.db, match.params.id, requireString(body, 'error'), {
        attemptId: typeof body.attemptId === 'string' ? body.attemptId : undefined,
        requestId: typeof body.requestId === 'string' ? body.requestId : undefined,
      }),
    }));
  });

  router.post('/v1/command-queue/reconcile', (ctx) => {
    const key = requireIdempotencyKey(ctx);
    return withIdempotency(ctx.db, { key, clientId: ctx.clientId, routeId: 'command-queue.reconcile' }, ctx.body, () => ({
      status: 200,
      body: { items: commandQueue.reconcileInterruptedActive(ctx.db) },
    }));
  });

  // M54 Security Kernel & Safe Mode APIs
  router.post('/v1/security/safe-mode/enter', (ctx) => {
    const kernel = LocalAutonomySecurityKernel.getInstance(ctx.db);
    const principal = ctx.principal;
    if (!principal || (!principal.isTrustedHost && !principal.isTrustedOperator) || principal.isModelOrTool) {
      return {
        status: 403,
        body: {
          error: 'forbidden',
          reason: 'Unauthorized: SAFE_MODE activation requires authenticated trusted host or operator authority.',
        },
      };
    }
    const body = (ctx.body ?? {}) as { reason?: string };
    const reason = typeof body.reason === 'string' && body.reason ? body.reason : 'Emergency trusted host trigger';
    const report = kernel.getSafeModeManager().enterSafeMode({
      reason,
      actor: principal.id,
      isModelAction: false,
      principal,
    });
    return { status: 200, body: report };
  });

  router.post('/v1/security/safe-mode/exit', (ctx) => {
    const kernel = LocalAutonomySecurityKernel.getInstance(ctx.db);
    const principal = ctx.principal;
    if (!principal || !principal.isTrustedOperator || principal.isModelOrTool) {
      return {
        status: 403,
        body: {
          error: 'forbidden',
          reason: 'Unauthorized: SAFE_MODE exit requires explicit trusted operator authority. Models and unprivileged clients cannot exit SAFE_MODE.',
        },
      };
    }
    const body = (ctx.body ?? {}) as { reason?: string };
    const reason = typeof body.reason === 'string' && body.reason ? body.reason : 'Operator reset';
    const report = kernel.getSafeModeManager().exitSafeMode({
      reason,
      actor: principal.id,
      isModelAction: false,
      principal,
    });
    return { status: 200, body: report };
  });

  router.get('/v1/security/safe-mode/status', (ctx) => {
    const kernel = LocalAutonomySecurityKernel.getInstance(ctx.db);
    return { status: 200, body: kernel.getSafeModeManager().getStatus() };
  });

  router.get('/v1/security/events', (ctx) => {
    const kernel = LocalAutonomySecurityKernel.getInstance(ctx.db);
    const limit = Number(ctx.query.get('limit') ?? 50);
    const events = kernel.getJournal().getRecentEvents(limit);
    return { status: 200, body: { events } };
  });

  return router;
}
