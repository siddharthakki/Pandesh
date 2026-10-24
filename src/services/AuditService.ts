import * as path from 'path';
import * as fs from 'fs/promises';
import { Config } from '../config/Config';

export type AuditEventType =
  | 'session_start'
  | 'user_message'
  | 'assistant_message'
  | 'tool_start'
  | 'tool_result'
  | 'tool_blocked'
  | 'approval_requested'
  | 'approval_accepted'
  | 'approval_rejected'
  | 'checkpoint_created'
  | 'checkpoint_restored'
  | 'command_executed'
  | 'error';

export interface AuditEvent {
  type: AuditEventType;
  sessionId: string;
  turnId?: string;
  model?: string;
  toolName?: string;
  path?: string;
  decision?: string;
  success?: boolean;
  durationMs?: number;
  error?: string;
  checkpointId?: string;
  meta?: Record<string, unknown>;
  timestamp: string;
}

export class AuditService {
  private workspaceRoot: string;

  constructor(workspaceRoot: string) {
    this.workspaceRoot = workspaceRoot;
  }

  async log(event: Omit<AuditEvent, 'timestamp'>): Promise<void> {
    if (!Config.getEnableAuditLog()) {
      return;
    }

    const record: AuditEvent = { ...event, timestamp: new Date().toISOString() };
    const line = JSON.stringify(record) + '\n';

    const date = new Date().toISOString().slice(0, 10);
    const auditDir = path.join(this.workspaceRoot, '.ollama-agent', 'audit');
    const auditFile = path.join(auditDir, `${date}.jsonl`);

    try {
      await fs.mkdir(auditDir, { recursive: true });
      await fs.appendFile(auditFile, line, 'utf8');
    } catch {
      // Audit failures must not crash the agent
    }
  }
}
