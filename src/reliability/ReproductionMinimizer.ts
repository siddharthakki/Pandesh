import { randomUUID } from 'crypto';
import { CorrelatedEvent } from './EventCorrelation';

export interface ReproductionRecipe {
  id: string;
  traceId: string;
  steps: string[];
  files: string[];
  expectedFailure: string;
  evidenceEventIds: string[];
}

export interface MinimizationProbe<T> {
  reproduces(items: readonly T[], signal: AbortSignal): Promise<boolean>;
}

export interface MinimizationResult<T> {
  originalSize: number;
  minimized: T[];
  probes: number;
  reproduced: boolean;
}

export class ReproductionMinimizer {
  recipe(traceId: string, events: readonly CorrelatedEvent[]): ReproductionRecipe {
    const traceEvents = events
      .filter(event => event.traceId === traceId)
      .sort((left, right) => left.timestamp.localeCompare(right.timestamp));
    const failure = [...traceEvents].reverse().find(event => event.outcome === 'failed');
    if (!failure) throw new Error(`Trace has no failure: ${traceId}`);
    return {
      id: `reproduction-${randomUUID()}`,
      traceId,
      steps: traceEvents
        .filter(event => ['tool', 'process', 'test', 'validation', 'change'].includes(event.category))
        .map(event => `${event.category}: ${event.summary}`),
      files: [...new Set(traceEvents.flatMap(event => event.files))].sort(),
      expectedFailure: failure.detail ?? failure.summary,
      evidenceEventIds: traceEvents.map(event => event.id),
    };
  }

  async minimize<T>(
    original: readonly T[],
    probe: MinimizationProbe<T>,
    signal: AbortSignal = new AbortController().signal,
  ): Promise<MinimizationResult<T>> {
    let probes = 0;
    let current = [...original];
    if (current.length === 0) {
      return { originalSize: 0, minimized: [], probes: 0, reproduced: false };
    }
    probes += 1;
    if (!await probe.reproduces(current, signal)) {
      return { originalSize: original.length, minimized: current, probes, reproduced: false };
    }

    let partitions = 2;
    while (current.length >= 2) {
      if (signal.aborted) throw cancellationError();
      const chunks = partition(current, partitions);
      let reduced = false;

      for (const chunk of chunks) {
        const complement = current.filter(item => !chunk.includes(item));
        if (complement.length === 0) continue;
        probes += 1;
        if (await probe.reproduces(complement, signal)) {
          current = complement;
          partitions = Math.max(2, partitions - 1);
          reduced = true;
          break;
        }
      }

      if (reduced) continue;
      if (partitions >= current.length) break;
      partitions = Math.min(current.length, partitions * 2);
    }

    return {
      originalSize: original.length,
      minimized: current,
      probes,
      reproduced: true,
    };
  }
}

function partition<T>(items: T[], count: number): T[][] {
  const chunks: T[][] = [];
  const size = Math.ceil(items.length / count);
  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }
  return chunks;
}

function cancellationError(): Error {
  const error = new Error('Failure minimization cancelled.');
  error.name = 'AbortError';
  return error;
}
