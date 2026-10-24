import { readFileSync } from 'fs';
import { resolve } from 'path';
import { describe, expect, it } from 'vitest';

function read(path: string): string {
  return readFileSync(resolve(process.cwd(), path), 'utf8');
}

describe('governed neon release contracts', () => {
  it('keeps the idle panda and the governed execution states visible', () => {
    const css = read('media/chat-layout-fixes.css');
    const html = read('media/chat.html');

    expect(html).toContain('id="ambient-placeholder"');
    expect(html).toContain('id="everyday-welcome-panda"');
    expect(html).toContain('id="autonomous-stage-tracker"');

    expect(css).toContain("url('./panda/mascot-idle.webp')");
    expect(css).toContain('data-kd-work-state="investigating"');
    expect(css).toContain('data-kd-work-state="waiting"');
    expect(css).toContain('data-kd-work-state="checking"');
    expect(css).toContain('data-kd-work-state="blocked"');
    expect(css).toContain('data-kd-work-state="completed"');
    expect(css).toContain("url('./panda/action-approval.webp')");
    expect(css).toContain("url('./panda/action-reviewing.webp')");
    expect(css).toContain("url('./panda/action-blocked.webp')");
    expect(css).toContain("url('./panda/action-completed.webp')");
    expect(css).toContain('✓ Ready to apply');
  });

  it('renders a real Saath Kar panda panel with a six-stage Kaam ka Dhaaga tracker', () => {
    const js = read('media/chat-dhaaga.js');
    const css = read('media/chat-dhaaga.css');

    expect(js).toContain('Kaam ka Dhaaga');
    expect(js).toContain('kd-dhaaga');
    expect(css).toContain('.kd-dhaaga');
    expect(css).toContain('Kaam ka Dhaaga');
  });

  it('treats approval as pending only while a live decision control exists', () => {
    const css = read('media/chat-layout-fixes.css');

    expect(css).toContain('.approval-card:has(button:not(:disabled))');
    expect(css).not.toContain('.approval-card:not(.resolved)');
  });

  it('makes code-only answers explicit about not creating or previewing a file', () => {
    const css = read('media/chat-layout-fixes.css');

    expect(css).toContain('CODE SUGGESTION · No file created or preview generated');
    expect(css).toMatch(/#messages:not\(:has\(\.tool-card, \.approval-card\)\)[\s\S]*\.bubble\.assistant:has\(pre\)::before/);
  });

  it('preserves affirmative continuity without granting fresh autonomous authority', () => {
    const js = read('media/chat-dashboard.js');

    expect(js).toContain('function isAffirmativeFollowUp');
    expect(js).toContain("desired === 'autonomous'");
    expect(js).toContain("desired = 'agent'");
    expect(js).toContain('hasPriorAssistantContext()');
    expect(js).toContain('window.__kdActiveTaskSteering?.isActive?.()');
  });

  it('routes likely artifact-build requests through governed work while respecting explicit Baat Kar', () => {
    const js = read('media/chat-dashboard.js');

    expect(js).toContain('function looksLikeArtifactBuild');
    expect(js).toContain("editDistance(token, 'build') <= 2");
    expect(js).toContain('.mode-button[data-mode="chat"].active');
    expect(js).toContain('.compact-mode-option[data-mode="chat"].active');
    expect(js).toContain("forceModeForOneSubmission('agent')");
  });

  it('drives Saath Kar visual state from truthful runtime events', () => {
    const js = read('media/chat-dashboard.js');

    expect(js).toContain('function setWorkState');
    expect(js).toContain('function isValidationTool');
    expect(js).toContain('function isReadOnlyTool');
    expect(js).toContain("setWorkState(isValidationTool(message.toolName) ? 'checking'");
    expect(js).toContain("setWorkState('waiting')");
    expect(js).toContain("setWorkState('completed')");
    expect(js).toContain("setWorkState('blocked')");
    expect(js).toContain("setWorkState('stopped')");
    expect(js).toContain('.approval-card button:not(:disabled)');
  });
});
