/**
 * P0 (Build 161 audit): a hand-off must not carry memory the specialist may not read.
 *
 * An ordinary Pandesh turn may recall the user's private facts (user scope) and project facts. Its results were passed
 * verbatim into the delegated specialist's system prompt as "FACTS FROM PANDESH'S OWN TOOLS", so a Research child —
 * whose memory scope is global + task, and which may go online — received the user's home address, bypassing the
 * recall filter added for the Build 160 release blocker. The facts also never counted as private for the child's
 * public-query guard, so a query repeating them was not refused.
 */
import { describe, expect, it } from 'vitest';
import { collectHandoffFacts } from '../runtime/handoffFacts';
import { checkPublicQuery } from '../runtime/publicQueryGuard';

const recall = {
  tool: 'memory_recall',
  status: 'completed',
  text: JSON.stringify({
    entries: [
      { kind: 'durable_fact', memory: { scopeType: 'user', subject: 'home address', displayValue: 'Lindenallee 7 in Bonn' } },
      { kind: 'durable_fact', memory: { scopeType: 'user', subject: 'doctor', displayValue: 'family doctor is Praxis Sonnenhof Doktor Weber' } },
      { kind: 'durable_fact', memory: { scopeType: 'global', subject: 'house style', displayValue: 'answers are short and cite sources' } },
      { kind: 'durable_fact', memory: { scopeType: 'project', subject: 'supplier', displayValue: 'flour supplier Mühle Krause delivers Wednesdays' } },
      { kind: 'durable_fact', memory: { scopeType: 'task', subject: 'task note', displayValue: 'compare three ovens' } },
    ],
    recalledAt: '2026-11-09T20:00:00.000Z',
  }),
};
const telemetry = { tool: 'get_system_info', status: 'completed', text: 'Windows 11 Pro, 64 GB RAM' };

describe('hand-off facts respect the child\'s memory scope', () => {
  it('Research (global + task) receives no user or project facts, but keeps local system facts', () => {
    const facts = collectHandoffFacts([recall, telemetry], ['global', 'task']);
    expect(facts.text).not.toContain('Lindenallee');
    expect(facts.text).not.toContain('Mühle Krause');
    expect(facts.text).toContain('answers are short');
    expect(facts.text).toContain('compare three ovens');
    expect(facts.text).toContain('Windows 11 Pro');
  });

  it('Personal (user + task) receives the user fact but not project or global facts', () => {
    const facts = collectHandoffFacts([recall], ['user', 'task']);
    expect(facts.text).toContain('Lindenallee');
    expect(facts.text).not.toContain('Mühle Krause');
    expect(facts.text).not.toContain('answers are short');
  });

  it('a child with no readable memory receives no recalled memory at all; an unreadable recall result is dropped', () => {
    expect(collectHandoffFacts([recall], []).text).toBe('');
    expect(collectHandoffFacts([{ tool: 'memory_recall', status: 'completed', text: 'not json: Lindenallee 7' }], ['global']).text).toBe('');
  });

  it('memory handed to a child counts as private for its public web query guard', () => {
    const facts = collectHandoffFacts([recall], ['user', 'task']);
    // No identifier pattern matches this query: only the handed-over private text can refuse it.
    expect(checkPublicQuery('Praxis Sonnenhof Doktor Weber reviews').ok).toBe(true);
    const leaked = checkPublicQuery('Praxis Sonnenhof Doktor Weber reviews', { privateTexts: facts.privateTexts });
    expect(leaked.ok).toBe(false);
    // An unrelated public query is still allowed (the guard is not made unusable).
    expect(checkPublicQuery('convection oven energy use comparison', { privateTexts: facts.privateTexts }).ok).toBe(true);
  });
});
