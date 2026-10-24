import { describe, expect, it } from 'vitest';
import { buildSystemPrompt } from '../../prompts/systemPrompt';

describe('buildSystemPrompt repository evidence rules', () => {
  it('requires exact workspace-relative paths in Ask mode', () => {
    const prompt = buildSystemPrompt('C:\\Projects\\Jarvis', 'ask');

    expect(prompt).toContain('exact workspace-relative evidence path');
    expect(prompt).toContain('`package.json`');
    expect(prompt).toContain('Base repository answers only on evidence gathered in this turn');
  });

  it('requires evidence paths for Plan mode', () => {
    const prompt = buildSystemPrompt('/workspace/project', 'plan');

    expect(prompt).toContain('Cite the exact workspace-relative paths supporting the plan.');
  });
});
