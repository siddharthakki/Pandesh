export type PressureState = 'normal' | 'pressure';

export interface HysteresisConfig {
  /** Value at/above which a sample starts counting toward entering pressure. */
  enterThreshold: number;
  /** Value at/below which a sample starts counting toward leaving pressure. */
  exitThreshold: number;
  /** How long a value must stay past its threshold before the state actually flips. */
  minSustainedMs: number;
}

/**
 * One gauge's hysteresis state machine: enters `pressure` only once
 * `enterThreshold` has been met continuously for `minSustainedMs`, and
 * leaves it only once `exitThreshold` has been met continuously for
 * `minSustainedMs`. A single spike (or a single dip while already under
 * pressure) never flips the state — that is the point of hysteresis: no
 * chatter around a threshold crossed once.
 */
export class HysteresisGate {
  private state: PressureState = 'normal';
  private aboveEnterSince?: number;
  private belowExitSince?: number;

  constructor(private readonly config: HysteresisConfig) {
    if (config.enterThreshold < config.exitThreshold) {
      throw new Error('enterThreshold must be >= exitThreshold (entering pressure requires a higher bar than leaving it).');
    }
  }

  get current(): PressureState {
    return this.state;
  }

  sample(value: number, now: number = Date.now()): PressureState {
    if (this.state === 'normal') {
      if (value >= this.config.enterThreshold) {
        this.aboveEnterSince ??= now;
        if (now - this.aboveEnterSince >= this.config.minSustainedMs) {
          this.state = 'pressure';
          this.aboveEnterSince = undefined;
        }
      } else {
        this.aboveEnterSince = undefined;
      }
    } else {
      if (value <= this.config.exitThreshold) {
        this.belowExitSince ??= now;
        if (now - this.belowExitSince >= this.config.minSustainedMs) {
          this.state = 'normal';
          this.belowExitSince = undefined;
        }
      } else {
        this.belowExitSince = undefined;
      }
    }
    return this.state;
  }
}

/**
 * A named set of {@link HysteresisGate}s (e.g. `gpuTempC`, `gpuUtilPercent`,
 * `vramUsedPercent`, `cpuUtilPercent`, `ramUsedPercent`, `diskFreePercent`),
 * fully configurable — deliberately no built-in defaults resembling
 * Antigravity's earlier hardcoded temperature numbers. A caller supplies
 * whichever gauges it wants monitored; an unconfigured gauge is simply
 * absent from the result, not silently defaulted.
 */
export class SustainedPressurePolicy {
  private readonly gates = new Map<string, HysteresisGate>();

  constructor(config: Record<string, HysteresisConfig>) {
    for (const [name, gateConfig] of Object.entries(config)) {
      this.gates.set(name, new HysteresisGate(gateConfig));
    }
  }

  /** Samples every configured gauge present in `values`; gauges missing from `values` keep their prior state. */
  evaluate(values: Readonly<Record<string, number>>, now: number = Date.now()): Record<string, PressureState> {
    const result: Record<string, PressureState> = {};
    for (const [name, gate] of this.gates) {
      result[name] = name in values ? gate.sample(values[name], now) : gate.current;
    }
    return result;
  }

  isUnderPressure(values: Readonly<Record<string, number>>, now: number = Date.now()): boolean {
    return Object.values(this.evaluate(values, now)).some(state => state === 'pressure');
  }
}
