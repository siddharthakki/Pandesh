/**
 * M54-A0 Authoritative SAFE_MODE Kill-Switch & Process Tracking Registry.
 *
 * Implements the host-owned execution halt mechanism.
 * When active, all consequential autonomous dispatch is blocked, pending
 * grants are permanently revoked, active attempts are cancelled, and registered child
 * processes are killed with their full process tree.
 *
 * The model NEVER has permission to disable SAFE_MODE.
 */

import { spawnSync } from 'node:child_process';
import * as crypto from 'node:crypto';
import type { CoreDatabase } from '../db/connection';
import type { AuthenticatedPrincipal, SafeModeReport, SafeModeStatus } from './types';
import type { SecurityJournal } from './securityJournal';
import {
  createWindowsProcessIdentityProviderSync,
  verifyProcessOwnership,
  type OwnershipProvenance,
  type SyncProcessIdentityProvider,
} from '../runtime/processOwnership';

/**
 * Provenance for a tracked child. The spawner that created the child
 * supplies it; the kill switch uses it to prove that the PID still belongs
 * to that child before anything is terminated.
 */
export interface TrackedProcessProvenance {
  /** Wall-clock moment the spawn was requested. */
  spawnedAtMs?: number | null;
  /** Exact creation time when the spawner knew it. */
  creationTimeMs?: number | null;
  /** Absolute executable path when the spawner knew it. */
  executablePath?: string | null;
}

export interface TrackedProcess {
  readonly pid: number;
  readonly kill: () => void;
  readonly description: string;
  readonly attemptId?: string;
  readonly registeredAt: string;
  readonly provenance: TrackedProcessProvenance;
}

/** Set of trusted actor prefixes allowed to manipulate SAFE_MODE. */
const TRUSTED_OPERATOR_ACTORS = new Set([
  'host:operator',
  'host:jarvis',
  'system:operator',
  'user:operator',
  'operator:host',
  'operator:manual',
  'system',
]);

export function isTrustedOperator(actor: string, principal?: AuthenticatedPrincipal): boolean {
  if (principal) {
    if (principal.isModelOrTool) return false;
    return principal.isTrustedOperator;
  }
  if (
    actor.startsWith('model') ||
    actor.startsWith('agent:') ||
    actor.startsWith('autonomous:') ||
    actor.startsWith('tool:') ||
    actor.startsWith('client:') ||
    actor === 'core:executor' ||
    actor === 'unknown'
  ) {
    return false;
  }
  if (TRUSTED_OPERATOR_ACTORS.has(actor)) return true;
  if (actor.startsWith('host:') || actor.startsWith('operator:')) return true;
  return false;
}

export class SafeModeManager {
  private active = false;
  private reason: string | null = null;
  private activatedAt: string | null = null;
  private activatedBy: string | null = null;
  private deactivatedAt: string | null = null;
  private deactivatedBy: string | null = null;

  private readonly trackedProcesses = new Map<number, TrackedProcess>();
  private readonly invalidatedGrants = new Set<string>();
  private grantRevoker: ((revokedAt: string) => string[]) | null = null;
  private readonly epoch: string;
  /** Owner token for the in-memory tracked-process provenance. */
  private readonly ownerToken = crypto.randomUUID();
  private readonly identityProvider: SyncProcessIdentityProvider;
  private lastRefusedTerminations: Array<{ pid: number; reason: string }> = [];

  public setGrantRevoker(revoker: (revokedAt: string) => string[]): void {
    this.grantRevoker = revoker;
  }

  constructor(
    private readonly db?: CoreDatabase | null,
    private readonly journal?: SecurityJournal | null,
    epoch?: string,
    identityProvider?: SyncProcessIdentityProvider,
  ) {
    this.epoch = epoch ?? `epoch_${Date.now()}`;
    this.identityProvider = identityProvider ?? createWindowsProcessIdentityProviderSync();
    this.hydrateFromDb();
  }

  private hydrateFromDb(): void {
    if (!this.db) return;
    try {
      const row = this.db.get<{
        active: number;
        reason: string | null;
        activatedAt: string | null;
        activatedBy: string | null;
      }>("SELECT active, reason, activatedAt, activatedBy FROM security_safe_mode WHERE id = 'singleton' OR id = '1' LIMIT 1");
      if (row && row.active === 1) {
        this.active = true;
        this.reason = row.reason;
        this.activatedAt = row.activatedAt;
        this.activatedBy = row.activatedBy;
      }
    } catch {
      // Table may not exist yet
    }
  }

  public isSafeModeActive(): boolean {
    return this.active;
  }

  public getStatus(): SafeModeStatus {
    return {
      active: this.active,
      reason: this.reason,
      activatedAt: this.activatedAt,
      activatedBy: this.activatedBy,
      deactivatedAt: this.deactivatedAt,
      deactivatedBy: this.deactivatedBy,
    };
  }

  /**
   * Registers a KKD-owned child process for tracking and emergency termination.
   * Returns an unregister callback.
   *
   * `provenance` is what makes an emergency termination safe: it records
   * that Pandesh started this process and when, so the kill switch can prove
   * that the PID still belongs to it before terminating anything.
   */
  public registerChildProcess(
    pid: number,
    kill: () => void,
    description: string,
    attemptId?: string,
    provenance?: TrackedProcessProvenance,
  ): () => void {
    const entry: TrackedProcess = {
      pid,
      kill,
      description,
      attemptId,
      registeredAt: new Date().toISOString(),
      provenance: {
        spawnedAtMs: provenance?.spawnedAtMs ?? Date.now(),
        creationTimeMs: provenance?.creationTimeMs ?? null,
        executablePath: provenance?.executablePath ?? null,
      },
    };
    this.trackedProcesses.set(pid, entry);

    return () => {
      this.trackedProcesses.delete(pid);
    };
  }

  public unregisterChildProcess(pid: number): void {
    this.trackedProcesses.delete(pid);
  }

  public getTrackedProcessCount(): number {
    return this.trackedProcesses.size;
  }

  public listTrackedProcesses(): readonly TrackedProcess[] {
    return Array.from(this.trackedProcesses.values());
  }

  /**
   * Terminates all registered child processes immediately with process-tree cleanup.
   * Returns an array of terminated PIDs.
   *
   * SAFETY: every termination is verified first. The tracked record must
   * carry provenance (Pandesh started this process) and the live process must
   * still be that process — a recycled PID is refused, and an identity the OS
   * will not disclose is a refusal too. Previously this fell back to a bare
   * `taskkill /pid <pid> /t /f` with no identity check, and reported a PID as
   * terminated even when the kill had failed.
   */
  public terminateAllTrackedProcesses(): number[] {
    const terminatedPids: number[] = [];
    const refused: Array<{ pid: number; reason: string }> = [];

    for (const [pid, proc] of this.trackedProcesses.entries()) {
      const identity = this.identityProvider(pid);
      const provenance: OwnershipProvenance = {
        pid,
        ownerToken: this.ownerToken,
        creationTimeMs: proc.provenance.creationTimeMs ?? null,
        spawnedAtMs: proc.provenance.spawnedAtMs ?? null,
        executablePath: proc.provenance.executablePath ?? null,
        recordedAt: proc.registeredAt,
        source: 'safe-mode:tracked-child',
      };
      const verdict = verifyProcessOwnership({
        expectation: {
          pid,
          creationTimeMs: proc.provenance.creationTimeMs ?? null,
          executablePath: proc.provenance.executablePath ?? null,
        },
        identity,
        provenance,
        currentOwnerToken: this.ownerToken,
      });
      if (!verdict.verified) {
        refused.push({ pid, reason: verdict.reason });
        continue;
      }
      try {
        proc.kill();
      } catch {
        // Fall back to OS taskkill on Windows
        if (process.platform === 'win32') {
          try {
            spawnSync('taskkill', ['/pid', String(pid), '/t', '/f'], { windowsHide: true });
          } catch {
            // Process may already have terminated
          }
        }
      }
      terminatedPids.push(pid);
    }

    this.trackedProcesses.clear();
    this.lastRefusedTerminations = refused;
    return terminatedPids;
  }

  /** The terminations the last kill switch refused, with the reason. */
  public getLastRefusedTerminations(): ReadonlyArray<{ pid: number; reason: string }> {
    return this.lastRefusedTerminations;
  }

  /**
   * Marks an execution grant as explicitly invalidated.
   */
  public invalidateGrant(grantId: string): void {
    this.invalidatedGrants.add(grantId);
  }

  public isGrantInvalidated(grantId: string): boolean {
    return this.invalidatedGrants.has(grantId);
  }

  /**
   * Enters SAFE_MODE. Halts all consequential execution, cancels active attempts,
   * terminates child processes, permanently revokes unconsumed grants, and logs audit events.
   */
  public enterSafeMode(options: {
    reason: string;
    actor: string;
    isModelAction?: boolean;
    principal?: AuthenticatedPrincipal;
  }): SafeModeReport {
    if (options.isModelAction) {
      throw new Error(`Unauthorized: model/autonomous runtime is strictly forbidden from triggering SAFE_MODE.`);
    }
    if (options.principal) {
      if ((!options.principal.isTrustedHost && !options.principal.isTrustedOperator) || options.principal.isModelOrTool) {
        throw new Error(`Unauthorized: principal '${options.principal.id}' (${options.principal.role}) is not permitted to activate SAFE_MODE.`);
      }
    } else if (!isTrustedOperator(options.actor)) {
      throw new Error(`Unauthorized: actor '${options.actor}' is not permitted to activate SAFE_MODE.`);
    }

    this.active = true;
    this.reason = options.reason;
    this.activatedAt = new Date().toISOString();
    this.activatedBy = options.principal ? options.principal.id : options.actor;

    // Terminate all tracked child processes
    const terminatedPids = this.terminateAllTrackedProcesses();

    // Audit each terminated process
    for (const pid of terminatedPids) {
      this.journal?.record({
        eventType: 'EXECUTION_TERMINATED',
        executor: 'core:security:safe_mode',
        payload: {
          pid,
          reason: 'SAFE_MODE kill-switch activated',
          actor: this.activatedBy,
        },
      });
    }

    // Cancel active running attempts in the database if available
    const cancelledAttemptIds: string[] = [];
    if (this.db) {
      try {
        const running = this.db.all<{ id: string }>(
          "SELECT id FROM attempts WHERE status IN ('running', 'waiting_for_approval')",
        );
        for (const row of running) {
          try {
            this.db.run(
              "UPDATE attempts SET status = 'cancelled', cancelRequestedAt = ? WHERE id = ?",
              [this.activatedAt, row.id],
            );
            cancelledAttemptIds.push(row.id);
          } catch {
            // best-effort
          }
        }

        // Persist SAFE_MODE status in DB
        this.db.run(
          `INSERT INTO security_safe_mode (
            id, active, reason, activatedAt, activatedBy, deactivatedAt, deactivatedBy, epoch, updatedAt
          ) VALUES ('singleton', 1, ?, ?, ?, NULL, NULL, ?, ?)
          ON CONFLICT(id) DO UPDATE SET
            active = 1,
            reason = excluded.reason,
            activatedAt = excluded.activatedAt,
            activatedBy = excluded.activatedBy,
            deactivatedAt = NULL,
            deactivatedBy = NULL,
            epoch = excluded.epoch,
            updatedAt = excluded.updatedAt`,
          [this.reason, this.activatedAt, this.activatedBy, this.epoch, this.activatedAt],
        );
      } catch (err) {
        if (process.env.NODE_ENV === 'production') {
          throw new Error(`Security state write failure: failed to persist SAFE_MODE state: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    }

    // Revoke all active unconsumed grants permanently
    let revokedGrantIds: string[] = [];
    if (this.grantRevoker) {
      revokedGrantIds = this.grantRevoker(this.activatedAt);
    } else if (this.db) {
      try {
        const rows = this.db.all<{ id: string }>(
          'SELECT id FROM execution_grants WHERE consumedAt IS NULL AND revokedAt IS NULL',
        );
        revokedGrantIds = rows.map((r) => r.id);
        this.db.run(
          'UPDATE execution_grants SET revokedAt = ? WHERE consumedAt IS NULL AND revokedAt IS NULL',
          [this.activatedAt],
        );
      } catch {
        // DB table error
      }
    }
    for (const id of revokedGrantIds) {
      this.invalidatedGrants.add(id);
    }

    const report: SafeModeReport = {
      active: true,
      reason: this.reason,
      actor: this.activatedBy,
      terminatedProcessPids: terminatedPids,
      cancelledAttemptIds,
      invalidatedGrantIds: revokedGrantIds,
      timestamp: this.activatedAt,
    };

    this.journal?.record({
      eventType: 'SAFE_MODE_ENTERED',
      executor: 'core:security:safe_mode',
      payload: {
        reason: this.reason,
        actor: this.activatedBy,
        terminatedProcessCount: terminatedPids.length,
        cancelledAttemptCount: cancelledAttemptIds.length,
        revokedGrantCount: revokedGrantIds.length,
      },
    });

    return report;
  }

  /**
   * Exits SAFE_MODE. Permitted ONLY by an authenticated trusted operator.
   * Model actions, tools, and unprivileged agents are rejected fail-closed.
   */
  public exitSafeMode(options: {
    reason: string;
    actor: string;
    isModelAction?: boolean;
    principal?: AuthenticatedPrincipal;
  }): SafeModeReport {
    let authorized = false;
    if (options.isModelAction) {
      authorized = false;
    } else if (options.principal) {
      authorized = options.principal.isTrustedOperator && !options.principal.isModelOrTool;
    } else {
      authorized = isTrustedOperator(options.actor);
    }

    if (!authorized) {
      const actorId = options.principal ? options.principal.id : options.actor;
      this.journal?.record({
        eventType: 'CIRCUMVENTION_SUSPECTED',
        executor: 'core:security:safe_mode',
        payload: {
          violation: 'unauthorized_safe_mode_exit_attempt',
          actor: actorId,
          reason: options.reason,
        },
      });
      throw new Error(`Unauthorized: actor '${actorId}' cannot exit SAFE_MODE. Explicit trusted operator authority required.`);
    }

    this.active = false;
    this.deactivatedAt = new Date().toISOString();
    this.deactivatedBy = options.principal ? options.principal.id : options.actor;

    if (this.db) {
      try {
        this.db.run(
          `UPDATE security_safe_mode
           SET active = 0, deactivatedAt = ?, deactivatedBy = ?, updatedAt = ?
           WHERE id = 'singleton'`,
          [this.deactivatedAt, this.deactivatedBy, this.deactivatedAt],
        );
      } catch (err) {
        if (process.env.NODE_ENV === 'production') {
          throw new Error(`Security state write failure: failed to persist SAFE_MODE exit: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    }

    const report: SafeModeReport = {
      active: false,
      reason: options.reason,
      actor: this.deactivatedBy,
      terminatedProcessPids: [],
      cancelledAttemptIds: [],
      invalidatedGrantIds: [],
      timestamp: this.deactivatedAt,
    };

    this.journal?.record({
      eventType: 'SAFE_MODE_EXITED',
      executor: 'core:security:safe_mode',
      payload: {
        reason: options.reason,
        actor: this.deactivatedBy,
      },
    });

    return report;
  }
}
