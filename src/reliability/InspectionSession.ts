export interface InspectionPoint {
  file: string;
  line: number;
  condition?: string;
}

export interface InspectionFrame {
  id: number;
  name: string;
  file?: string;
  line?: number;
  column?: number;
}

export interface InspectionValue {
  name: string;
  value: string;
  type?: string;
  reference?: number;
}

export interface InspectionSnapshot {
  reason: string;
  threadId: number;
  frames: InspectionFrame[];
  values: Record<string, InspectionValue[]>;
  capturedAt: string;
}

export interface InspectionAdapter {
  open(configuration: Record<string, unknown>, signal: AbortSignal): Promise<void>;
  setPoints(points: readonly InspectionPoint[], signal: AbortSignal): Promise<void>;
  proceed(signal: AbortSignal): Promise<void>;
  awaitPause(signal: AbortSignal): Promise<{ reason: string; threadId: number }>;
  frames(threadId: number, signal: AbortSignal): Promise<InspectionFrame[]>;
  values(frameId: number, signal: AbortSignal): Promise<InspectionValue[]>;
  close(): Promise<void>;
}

export class InspectionSession {
  private controller?: AbortController;

  constructor(private readonly adapter: InspectionAdapter) {}

  async capture(
    configuration: Record<string, unknown>,
    points: readonly InspectionPoint[],
    timeoutMs = 60_000,
  ): Promise<InspectionSnapshot> {
    if (this.controller) throw new Error('An inspection session is already active.');
    validatePoints(points);
    this.controller = new AbortController();
    const signal = this.controller.signal;
    let timer: NodeJS.Timeout | undefined;
    try {
      await this.adapter.open(clone(configuration), signal);
      await this.adapter.setPoints(points.map(clone), signal);
      await this.adapter.proceed(signal);
      const paused = await Promise.race([
        this.adapter.awaitPause(signal),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => {
            this.controller?.abort();
            const error = new Error(`Inspection timed out after ${timeoutMs}ms.`);
            error.name = 'AbortError';
            reject(error);
          }, timeoutMs);
        }),
      ]);
      const frames = (await this.adapter.frames(paused.threadId, signal)).slice(0, 100);
      const values: Record<string, InspectionValue[]> = {};
      for (const frame of frames.slice(0, 50)) {
        values[String(frame.id)] = (await this.adapter.values(frame.id, signal))
          .slice(0, 500)
          .map(value => ({ ...value, value: sanitize(value.value).slice(0, 4000) }));
      }
      return {
        reason: paused.reason,
        threadId: paused.threadId,
        frames: frames.map(clone),
        values,
        capturedAt: new Date().toISOString(),
      };
    } finally {
      if (timer) clearTimeout(timer);
      this.controller = undefined;
      await this.adapter.close();
    }
  }

  cancel(): boolean {
    if (!this.controller || this.controller.signal.aborted) return false;
    this.controller.abort();
    return true;
  }
}

function validatePoints(points: readonly InspectionPoint[]): void {
  for (const point of points) {
    const normalized = point.file.replace(/\\/g, '/');
    if (!normalized || normalized.startsWith('/') || normalized === '..' || normalized.startsWith('../') || normalized.includes('/../')) {
      throw new Error(`Invalid inspection path: ${point.file}`);
    }
    if (!Number.isInteger(point.line) || point.line < 1) {
      throw new Error(`Invalid inspection line: ${point.line}`);
    }
  }
}

function sanitize(value: string): string {
  return value
    .replace(/(authorization\s*[:=]\s*)([^\s,;]+)/ig, '$1[REDACTED]')
    .replace(/((?:api[_-]?key|token|password|secret|credential)\s*[:=]\s*)([^\s,;]+)/ig, '$1[REDACTED]');
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}
