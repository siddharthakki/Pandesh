import * as fs from 'fs/promises';
import * as path from 'path';
import * as crypto from 'crypto';
import { TaskStore } from '../agent/TaskStore';
import {
  ValidationGate,
  ValidationRunOptions,
  ValidationSummary,
} from './ValidationTypes';
import {
  ValidationRunner as BaseValidationRunner,
  ShellValidationExecutor,
} from './BaseValidationRunner';

export { ShellValidationExecutor };

function fingerprint(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

/**
 * Strict completion gate layered over the general validation implementation.
 * An agent task may not pass validation merely because no mechanical gate was
 * discovered. In that case a durable required failure is produced and the
 * task must be blocked or repaired with an explicit validation command.
 */
export class ValidationRunner extends BaseValidationRunner {
  constructor(
    private readonly strictWorkspaceRoot: string,
    private readonly strictTaskStore?: TaskStore,
    executor?: ConstructorParameters<typeof BaseValidationRunner>[2],
  ) {
    super(strictWorkspaceRoot, strictTaskStore, executor);
  }

  async run(options: ValidationRunOptions): Promise<ValidationSummary> {
    const gates = await this.discoverGates({
      explicitGates: options.explicitGates,
      defaultTimeoutMs: options.defaultTimeoutMs,
    });
    if (gates.length > 0) {
      return super.run(options);
    }

    const now = new Date().toISOString();
    const gate: ValidationGate = {
      id: 'builtin-no-mechanical-validation',
      category: 'acceptance',
      command: '[no mechanical validation command discovered]',
      required: true,
      source: 'builtin',
      timeoutMs: 0,
    };
    const failureFingerprint = fingerprint('no-mechanical-validation-command');
    const summary: ValidationSummary = {
      schemaVersion: 1,
      taskId: options.taskId,
      attempt: options.attempt,
      startedAt: now,
      completedAt: now,
      passed: false,
      requiredPassed: false,
      results: [{
        gate,
        status: 'failed',
        exitCode: 1,
        durationMs: 0,
        stdout: '',
        stderr: 'No mechanical validation command was discovered. Configure an explicit compile, test, or acceptance gate.',
        startedAt: now,
        completedAt: now,
        fingerprint: failureFingerprint,
      }],
      failureFingerprint,
      filesChanged: [],
      commandsRun: [],
    };

    await this.strictTaskStore?.appendEvent(options.taskId, 'validation_started', {
      attempt: options.attempt,
      gates: [{
        id: gate.id,
        category: gate.category,
        command: gate.command,
        required: true,
        source: gate.source,
      }],
    });
    await this.persistStrictSummary(summary);
    await this.strictTaskStore?.appendEvent(options.taskId, 'validation_result', {
      attempt: options.attempt,
      passed: false,
      requiredPassed: false,
      failureFingerprint,
      results: [{
        id: gate.id,
        category: gate.category,
        required: true,
        status: 'failed',
        exitCode: 1,
        durationMs: 0,
        fingerprint: failureFingerprint,
      }],
    });
    return summary;
  }

  private async persistStrictSummary(summary: ValidationSummary): Promise<void> {
    const taskDir = this.strictTaskStore?.getTaskDir(summary.taskId)
      ?? path.join(this.strictWorkspaceRoot, '.ollama-agent', 'tasks', summary.taskId);
    await fs.mkdir(taskDir, { recursive: true });
    const destination = path.join(taskDir, 'validation.json');
    const temporary = `${destination}.${process.pid}.${Math.random().toString(36).slice(2, 8)}.tmp`;
    try {
      await fs.writeFile(temporary, JSON.stringify(summary, null, 2), 'utf8');
      await fs.rename(temporary, destination);
    } catch (error) {
      try { await fs.unlink(temporary); } catch { /* best effort */ }
      throw error;
    }
  }
}
