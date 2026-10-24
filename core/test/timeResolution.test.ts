import { describe, it, expect } from 'vitest';
import { resolveTimeExpression, localWallTimeToIso } from '../domain/timeResolution';

const LA = 'America/Los_Angeles';
// Mon 2026-10-19 10:00 PDT
const MON = Date.parse('2026-10-19T17:00:00Z');
const ok = (e: string, now = MON, tz = LA) => { const r = resolveTimeExpression(e, now, tz); if ('error' in r) throw new Error(r.error); return r; };

describe('resolveTimeExpression', () => {
  it('resolves relative days against the zone, not UTC', () => {
    expect(ok('tomorrow').date).toBe('2026-10-20');
    expect(ok('in 8 days').date).toBe('2026-10-27');
    expect(ok('8 days from today').weekday).toBe('tuesday');
    // 23:30 PDT Sunday is already Monday in UTC: "today" must stay Sunday.
    expect(ok('today', Date.parse('2026-10-26T06:30:00Z')).date).toBe('2026-10-25');
  });
  it('next/this weekday and clock times', () => {
    expect(ok('friday').date).toBe('2026-10-23');
    expect(ok('next friday').date).toBe('2026-10-30');
    expect(ok('next monday').date).toBe('2026-10-26');
    const r = ok('tomorrow at 3pm');
    expect(r.iso).toBe('2026-10-20T15:00:00-07:00');
    expect(r.utc).toBe('2026-10-20T22:00:00.000Z');
  });
  it('uses the offset in force on the target day across DST end (2026-11-01)', () => {
    const r = ok('next sunday at 9:00', Date.parse('2026-10-28T17:00:00Z'));
    expect(r.date).toBe('2026-11-08');
    expect(ok('in 6 days 9am', Date.parse('2026-10-28T17:00:00Z')).iso).toBe('2026-11-03T09:00:00-08:00');
    expect(localWallTimeToIso('2026-11-02', '09:00', LA)).toBe('2026-11-02T17:00:00.000Z');
    expect(localWallTimeToIso('2026-10-30', '09:00', LA)).toBe('2026-10-30T16:00:00.000Z');
  });
  it('rejects ambiguity and impossible dates', () => {
    expect(resolveTimeExpression('whenever', MON, LA)).toHaveProperty('error');
    expect(() => localWallTimeToIso('2026-02-30', '09:00', LA)).toThrow();
    expect(() => localWallTimeToIso('2026-10-20', '25:00', LA)).toThrow();
  });
});
