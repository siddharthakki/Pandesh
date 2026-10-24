import { describe, it, expect } from 'vitest';
import { judgeCalendarMutationIntent } from '../domain/connectorIntent';

const verdict = (tool: string, text: string) => judgeCalendarMutationIntent(tool, text).allowed;

describe('calendar mutation needs the user to have asked for one', () => {
  it('refuses a draft for the observed failure: three slots without creating events', () => {
    const text = 'Suggest three available 30-minute meeting slots next week for me and Anna, without creating any events.';
    const result = judgeCalendarMutationIntent('calendar_draft_event', text);
    expect(result.allowed).toBe(false);
    expect((result as { reason: string }).reason).toMatch(/no approval was requested/);
    for (const tool of ['calendar_create_event', 'calendar_update_event', 'calendar_delete_event']) expect(verdict(tool, text)).toBe(false);
  });

  it.each([
    'When am I free tomorrow afternoon?',
    'Find me three free slots for a 45 minute call this week',
    "What's my availability on Thursday",
    "Don't book anything, just show open times",
    'Suggest some times for a meeting with Sam. No events please.',
    'This is read-only: when is Friday free?',
  ])('refuses a mutation for a read-only request: %s', (text) => {
    expect(verdict('calendar_draft_event', text)).toBe(false);
  });

  it.each([
    'Schedule a meeting with Anna tomorrow at 15:00',
    'Book the Tuesday 10:00 slot',
    'Suggest three slots next week and then create the first one',
    'Find a time on Friday and book a 30 minute call with Sam',
    'Please add a dentist appointment on 3 November at 9',
    'Cancel my 2pm meeting',
    'Yes, go ahead',
    "Don't forget to schedule the review for Monday 10:00",
    'Without asking me again, book the Friday slot',
  ])('allows a mutation (still behind the approval card) when it was asked for: %s', (text) => {
    expect(verdict('calendar_draft_event', text)).toBe(true);
    expect(verdict('calendar_create_event', text)).toBe(true);
  });

  it('never judges read tools or other connectors', () => {
    expect(verdict('calendar_check_availability', 'without creating events')).toBe(true);
    expect(verdict('calendar_list_events', 'without creating events')).toBe(true);
    expect(verdict('gmail_search', 'without creating events')).toBe(true);
    expect(verdict('calendar_draft_event', '')).toBe(true);
    expect(verdict('calendar_draft_event', undefined)).toBe(true);
  });
});
