import { describe, it, expect } from 'vitest';
import { groupsForText } from '../runtime/chatToolSelection';

/** The selector decides what is OFFERED first; it never authorizes anything (approvals and privacy gates are separate). */
describe('tool groups: a mention is not a request', () => {
  it.each([
    ['How many files are in the events folder?', 'calendar'],
    ['List the files in the calendar directory', 'calendar'],
    ['Wie viele Dateien liegen im Ordner calendar?', 'calendar'],
    ['Why does my JavaScript click event handler fire twice?', 'calendar'],
    ['Add an event listener for the inbox button in my React component', 'email'],
    ['Translate the sentence "check my Gmail inbox for invoices" into German', 'email'],
    ["Don't check my email or calendar, just tell me what 2+2 is", 'email'],
    ["Don't check my email or calendar, just tell me what 2+2 is", 'calendar'],
    ["Please don't summarize my inbox, I only want to know what a MIME type is", 'email'],
    ['In my code, `inbox.on("mail", fn)` is not firing. Why?', 'email'],
    ['list everything in events/ then tell me which is newest', 'calendar'],
  ])('%j does not point at %s', (text, group) => {
    expect(groupsForText(text).has(group)).toBe(false);
  });

  it.each([
    ['Show my unread emails from today', 'email'],
    ['What meetings do I have tomorrow?', 'calendar'],
    ['Check my calendar for Friday and draft an email to Sam', 'calendar'],
    ['Check my calendar for Friday and draft an email to Sam', 'email'],
    ['Welche Termine habe ich morgen im Kalender?', 'calendar'],
    ['Zeig mir meine Besprechungen im Kalender', 'calendar'],
    ['Zeig mir meinen Posteingang', 'email'],
    ['Send an email to anna@example.com and add the call to my calendar', 'calendar'],
    ['Look up the current price of a Raspberry Pi 5 online', 'web'],
    ['Search my inbox for the invoice and then add the due date to my calendar', 'email'],
    ['Search my inbox for the invoice and then add the due date to my calendar', 'calendar'],
  ])('%j still points at %s', (text, group) => {
    expect(groupsForText(text).has(group)).toBe(true);
  });
});
