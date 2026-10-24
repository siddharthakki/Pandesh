import type { CheckpointMeta, CheckpointCreateMeta } from '../../agent/CheckpointManager';

export class MockCheckpointManager {
  readonly created: Array<{ files: string[]; meta: CheckpointCreateMeta }> = [];
  readonly rewound: string[] = [];

  async createCheckpoint(files: string[], meta: CheckpointCreateMeta): Promise<string | null> {
    const id = `cp_mock_${Date.now()}`;
    this.created.push({ files, meta });
    return id;
  }

  async rewindCheckpoint(id: string): Promise<{ restored: string[]; skipped: string[] } | null> {
    this.rewound.push(id);
    return { restored: [], skipped: [] };
  }

  async rewindLastCheckpoint(): Promise<{ id: string; restored: string[]; skipped: string[] } | null> {
    return null;
  }

  async rewindIteration(_iterationId: string): Promise<{ count: number; restored: string[]; skipped: string[] }> {
    return { count: 0, restored: [], skipped: [] };
  }

  async rewindAll(_opts: { confirm: true }): Promise<{ checkpointsRemoved: number; restored: string[]; skipped: string[] }> {
    return { checkpointsRemoved: 0, restored: [], skipped: [] };
  }

  async pruneOldCheckpoints(_maxCount: number): Promise<number> {
    return 0;
  }

  async pruneBySessionId(_sessionId: string): Promise<number> {
    return 0;
  }

  async listCheckpoints(): Promise<CheckpointMeta[]> {
    return [];
  }

  reset(): void {
    this.created.length = 0;
    this.rewound.length = 0;
  }
}
