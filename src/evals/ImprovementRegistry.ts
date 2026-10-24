import { randomUUID } from 'crypto';
import { EvalComparison, EvalRunResult } from './EvalTypes';

export type ImprovementTarget = 'prompt' | 'policy' | 'tool' | 'routing' | 'code' | 'configuration';
export type ImprovementStatus = 'proposed' | 'approved' | 'rejected' | 'implemented';

export interface ImprovementRecord {
  id: string;
  title: string;
  target: ImprovementTarget;
  description: string;
  evidenceRunIds: string[];
  expectedMetricChanges: Record<string, number>;
  status: ImprovementStatus;
  createdAt: string;
  reviewedBy?: string;
  reviewedAt?: string;
}

export class ImprovementRegistry {
  private readonly records = new Map<string, ImprovementRecord>();

  propose(input: Omit<ImprovementRecord, 'id' | 'status' | 'createdAt'>): ImprovementRecord {
    if (!input.title.trim() || !input.description.trim()) {
      throw new Error('Improvement proposal requires a title and description.');
    }
    const record: ImprovementRecord = {
      ...input,
      id: `improvement-${randomUUID()}`,
      status: 'proposed',
      createdAt: new Date().toISOString(),
      evidenceRunIds: [...new Set(input.evidenceRunIds)].sort(),
      expectedMetricChanges: { ...input.expectedMetricChanges },
    };
    this.records.set(record.id, record);
    return clone(record);
  }

  fromComparison(
    baseline: EvalRunResult,
    candidate: EvalRunResult,
    comparison: EvalComparison,
    target: ImprovementTarget,
  ): ImprovementRecord | undefined {
    if (!comparison.compatible || comparison.regressions.length === 0) return undefined;
    return this.propose({
      title: `Address ${comparison.regressions.length} evaluation regression(s)`,
      target,
      description: comparison.regressions
        .map(item => `${item.metric}: ${item.baseline} -> ${item.current}`)
        .join('; '),
      evidenceRunIds: [baseline.runId, candidate.runId],
      expectedMetricChanges: Object.fromEntries(
        comparison.regressions.map(item => [item.metric, -item.delta]),
      ),
    });
  }

  review(id: string, decision: 'approved' | 'rejected', reviewer: string): ImprovementRecord {
    const record = this.require(id);
    if (record.status !== 'proposed') throw new Error(`Improvement is already ${record.status}.`);
    record.status = decision;
    record.reviewedBy = reviewer.trim();
    record.reviewedAt = new Date().toISOString();
    return clone(record);
  }

  markImplemented(id: string): ImprovementRecord {
    const record = this.require(id);
    if (record.status !== 'approved') {
      throw new Error('Improvement must be approved before implementation.');
    }
    record.status = 'implemented';
    return clone(record);
  }

  list(status?: ImprovementStatus): ImprovementRecord[] {
    return [...this.records.values()]
      .filter(record => !status || record.status === status)
      .map(clone)
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  }

  private require(id: string): ImprovementRecord {
    const record = this.records.get(id);
    if (!record) throw new Error(`Unknown improvement proposal: ${id}`);
    return record;
  }
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}
