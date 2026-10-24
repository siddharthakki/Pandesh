import { describe, expect, it } from 'vitest';
import { routeSendWhileRunning } from '../src/host/composerRouting';

describe('a message typed while a task works', () => {
  it.each([
    'What is 17 times 23?',
    'Quick question: what is 17 times 23?',
    'Is Ulm in Bavaria or Baden-Württemberg?',
    'btw how many days until Christmas',
    'Can you tell me the capital of Australia?',
    'Who wrote Faust?',
  ])('is answered alongside, without touching the task: %s', (text) => {
    expect(routeSendWhileRunning(text)).toBe('side_question');
  });

  it.each([
    'Also include the line count in each summary',
    'Actually use bullet points instead',
    "Don't include report_9",
    'Can you also add a title at the top?',
    'Make it shorter',
    'steer: skip the last two files',
    'Only the first three files please',
  ])('adjusts the running task: %s', (text) => {
    expect(routeSendWhileRunning(text)).toBe('steer');
  });

  it.each([
    'Write a Python script that renames every photo in my Pictures folder by date',
    'Draft the quarterly newsletter and save it as newsletter.md',
    '',
    'Please research the best local models for coding and compare them in a table with sources and prices for each, then write the findings up in a report with a recommendation for my RTX 3090. Include benchmarks where you can find them and note anything that looks unreliable or outdated, then list follow-up questions for me.',
  ])('is a separate request that waits its turn: %s', (text) => {
    expect(routeSendWhileRunning(text)).toBe('queue');
  });

  it('never lets a long question hide a new job', () => {
    const long = `How would you build ${'a very large system '.repeat(20)}?`;
    expect(routeSendWhileRunning(long)).toBe('queue');
  });
});

describe('a correction typed while a task works', () => {
  it.each([
    'No wait, make it for RTX 5090.',
    'no, I meant the RTX 5090',
    'Sorry, I meant RTX 5090',
    'Scratch that, do it for the 5090',
    'Wait, make it for the RTX 5090',
    'Nope, change it to Berlin',
    'Make that RTX 5090 instead',
  ])('replaces the request: %s', (text) => {
    expect(routeSendWhileRunning(text)).toBe('correct');
  });

  it.each([
    ['No, what is 17 times 23?', 'side_question'],
    ['no thanks', 'queue'],
    ['No', 'queue'],
    ['Quick question: what is the capital of Peru?', 'side_question'],
    ['Also include the line count in each summary', 'steer'],
    ['Write a Python script that renames every photo in my Pictures folder by date', 'queue'],
  ] as const)('is not mistaken for a correction: %s', (text, expected) => {
    expect(routeSendWhileRunning(text)).toBe(expected);
  });
});
