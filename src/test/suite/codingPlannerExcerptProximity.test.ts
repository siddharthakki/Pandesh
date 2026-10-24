import { describe, expect, it } from 'vitest';
import { excerptForBudget } from '../../coding/CodingPlanner';

/**
 * Regression for a real defect confirmed live, twice, with two different
 * models (a local model and a real OrcaRouter cloud model): a bare-text
 * grounding term ("runtime_error" in the real canonical task) can occur many
 * times throughout a large file, in code unrelated to the declared symbol
 * the task actually named ("approveDelivery"). The prior anchoring logic
 * always kept a bare-text term's first 3 occurrences from the TOP of the
 * file — for a large file with many earlier, unrelated occurrences, that
 * left the declared symbol's own nearby handling entirely excluded from the
 * excerpt, producing a disconnected view: the symbol's own throw, then a
 * jump straight to an unrelated catch elsewhere. Both real runs, reading
 * exactly that disconnected excerpt, proposed deleting an unrelated stale
 * note instead of fixing the real code.
 */
describe('excerptForBudget prefers bare-text occurrences near a declared-symbol anchor', () => {
  // Many early, unrelated occurrences of "runtime_error" (function A..H),
  // each in its own unrelated block, followed far later by the declared
  // symbol "approveDelivery" and ITS OWN nearby "runtime_error" occurrence —
  // mirrors the real file's shape (a large runtime file with many
  // classification sites, one specific one belonging to approveDelivery).
  function buildContent(): { content: string; declaredLine: number; nearMarker: string } {
    const lines: string[] = [];
    for (let i = 0; i < 8; i++) {
      lines.push(`function unrelatedHandler${i}() {`);
      lines.push('  // a totally different classification site, far from the target function');
      lines.push("  return 'runtime_error';");
      lines.push('}');
      lines.push('');
      // Wide separation — real files put many unrelated call sites of a
      // common term far apart from the one the task actually cares about.
      for (let pad = 0; pad < 20; pad++) lines.push(`// filler ${i}.${pad}`);
    }
    const declaredLine = lines.length + 1; // 1-based line of the declaration below
    lines.push('async function approveDelivery() {');
    lines.push('  // intervening lines specific to this function');
    lines.push("  throw new Error('workspace_delivery_conflict');");
    lines.push('} catch (error) {');
    lines.push("  const NEAR_MARKER_classification = classifyRuntimeError(error); // returns 'runtime_error'");
    lines.push('}');
    for (let i = 0; i < 200; i++) lines.push(`// trailing filler ${i}`);
    return { content: lines.join('\n'), declaredLine, nearMarker: 'NEAR_MARKER_classification' };
  }

  it('includes the runtime_error occurrence next to approveDelivery, not only the earlier unrelated ones', () => {
    const { content, declaredLine, nearMarker } = buildContent();
    const declaredLines = new Map([['approvedelivery', declaredLine]]);
    const cap = 900; // small enough that the file is truncated
    expect(content.length).toBeGreaterThan(cap);

    const excerpt = excerptForBudget(content, cap, ['approveDelivery', 'runtime_error'], declaredLines);
    expect(excerpt).toContain('async function approveDelivery');
    expect(excerpt).toContain('workspace_delivery_conflict');
    expect(excerpt).toContain(nearMarker);
  });

  it('preserves the exact prior behavior (first-3-from-top) when no declared-symbol anchor exists at all', () => {
    const { content } = buildContent();
    const cap = 400;
    const withoutDeclared = excerptForBudget(content, cap, ['runtime_error'], new Map());
    // Only the early, unrelated occurrences are reachable — none of them is
    // the declared-symbol-adjacent one, since there is no declared anchor
    // to prefer proximity to.
    expect(withoutDeclared).toContain('totally different classification site');
    expect(withoutDeclared).not.toContain('async function approveDelivery');
  });
});
