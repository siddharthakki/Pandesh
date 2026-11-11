/**
 * Micro-tests DEV-018 and RES-025 (Build 163): the weather shortcut answered "Which location?" to a question about a
 * room temperature sensor, and answered only the weather half of "Check my free disk space and also look up today's
 * weather in Ulm", silently dropping the disk part. Such messages now go to Core; plain weather questions still use
 * the shortcut.
 */
import { describe, expect, it } from 'vitest';
import { detectWeatherIntent } from '../src/host/desktopInteractionRouting';

describe('weather shortcut routing (micro-tests)', () => {
  it.each([
    "What's my test room temperature sensor reading?",
    'What is the CPU temperature right now?',
    'Show the GPU temperature.',
    'What temperature should the oven be for bread?',
    "Check my free disk space and also look up today's weather in Ulm.",
    'Find a museum open on Monday and tell me the weather in Ulm.',
  ])('goes to Core: %s', (text) => {
    expect(detectWeatherIntent(text)).toBe(false);
  });

  it.each([
    "what's the weather in Ulm?",
    'What is the temperature in Neu-Ulm this afternoon?',
    "What's the weather in Ulm right now?",
    'Will it rain in Ulm tomorrow?',
    'what is the weather like today',
    'Compare the weather in Ulm and Munich.',
  ])('still uses the weather shortcut: %s', (text) => {
    expect(detectWeatherIntent(text)).toBe(true);
  });
});
