import { describe, expect, it } from 'vitest';
import { detectWeatherIntent } from '../src/host/desktopInteractionRouting';

describe('weather shortcut does not swallow other work (real-world challenge)', () => {
  it.each([
    'Set up a new project called Garden Shed Plan with three tasks: buy timber, check the weather forecast, build the frame. All three are pending for now. Show me what was saved.',
    'Create a checklist for the camping trip: tent, rain jacket, stove.',
    'Build a small dashboard that shows the temperature of my GPU and free disk space.',
    'Write a report about how rain affected last month\'s sales figures in my folder.',
  ])('goes to Core: %s', (text) => {
    expect(detectWeatherIntent(text)).toBe(false);
  });

  it.each([
    "What's the weather in Ulm today?",
    'Will it rain tomorrow in Berlin?',
    'weather forecast for Munich',
    'Create a packing list and tell me the weather in Rome tomorrow.',
  ])('still a weather question: %s', (text) => {
    expect(detectWeatherIntent(text)).toBe(true);
  });
});
