/** Re-run C2: a weekday and a date that do not belong together are corrected from the tool's own date. */
import { describe, expect, it } from 'vitest';
import { correctWeekdayDates } from '../runtime/dateConsistency';

const NOW = new Date('2026-11-08T15:19:00Z'); // Sunday

describe('correctWeekdayDates', () => {
  it('fixes the re-run C2 reply from the reminder tool result', () => {
    const reply = "OK. I've set a reminder for your dentist appointment on Tuesday, November 11th, at 2:00 PM (one hour before your 3:00 PM appointment).";
    const out = correctWeekdayDates(reply, ['Reminder created (id r1): "Dentist Appointment Reminder" due Tue 10 Nov, 14:00.', '{"date": "2026-11-10", "weekday": "tuesday"}'], NOW);
    expect(out.text).toContain('Tuesday, November 10th, at 2:00 PM');
    expect(out.corrections).toHaveLength(1);
  });

  it('handles day-before-month order', () => {
    const out = correctWeekdayDates('Due Tuesday 11 November at 14:00.', ['due Tue 10 Nov, 14:00'], NOW);
    expect(out.text).toBe('Due Tuesday 10 November at 14:00.');
  });

  it('leaves a consistent date alone, and does nothing without a confident tool date', () => {
    expect(correctWeekdayDates('On Tuesday, November 10th.', ['due Tue 10 Nov'], NOW).corrections).toHaveLength(0);
    expect(correctWeekdayDates('On Tuesday, November 11th.', [], NOW).corrections).toHaveLength(0);
    expect(correctWeekdayDates('On Tuesday, November 11th.', ['2026-11-10', '2026-11-17'], NOW).corrections).toHaveLength(0);
  });
});
