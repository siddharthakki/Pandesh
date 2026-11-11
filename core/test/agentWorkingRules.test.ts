import { describe, it, expect } from 'vitest';
import { BUILTIN_AGENTS } from '../domain/agents';

/**
 * Specialist briefs (agents.ts workingRules): a working method that ends in a check, a definition of done and a
 * report the delegating agent can relay. They are read by a local model in a 32K window, so they stay short.
 */
describe('built-in agents have short, complete working rules', () => {
  const byId = new Map(BUILTIN_AGENTS.map((a) => [a.id, a]));

  it('the chief and the four specialists the chief can hand work to all have one', () => {
    for (const id of ['chief', 'coding', 'research', 'operations', 'personal']) {
      const rules = byId.get(id)?.workingRules ?? '';
      expect(rules, id).toMatch(/^How you work: /);
      expect(rules.length, id).toBeLessThanOrEqual(700);
    }
  });

  it('each specialist says what done means and what to report back', () => {
    for (const id of ['coding', 'research', 'operations', 'personal']) {
      const rules = byId.get(id)!.workingRules!;
      expect(rules, id).toContain('Done means');
      expect(rules, id).toContain('Report back:');
    }
  });

  it('the Coding agent reproduces, changes as little as needed and verifies before it reports', () => {
    const rules = byId.get('coding')!.workingRules!;
    expect(rules).toMatch(/reproduce it first/);
    expect(rules).toMatch(/smallest change/);
    expect(rules).toMatch(/run the tests or the program and read the output/);
    expect(rules).toMatch(/exit code/);
  });

  it('keeps the Team screen text (instructions) as it was', () => {
    expect(byId.get('coding')!.instructions).toBe('You change code only inside the selected workspace, run its checks, and report exactly which files changed and which checks passed. Never push or install.');
  });
});
