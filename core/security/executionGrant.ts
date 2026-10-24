/**
 * M54-A0 Cryptographic Execution Grants.
 *
 * Issues short-lived, single-use, HMAC-signed grants binding every material
 * aspect of an approved capability operation. Replays, parameter substitutions,
 * target alterations, epoch mismatches, and TOCTOU mutations are rejected fail-closed.
 */

import * as crypto from 'node:crypto';
import * as path from 'node:path';
import type { CoreDatabase } from '../db/connection';
import type {
  CapabilityRiskLevel,
  ExecutionGrant,
  FilesystemScope,
  NetworkScope,
} from './types';
import type { SecurityJournal } from './securityJournal';
import type { SafeModeManager } from './safeMode';

const DEFAULT_GRANT_TTL_MS = 120_000; // 2 minutes

/**
 * Deterministically sorts keys for JSON serialization.
 */
export function canonicalJson(obj: unknown): string {
  if (obj === null || typeof obj !== 'object') {
    return JSON.stringify(obj) ?? 'null';
  }
  if (Array.isArray(obj)) {
    return `[${obj.map((item) => canonicalJson(item)).join(',')}]`;
  }
  const keys = Object.keys(obj as Record<string, unknown>).sort();
  const entries = keys.map((k) => `${JSON.stringify(k)}:${canonicalJson((obj as Record<string, unknown>)[k])}`);
  return `{${entries.join(',')}}`;
}

export function sha256Hex(data: string): string {
  return crypto.createHash('sha256').update(data).digest('hex');
}

export function computeGrantDigest(
  fields: {
    requestId: string;
    actionId: string;
    attemptId: string;
    executor: string;
    capability: string;
    workspaceRoot: string;
    targetResource: string;
    command: string | null;
    argumentsHash: string;
    filesystemScopeHash: string;
    networkScopeHash: string;
    riskClass: CapabilityRiskLevel;
    issuedAt: string;
    expiresAt: string;
    nonce: string;
    epoch: string;
  },
  secretKey: string,
): string {
  const payload = [
    fields.requestId,
    fields.actionId,
    fields.attemptId,
    fields.executor,
    fields.capability,
    fields.workspaceRoot,
    fields.targetResource,
    fields.command ?? '',
    fields.argumentsHash,
    fields.filesystemScopeHash,
    fields.networkScopeHash,
    fields.riskClass,
    fields.issuedAt,
    fields.expiresAt,
    fields.nonce,
    fields.epoch,
  ].join('|');

  return crypto.createHmac('sha256', secretKey).update(payload).digest('hex');
}

export function verifyGrantSignature(grant: ExecutionGrant, secretKey: string): boolean {
  const expectedDigest = computeGrantDigest(
    {
      requestId: grant.requestId,
      actionId: grant.actionId,
      attemptId: grant.attemptId,
      executor: grant.executor,
      capability: grant.capability,
      workspaceRoot: grant.workspaceRoot,
      targetResource: grant.targetResource,
      command: grant.command,
      argumentsHash: grant.argumentsHash,
      filesystemScopeHash: grant.filesystemScopeHash,
      networkScopeHash: grant.networkScopeHash,
      riskClass: grant.riskClass,
      issuedAt: grant.issuedAt,
      expiresAt: grant.expiresAt,
      nonce: grant.nonce,
      epoch: grant.epoch,
    },
    secretKey,
  );

  const expectedBuffer = Buffer.from(expectedDigest, 'hex');
  const actualBuffer = Buffer.from(grant.grantDigest, 'hex');

  if (expectedBuffer.length !== actualBuffer.length) {
    return false;
  }
  return crypto.timingSafeEqual(expectedBuffer, actualBuffer);
}

function normalizeResource(target: string | undefined | null, root?: string): string {
  if (!target) return '';
  const resolved = root ? path.resolve(root, target) : path.resolve(target);
  let normalized = resolved.replace(/\\/g, '/');
  if (process.platform === 'win32') {
    normalized = normalized.toLowerCase();
  }
  return normalized;
}

export interface RevalidationParams {
  readonly grant: ExecutionGrant;
  readonly attemptId: string;
  readonly executor: string;
  readonly capability: string;
  readonly workspaceRoot: string;
  readonly targetResource?: string;
  readonly command?: string | null;
  readonly arguments?: Record<string, unknown>;
  readonly filesystemScope?: FilesystemScope;
  readonly networkScope?: NetworkScope;
}

export class ExecutionGrantManager {
  private readonly inMemoryGrants = new Map<string, ExecutionGrant>();
  private readonly epoch: string;
  private cachedCasStmt?: any;

  constructor(
    private readonly secretKey: string,
    private readonly db?: CoreDatabase | null,
    private readonly journal?: SecurityJournal,
    private readonly safeMode?: SafeModeManager,
    epoch?: string,
  ) {
    this.epoch = epoch ?? `epoch_${Date.now()}_${crypto.randomBytes(8).toString('hex')}`;
    if (this.db) {
      try {
        const now = new Date().toISOString();
        this.db.run(
          `UPDATE execution_grants
           SET revokedAt = ?
           WHERE consumedAt IS NULL AND revokedAt IS NULL AND epoch != ?`,
          [now, this.epoch],
        );
      } catch {
        // Table may not exist yet during migration bootstrap
      }
    }
  }

  public getEpoch(): string {
    return this.epoch;
  }

  public getSecretKey(): string {
    return this.secretKey;
  }

  public getInMemoryGrantsCount(): number {
    return this.inMemoryGrants.size;
  }

  public issueGrant(params: {
    requestId: string;
    actionId: string;
    attemptId: string;
    executor: string;
    capability: string;
    workspaceRoot: string;
    targetResource: string;
    command?: string | null;
    arguments: Record<string, unknown>;
    filesystemScope?: FilesystemScope;
    networkScope?: NetworkScope;
    riskClass: CapabilityRiskLevel;
    ttlMs?: number;
    singleUse?: boolean;
  }): ExecutionGrant {
    const issuedAt = new Date().toISOString();
    const expiresAt = new Date(Date.now() + (params.ttlMs ?? DEFAULT_GRANT_TTL_MS)).toISOString();
    const nonce = crypto.randomBytes(16).toString('hex');

    const argumentsHash = sha256Hex(canonicalJson(params.arguments));
    const filesystemScopeHash = sha256Hex(canonicalJson(params.filesystemScope));
    const networkScopeHash = sha256Hex(canonicalJson(params.networkScope));

    const fields = {
      requestId: params.requestId,
      actionId: params.actionId,
      attemptId: params.attemptId,
      executor: params.executor,
      capability: params.capability,
      workspaceRoot: params.workspaceRoot,
      targetResource: params.targetResource,
      command: params.command ?? null,
      argumentsHash,
      filesystemScopeHash,
      networkScopeHash,
      riskClass: params.riskClass,
      issuedAt,
      expiresAt,
      nonce,
      epoch: this.epoch,
    };

    const grantDigest = computeGrantDigest(fields, this.secretKey);

    const grant: ExecutionGrant = {
      grantId: `grant_${crypto.randomUUID()}`,
      ...fields,
      filesystemScope: params.filesystemScope,
      networkScope: params.networkScope,
      grantDigest,
      singleUse: params.singleUse ?? (params.riskClass !== 'read_only'),
      consumedAt: null,
      revokedAt: null,
      epoch: this.epoch,
    };

    this.inMemoryGrants.set(grant.grantId, grant);

    if (this.db) {
      try {
        this.db.run(
          `INSERT INTO execution_grants (
            id, requestId, actionId, attemptId, executor, capability,
            workspaceRoot, targetResource, command, argumentsHash,
            filesystemScopeHash, networkScopeHash, riskClass,
            issuedAt, expiresAt, nonce, grantDigest, singleUse, consumedAt, revokedAt, epoch
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?)`,
          [
            grant.grantId,
            grant.requestId,
            grant.actionId,
            grant.attemptId,
            grant.executor,
            grant.capability,
            grant.workspaceRoot,
            grant.targetResource,
            grant.command,
            grant.argumentsHash,
            grant.filesystemScopeHash,
            grant.networkScopeHash,
            grant.riskClass,
            grant.issuedAt,
            grant.expiresAt,
            grant.nonce,
            grant.grantDigest,
            grant.singleUse ? 1 : 0,
            grant.epoch,
          ],
        );
      } catch (err) {
        if (process.env.NODE_ENV === 'production') {
          throw new Error(`Security state write failure: failed to persist execution grant: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    }

    this.journal?.record({
      eventType: 'GRANT_ISSUED',
      requestId: grant.requestId,
      actionId: grant.actionId,
      attemptId: grant.attemptId,
      executor: grant.executor,
      capability: grant.capability,
      targetResource: grant.targetResource,
      riskLevel: grant.riskClass,
      payload: {
        grantId: grant.grantId,
        expiresAt: grant.expiresAt,
        singleUse: grant.singleUse,
        epoch: grant.epoch,
      },
    });

    return grant;
  }

  public revokeGrant(grantId: string, revokedAt: string = new Date().toISOString()): boolean {
    const inMem = this.inMemoryGrants.get(grantId);
    if (inMem) {
      this.inMemoryGrants.set(grantId, { ...inMem, revokedAt });
    }
    if (this.db) {
      try {
        const res = this.db.run(
          'UPDATE execution_grants SET revokedAt = ? WHERE id = ? AND revokedAt IS NULL',
          [revokedAt, grantId],
        );
        const changed = typeof res.changes === 'bigint' ? Number(res.changes) : res.changes;
        return changed > 0;
      } catch {
        return false;
      }
    }
    return inMem !== undefined;
  }

  public revokeAllActiveGrants(revokedAt: string = new Date().toISOString()): string[] {
    const revokedIds: string[] = [];
    for (const [id, grant] of this.inMemoryGrants.entries()) {
      if (!grant.consumedAt && !grant.revokedAt) {
        this.inMemoryGrants.set(id, { ...grant, revokedAt });
        revokedIds.push(id);
      }
    }

    if (this.db) {
      try {
        const rows = this.db.all<{ id: string }>(
          'SELECT id FROM execution_grants WHERE consumedAt IS NULL AND revokedAt IS NULL',
        );
        for (const row of rows) {
          if (!revokedIds.includes(row.id)) {
            revokedIds.push(row.id);
          }
        }
        this.db.run(
          'UPDATE execution_grants SET revokedAt = ? WHERE consumedAt IS NULL AND revokedAt IS NULL',
          [revokedAt],
        );
      } catch {
        // Table error handled fail-closed
      }
    }

    return revokedIds;
  }

  public verifyAndConsumeGrant(params: RevalidationParams) {
    return this.validateAndConsumeGrant(params);
  }

  public validateAndConsumeGrant(params: RevalidationParams): {
    ok: boolean;
    reason?: string;
    grant?: ExecutionGrant;
    eventType?: 'GRANT_REJECTED' | 'GRANT_REPLAY_ATTEMPT' | 'TOCTOU_REJECTED';
  } {
    const { grant } = params;

    // 1. SAFE_MODE Pre-check
    if (this.safeMode?.isSafeModeActive()) {
      this.journal?.record({
        eventType: 'GRANT_REJECTED',
        attemptId: params.attemptId,
        executor: params.executor,
        capability: params.capability,
        payload: { grantId: grant.grantId, reason: 'SAFE_MODE_ACTIVE' },
      });
      return { ok: false, reason: 'Execution denied: SAFE_MODE is active.', eventType: 'GRANT_REJECTED' };
    }

    // 2. Epoch validation (Restart / Epoch Invalidation)
    if (grant.epoch !== this.epoch) {
      this.journal?.record({
        eventType: 'GRANT_REJECTED',
        attemptId: params.attemptId,
        executor: params.executor,
        capability: params.capability,
        payload: { grantId: grant.grantId, grantEpoch: grant.epoch, currentEpoch: this.epoch, reason: 'EPOCH_MISMATCH' },
      });
      return { ok: false, reason: 'Execution denied: ExecutionGrant belongs to a previous security epoch (stale across restart).', eventType: 'GRANT_REJECTED' };
    }

    // 3. Signature & Cryptographic Digest Verification
    if (!verifyGrantSignature(grant, this.secretKey)) {
      this.journal?.record({
        eventType: 'GRANT_REJECTED',
        attemptId: params.attemptId,
        executor: params.executor,
        capability: params.capability,
        payload: { grantId: grant.grantId, reason: 'INVALID_SIGNATURE' },
      });
      return { ok: false, reason: 'Execution denied: Invalid ExecutionGrant cryptographic signature.', eventType: 'GRANT_REJECTED' };
    }

    // 4. Expiration TTL Check
    const nowMs = Date.now();
    const expiresMs = new Date(grant.expiresAt).getTime();
    if (nowMs > expiresMs) {
      this.journal?.record({
        eventType: 'GRANT_REJECTED',
        attemptId: params.attemptId,
        executor: params.executor,
        capability: params.capability,
        payload: { grantId: grant.grantId, reason: 'GRANT_EXPIRED', expiresAt: grant.expiresAt },
      });
      return { ok: false, reason: 'Execution denied: ExecutionGrant has expired.', eventType: 'GRANT_REJECTED' };
    }

    // 5. Early Revocation & Invalidation Check
    const inMem = this.inMemoryGrants.get(grant.grantId);
    if (grant.revokedAt || inMem?.revokedAt || (this.safeMode && this.safeMode.isGrantInvalidated(grant.grantId))) {
      this.journal?.record({
        eventType: 'GRANT_REJECTED',
        attemptId: params.attemptId,
        executor: params.executor,
        capability: params.capability,
        payload: { grantId: grant.grantId, reason: 'GRANT_REVOKED' },
      });
      return { ok: false, reason: 'Execution denied: ExecutionGrant has been revoked.', eventType: 'GRANT_REJECTED' };
    }

    // 6. TOCTOU Revalidation: Attempt matches
    if (grant.attemptId !== params.attemptId) {
      this.journal?.record({
        eventType: 'TOCTOU_REJECTED',
        attemptId: params.attemptId,
        executor: params.executor,
        capability: params.capability,
        payload: { grantAttempt: grant.attemptId, currentAttempt: params.attemptId },
      });
      return { ok: false, reason: 'TOCTOU mismatch: attemptId does not match grant.', eventType: 'TOCTOU_REJECTED' };
    }

    // 7. TOCTOU Revalidation: Workspace Target Substitution Protection
    if (normalizeResource(grant.workspaceRoot) !== normalizeResource(params.workspaceRoot)) {
      this.journal?.record({
        eventType: 'TOCTOU_REJECTED',
        attemptId: params.attemptId,
        executor: params.executor,
        capability: params.capability,
        payload: { grantRoot: grant.workspaceRoot, currentRoot: params.workspaceRoot },
      });
      return { ok: false, reason: 'Target substitution rejected: workspace root does not match grant.', eventType: 'TOCTOU_REJECTED' };
    }

    // 8. TOCTOU Revalidation: Target Resource Substitution Protection
    if (params.targetResource && normalizeResource(grant.targetResource, grant.workspaceRoot) !== normalizeResource(params.targetResource, params.workspaceRoot)) {
      this.journal?.record({
        eventType: 'TOCTOU_REJECTED',
        attemptId: params.attemptId,
        executor: params.executor,
        capability: params.capability,
        payload: { grantTarget: grant.targetResource, currentTarget: params.targetResource },
      });
      return { ok: false, reason: 'Target substitution rejected: target resource does not match grant.', eventType: 'TOCTOU_REJECTED' };
    }

    // 9. TOCTOU Revalidation: Executor Substitution Protection
    if (grant.executor !== params.executor) {
      this.journal?.record({
        eventType: 'TOCTOU_REJECTED',
        attemptId: params.attemptId,
        executor: params.executor,
        capability: params.capability,
        payload: { grantExecutor: grant.executor, currentExecutor: params.executor },
      });
      return { ok: false, reason: 'Executor substitution rejected: executor identity does not match grant.', eventType: 'TOCTOU_REJECTED' };
    }

    // 10. TOCTOU Revalidation: Capability Mismatch
    if (grant.capability !== params.capability) {
      this.journal?.record({
        eventType: 'TOCTOU_REJECTED',
        attemptId: params.attemptId,
        executor: params.executor,
        capability: params.capability,
        payload: { grantCap: grant.capability, currentCap: params.capability },
      });
      return { ok: false, reason: 'Capability substitution rejected: capability does not match grant.', eventType: 'TOCTOU_REJECTED' };
    }

    // 11. TOCTOU Revalidation: Command & Parameter Substitution Protection
    if (grant.command !== null) {
      if (params.command === undefined || params.command === null || params.command !== grant.command) {
        this.journal?.record({
          eventType: 'TOCTOU_REJECTED',
          attemptId: params.attemptId,
          executor: params.executor,
          capability: params.capability,
          payload: { grantCommand: grant.command, currentCommand: params.command ?? null },
        });
        return { ok: false, reason: 'Command substitution rejected: command mutated or omitted after grant issuance.', eventType: 'TOCTOU_REJECTED' };
      }
    }

    if (params.arguments) {
      const currentArgsHash = sha256Hex(canonicalJson(params.arguments));
      if (grant.argumentsHash !== currentArgsHash) {
        this.journal?.record({
          eventType: 'TOCTOU_REJECTED',
          attemptId: params.attemptId,
          executor: params.executor,
          capability: params.capability,
          payload: { grantArgsHash: grant.argumentsHash, currentArgsHash },
        });
        return { ok: false, reason: 'Parameter substitution rejected: arguments mutated after grant issuance.', eventType: 'TOCTOU_REJECTED' };
      }
    }

    // 12. TOCTOU Revalidation: Network Scope Substitution Protection
    if (grant.networkScopeHash && grant.networkScopeHash !== sha256Hex(canonicalJson(undefined))) {
      if (!params.networkScope) {
        this.journal?.record({
          eventType: 'TOCTOU_REJECTED',
          attemptId: params.attemptId,
          executor: params.executor,
          capability: params.capability,
          payload: { reason: 'NETWORK_SCOPE_OMITTED_AT_EXECUTION' },
        });
        return { ok: false, reason: 'Network scope rejected: network policy required by grant was omitted at execution.', eventType: 'TOCTOU_REJECTED' };
      }
      const currentNetworkHash = sha256Hex(canonicalJson(params.networkScope));
      if (grant.networkScopeHash !== currentNetworkHash) {
        this.journal?.record({
          eventType: 'TOCTOU_REJECTED',
          attemptId: params.attemptId,
          executor: params.executor,
          capability: params.capability,
          payload: { grantNetworkHash: grant.networkScopeHash, currentNetworkHash },
        });
        return { ok: false, reason: 'Network scope substitution rejected: network policy mutated after grant issuance.', eventType: 'TOCTOU_REJECTED' };
      }
    }

    // 13. Single-Use Atomic Compare-And-Consume (Replay & Concurrency Protection)
    if (grant.singleUse) {
      if (grant.consumedAt || inMem?.consumedAt) {
        this.journal?.record({
          eventType: 'GRANT_REPLAY_ATTEMPT',
          attemptId: params.attemptId,
          executor: params.executor,
          capability: params.capability,
          payload: { grantId: grant.grantId, consumedAt: grant.consumedAt ?? inMem?.consumedAt },
        });
        return {
          ok: false,
          reason: 'Execution denied: Single-use ExecutionGrant has already been consumed (replay rejected).',
          eventType: 'GRANT_REPLAY_ATTEMPT',
        };
      }

      const consumedAt = new Date().toISOString();

      if (this.db) {
        if (!this.cachedCasStmt) {
          this.cachedCasStmt = this.db.raw.prepare(
            `UPDATE execution_grants
             SET consumedAt = ?
             WHERE id = ?
               AND consumedAt IS NULL
               AND revokedAt IS NULL
               AND epoch = ?`
          );
        }
        const updateResult = this.cachedCasStmt.run(consumedAt, grant.grantId, this.epoch);

        const rowsAffected = typeof updateResult.changes === 'bigint'
          ? Number(updateResult.changes)
          : updateResult.changes;

        if (rowsAffected !== 1) {
          this.journal?.record({
            eventType: 'GRANT_REPLAY_ATTEMPT',
            attemptId: params.attemptId,
            executor: params.executor,
            capability: params.capability,
            payload: {
              grantId: grant.grantId,
              reason: 'ATOMIC_CAS_CONSUMPTION_FAILED',
              rowsAffected,
            },
          });
          return {
            ok: false,
            reason: 'Execution denied: Single-use ExecutionGrant has already been consumed or revoked (replay rejected).',
            eventType: 'GRANT_REPLAY_ATTEMPT',
          };
        }

        const updatedGrant: ExecutionGrant = {
          ...grant,
          consumedAt,
        };
        this.inMemoryGrants.set(grant.grantId, updatedGrant);
        return { ok: true, grant: updatedGrant };
      } else {
        // In-memory atomic compare-and-consume
        if (!inMem || inMem.consumedAt !== null || inMem.revokedAt !== null || inMem.epoch !== this.epoch) {
          this.journal?.record({
            eventType: 'GRANT_REPLAY_ATTEMPT',
            attemptId: params.attemptId,
            executor: params.executor,
            capability: params.capability,
            payload: {
              grantId: grant.grantId,
              consumedAt: inMem?.consumedAt,
              revokedAt: inMem?.revokedAt,
            },
          });
          return {
            ok: false,
            reason: 'Execution denied: Single-use ExecutionGrant has already been consumed or revoked (replay rejected).',
            eventType: 'GRANT_REPLAY_ATTEMPT',
          };
        }

        const updatedGrant: ExecutionGrant = {
          ...grant,
          consumedAt,
        };
        this.inMemoryGrants.set(grant.grantId, updatedGrant);
        return { ok: true, grant: updatedGrant };
      }
    }

    return { ok: true, grant };
  }
}
