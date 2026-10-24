import { describe, it, expect } from 'vitest';
import * as os from 'os';
import { CpuUsageSampler, sampleRam, sampleGpus, sampleDisks } from '../../telemetry/ResourceTelemetry';
import { HysteresisGate, SustainedPressurePolicy } from '../../telemetry/SustainedPressurePolicy';
import { MissionSupervisor } from '../../mission/MissionSupervisor';

describe('M44.5 CpuUsageSampler', () => {
  it('returns undefined on the first sample (no baseline yet) and a bounded percentage after', () => {
    const sampler = new CpuUsageSampler();
    expect(sampler.sample()).toBeUndefined();
    const second = sampler.sample();
    if (second !== undefined) {
      expect(second).toBeGreaterThanOrEqual(0);
      expect(second).toBeLessThanOrEqual(100);
    }
  });
});

describe('M44.5 sampleRam', () => {
  it('reports totalBytes consistent with os.totalmem()', () => {
    const ram = sampleRam();
    expect(ram.totalBytes).toBe(os.totalmem());
    expect(ram.usedPercent).toBeGreaterThanOrEqual(0);
    expect(ram.usedPercent).toBeLessThanOrEqual(100);
  });
});

describe('M44.5 sampleGpus / sampleDisks never throw', () => {
  it('sampleGpus resolves to an array or undefined, never rejects', async () => {
    await expect(sampleGpus()).resolves.not.toThrow();
  });

  it('sampleDisks resolves to an array or undefined, never rejects', async () => {
    await expect(sampleDisks()).resolves.not.toThrow();
  });
});

describe('M44.5 HysteresisGate', () => {
  it('requires enterThreshold >= exitThreshold', () => {
    expect(() => new HysteresisGate({ enterThreshold: 10, exitThreshold: 20, minSustainedMs: 1000 })).toThrow();
  });

  it('does not flip to pressure on a single spike shorter than minSustainedMs', () => {
    const gate = new HysteresisGate({ enterThreshold: 80, exitThreshold: 60, minSustainedMs: 5000 });
    expect(gate.sample(90, 0)).toBe('normal');
    expect(gate.sample(90, 2000)).toBe('normal');
  });

  it('flips to pressure once the value is sustained for minSustainedMs', () => {
    const gate = new HysteresisGate({ enterThreshold: 80, exitThreshold: 60, minSustainedMs: 5000 });
    gate.sample(90, 0);
    expect(gate.sample(90, 5000)).toBe('pressure');
  });

  it('a dip below enterThreshold (but above exitThreshold) resets the enter timer', () => {
    const gate = new HysteresisGate({ enterThreshold: 80, exitThreshold: 60, minSustainedMs: 5000 });
    gate.sample(90, 0);
    gate.sample(70, 2000); // dips below enter, above exit — resets
    expect(gate.sample(90, 6000)).toBe('normal');
  });

  it('leaves pressure only once exitThreshold is sustained for minSustainedMs', () => {
    const gate = new HysteresisGate({ enterThreshold: 80, exitThreshold: 60, minSustainedMs: 5000 });
    gate.sample(90, 0);
    gate.sample(90, 5000); // now under pressure
    expect(gate.sample(50, 6000)).toBe('pressure');
    expect(gate.sample(50, 11000)).toBe('normal');
  });
});

describe('M44.5 SustainedPressurePolicy', () => {
  it('evaluates only configured gauges and leaves the rest at prior state', () => {
    const policy = new SustainedPressurePolicy({
      gpuTempC: { enterThreshold: 85, exitThreshold: 75, minSustainedMs: 0 },
      ramUsedPercent: { enterThreshold: 90, exitThreshold: 80, minSustainedMs: 0 },
    });
    const result = policy.evaluate({ gpuTempC: 90 }, 0);
    expect(result.gpuTempC).toBe('pressure');
    expect(result.ramUsedPercent).toBe('normal');
  });

  it('isUnderPressure is true when any configured gauge is under pressure', () => {
    const policy = new SustainedPressurePolicy({
      gpuTempC: { enterThreshold: 85, exitThreshold: 75, minSustainedMs: 0 },
    });
    expect(policy.isUnderPressure({ gpuTempC: 90 }, 0)).toBe(true);
    expect(policy.isUnderPressure({ gpuTempC: 10 }, 1)).toBe(false);
  });
});

describe('M44.5 MissionSupervisor.isUnderResourcePressure', () => {
  it('is true when any gate state is pressure, purely from already-computed states', () => {
    const supervisor = new MissionSupervisor();
    expect(supervisor.isUnderResourcePressure({ gpuTempC: 'normal', ramUsedPercent: 'pressure' })).toBe(true);
    expect(supervisor.isUnderResourcePressure({ gpuTempC: 'normal' })).toBe(false);
  });
});
