import { describe, expect, it } from 'vitest';
import {
  classifyTurnOutcomeKind,
  deriveTerminalJarvisState,
  detectFileCreationIntent,
  detectImageGenerationIntent,
  detectWeatherIntent,
  extractImageGenerationPrompt,
  extractWeatherLocation,
  isStopIntent,
  planDesktopInteraction,
} from '../src/host/desktopInteractionRouting';

describe('planDesktopInteraction', () => {
  it('routes ordinary no-folder Dispatch to Core chat (baat_kar)', () => {
    expect(planDesktopInteraction({ hasFolder: false, workerId: 'local-core' })).toEqual({
      mode: 'chat',
      requestedMode: 'baat_kar',
    });
  });

  it('asks for a repository before autonomous mission without a folder', () => {
    const plan = planDesktopInteraction({ hasFolder: false, workerId: 'autonomous-mission' });
    expect(plan.blockReason).toMatch(/select a repository/i);
    expect(plan.mode).toBe('mission');
    expect(plan.needsWorkspace).toBe(true);
  });

  it('keeps Local Core when a folder is selected', () => {
    expect(planDesktopInteraction({ hasFolder: true, workerId: 'local-core' })).toEqual({
      mode: 'local_core',
      requestedMode: 'saath_kar',
    });
  });

  it('keeps mission when a folder is selected', () => {
    expect(planDesktopInteraction({ hasFolder: true, workerId: 'autonomous-mission' })).toEqual({
      mode: 'mission',
      requestedMode: 'saath_kar',
    });
  });

  it('routes a file-creation request through the governed mission path when a repository is selected, even on the default worker', () => {
    const plan = planDesktopInteraction({ hasFolder: true, workerId: 'local-core', goalText: 'write a simple python file that prints hello' });
    expect(plan.mode).toBe('mission');
    expect(plan.requestedMode).toBe('saath_kar');
    expect(plan.blockReason).toBeUndefined();
  });

  it('blocks a file-creation request with no repository selected, asking to select a folder rather than silently downgrading to chat', () => {
    const plan = planDesktopInteraction({ hasFolder: false, workerId: 'local-core', goalText: 'write a simple python file that prints hello' });
    expect(plan.mode).toBe('chat');
    expect(plan.needsWorkspace).toBe(true);
    expect(plan.blockReason).toMatch(/select a repository/i);
  });

  it('an ordinary question with no file-creation intent still routes to chat with no folder, unaffected', () => {
    const plan = planDesktopInteraction({ hasFolder: false, workerId: 'local-core', goalText: 'what does this error mean?' });
    expect(plan).toEqual({ mode: 'chat', requestedMode: 'baat_kar' });
  });

  it('a question about existing code (no create-shaped verb) with a folder selected still uses Local Core, not mission', () => {
    const plan = planDesktopInteraction({ hasFolder: true, workerId: 'local-core', goalText: 'explain what main.py does' });
    expect(plan.mode).toBe('local_core');
  });
});

describe('detectFileCreationIntent', () => {
  it.each([
    'write a simple python file that prints hello world',
    'create hello.py',
    'Create a file called notes.txt',
    'please save this as script.js',
    'generate a new module for parsing',
    'make me a small python script',
  ])('detects file-creation intent in: %s', (text) => {
    expect(detectFileCreationIntent(text)).toBe(true);
  });

  it.each([
    'what does this function do',
    'explain the bug in main.py',
    'can you review this code',
    'what is the npm package name field',
    '',
    '   ',
  ])('does not flag ordinary questions: %s', (text) => {
    expect(detectFileCreationIntent(text)).toBe(false);
  });
});

describe('detectImageGenerationIntent', () => {
  it.each([
    'generate an image of a cute panda eating dosa',
    'create a photo of a sunset over mountains',
    'draw me a picture of a cyberpunk city',
    'please make an illustration of a dragon',
    'render an artwork of a control center',
    'imagine a 3d cube with all sides of different colour. generate that',
    'imagine a cyberpunk city at night, then draw this',
  ])('detects image-generation intent in: %s', (text) => {
    expect(detectImageGenerationIntent(text)).toBe(true);
  });

  it.each([
    'what does this function do',
    'generate a new module for parsing',
    'create hello.py',
    'explain the bug in main.py',
    'make it work',
    'create that file',
    'imagine why this test fails, then make it work',
    'imagine the bug is in the parser, then create that fix',
    '',
    '   ',
  ])('does not flag file-creation or ordinary coding requests: %s', (text) => {
    expect(detectImageGenerationIntent(text)).toBe(false);
  });
});

describe('extractImageGenerationPrompt', () => {
  it('strips the instructional lead-in, keeping the actual subject', () => {
    expect(extractImageGenerationPrompt('generate an image of a cute panda eating dosa. Indian dosa.'))
      .toBe('a cute panda eating dosa. Indian dosa.');
    expect(extractImageGenerationPrompt('Please create a photo of a sunset over mountains'))
      .toBe('a sunset over mountains');
  });

  it('falls back to the original text when nothing would remain', () => {
    expect(extractImageGenerationPrompt('generate an image')).toBe('generate an image');
  });
});

describe('detectWeatherIntent', () => {
  it.each([
    "what's the weather in Ulm?",
    'what is the temperature in Bengaluru right now',
    'give me the forecast for Paris',
    'is it raining in Seattle',
  ])('detects a weather question in: %s', (text) => {
    expect(detectWeatherIntent(text)).toBe(true);
  });

  it.each([
    'what does this function do',
    'explain the bug in main.py',
    '',
    '   ',
  ])('does not flag ordinary questions: %s', (text) => {
    expect(detectWeatherIntent(text)).toBe(false);
  });
});

describe('extractWeatherLocation', () => {
  it('extracts the place name after in/for/at', () => {
    expect(extractWeatherLocation("what's the weather in Ulm?")).toBe('Ulm');
    expect(extractWeatherLocation('give me the forecast for New York')).toBe('New York');
    expect(extractWeatherLocation('what is the temperature in Bengaluru right now')).toBe('Bengaluru');
  });

  it('returns null rather than guessing when no location phrase is present', () => {
    expect(extractWeatherLocation('what is the weather like today')).toBeNull();
  });
});

describe('classifyTurnOutcomeKind', () => {
  it('a completed mission turn is workspace_changed', () => {
    expect(classifyTurnOutcomeKind({ outcome: 'completed', mode: 'mission' })).toBe('workspace_changed');
  });

  it('a completed chat turn is answered, never claiming a file was written', () => {
    expect(classifyTurnOutcomeKind({ outcome: 'completed', mode: 'chat' })).toBe('answered');
  });

  it('a completed local_core turn is answered', () => {
    expect(classifyTurnOutcomeKind({ outcome: 'completed', mode: 'local_core' })).toBe('answered');
  });

  it('a failed turn is failed regardless of mode', () => {
    expect(classifyTurnOutcomeKind({ outcome: 'failed', mode: 'mission' })).toBe('failed');
  });

  it('a cancelled turn has no truthful-outcome label', () => {
    expect(classifyTurnOutcomeKind({ outcome: 'cancelled', mode: 'chat' })).toBeNull();
  });
});

describe('deriveTerminalJarvisState', () => {
  it('uses explicit lastTurnOutcome over outcome text', () => {
    expect(deriveTerminalJarvisState({
      lastTurnOutcome: 'failed',
      terminal: true,
      finalOutcome: 'a Local Core repository question requires a selected repository workspace',
    })).toBe('failed');
  });

  it('does not treat a terminal failure reason as Completed when it omits the word fail', () => {
    expect(deriveTerminalJarvisState({
      lastTurnOutcome: null,
      terminal: true,
      diagnostics: [{ kind: 'error', eventType: 'attempt_failed' }],
      finalOutcome: 'a Local Core repository question requires a selected repository workspace',
    })).toBe('failed');
  });

  it('marks Completed only when a result event (or explicit outcome) is present', () => {
    expect(deriveTerminalJarvisState({
      lastTurnOutcome: 'completed',
      terminal: true,
      diagnostics: [{ kind: 'result' }],
      finalOutcome: 'Hello!',
    })).toBe('completed');
  });

  it('never infers success from terminal alone', () => {
    expect(deriveTerminalJarvisState({
      lastTurnOutcome: null,
      terminal: true,
      diagnostics: [],
      finalOutcome: null,
    })).toBe('failed');
  });
});

describe('isStopIntent', () => {
  it('treats a bare stop request as Stop, whatever the wording or punctuation', () => {
    for (const text of ['stop', 'Stop!', 'please cancel', 'cancel that', 'stop it now', 'Halt.', 'abort the task', 'stop everything', 'kill it']) {
      expect(isStopIntent(text), text).toBe(true);
    }
  });

  it('does not treat an instruction that merely contains the word as Stop', () => {
    for (const text of ['stop using tabs and use spaces', 'cancel the Friday meeting reminder', 'add a stop button to the page', 'the cancel flow is wrong, fix it', 'what does halt mean']) {
      expect(isStopIntent(text), text).toBe(false);
    }
  });
});
