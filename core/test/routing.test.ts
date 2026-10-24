import { describe, it, expect } from 'vitest';
import { classifyRequest } from '../domain/routing';
import { NON_WORKSPACE_MARKERS } from '../domain/taskToolSurface';

describe('Auto-mode router: classifies current request text only', () => {
  it('routes an ordinary question to Baat Kar', () => {
    const decision = classifyRequest('What is the difference between TCP and UDP?');
    expect(decision.resolvedMode).toBe('baat_kar');
    expect(decision.planningOnly).toBe(false);
  });

  it('does not classify reading or reminding about appointments as a mutation', () => {
    for (const text of ["What's my next appointment?", 'Remind me at 8 to call home', 'Show my calendar for tomorrow']) {
      const decision = classifyRequest(text);
      expect(decision.resolvedMode, text).toBe('baat_kar');
      expect(decision.planningOnly).toBe(false);
    }
  });

  it('keeps tools required for reminder/calendar wording but not for plain chat', () => {
    const needsTools = (text: string) => NON_WORKSPACE_MARKERS.some(([, pattern]) => pattern.test(text));
    expect(needsTools('Remind me at 8 to call home')).toBe(true);
    expect(needsTools("What's my next appointment?")).toBe(true);
    expect(needsTools('What is the difference between TCP and UDP?')).toBe(false);
  });

  it('keeps tools required for diagnostics and read-only file requests', () => {
    const needsTools = (text: string) => NON_WORKSPACE_MARKERS.some(([, pattern]) => pattern.test(text));
    expect(needsTools('Run diagnostics on this PC')).toBe(true);
    expect(needsTools('Diagnose my computer')).toBe(true);
    expect(needsTools('Check my setup')).toBe(true);
    expect(needsTools('What is my system health?')).toBe(true);
    expect(needsTools('Read the README.md file')).toBe(true);
    expect(needsTools('Show me the log file')).toBe(true);
  });

  it('keeps tools required for model runtime and weather requests', () => {
    const needsTools = (text: string) => NON_WORKSPACE_MARKERS.some(([, pattern]) => pattern.test(text));
    expect(needsTools('Which local model is running?')).toBe(true);
    expect(needsTools('Which models are available?')).toBe(true);
    expect(needsTools('What models do I have in Ollama?')).toBe(true);
    expect(needsTools('Run ollama list')).toBe(true);
    expect(needsTools('Query the local model provider')).toBe(true);
    expect(needsTools('What is the weather in Paris?')).toBe(true);
  });

  it('routes a bounded repository-inspection request to Saath Kar', () => {
    const decision = classifyRequest('Can you review the file src/index.ts and explain what it does?');
    expect(decision.resolvedMode).toBe('saath_kar');
  });

  it('routes a planning/design request to Saath Kar', () => {
    const decision = classifyRequest('Can you draft a plan for the new authentication architecture?');
    expect(decision.resolvedMode).toBe('saath_kar');
  });

  it('routes a bounded mutation request to Karke Dikha', () => {
    const decision = classifyRequest('Please fix the bug in the login handler and update the tests.');
    expect(decision.resolvedMode).toBe('karke_dikha');
    expect(decision.planningOnly).toBe(false);
  });

  it('routes a broad multi-scope goal to Karke Dikha', () => {
    const decision = classifyRequest(
      'Build an end-to-end production-ready platform integrating the backend API, frontend UI, database migration, authentication, authorization, CI, deployment, monitoring, and mobile support.',
    );
    expect(decision.resolvedMode).toBe('karke_dikha');
  });

  it('a broad goal with no workspace becomes planning-only, not a doomed git attempt', () => {
    const decision = classifyRequest('Please implement and fix the authentication and add tests.', { hasWorkspace: false, gitCapable: false });
    expect(decision.resolvedMode).toBe('karke_dikha');
    expect(decision.planningOnly).toBe(true);
  });

  it('regression (audit F5): a workspace with no git capability is still planning-only, not treated as executable', () => {
    const decision = classifyRequest('Please fix the bug in the login handler and update the tests.', {
      hasWorkspace: true,
      gitCapable: false,
    });
    expect(decision.resolvedMode).toBe('karke_dikha');
    expect(decision.planningOnly).toBe(true);
  });

  it('is deterministic: same input always produces the same route', () => {
    const text = 'Please add a dark mode toggle to settings.';
    const a = classifyRequest(text);
    const b = classifyRequest(text);
    expect(a).toEqual(b);
  });

  it('regression: unrelated prior chat text influences nothing because it is never passed in', () => {
    // The router's signature only accepts the current message — there is no
    // parameter through which a caller could pass prior transcript text even by
    // accident. A negated instruction elsewhere in the SAME message is still
    // correctly excluded from mutation intent.
    const decision = classifyRequest("No thank you. Don't create or modify any files.");
    expect(decision.resolvedMode).toBe('baat_kar');
  });

  it('negated mutation verbs do not trigger Karke Dikha routing', () => {
    const decision = classifyRequest('Please do not delete or modify the config file, just tell me what it does.');
    expect(decision.resolvedMode).not.toBe('karke_dikha');
  });
});
