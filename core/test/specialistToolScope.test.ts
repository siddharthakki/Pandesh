import { describe, expect, it } from 'vitest';
import { isPublicResearchTask, isUnknownToolResult, UNKNOWN_TOOL_STREAK_LIMIT } from '../runtime/piAgentEngine';
import { referencesLocalContent } from '../runtime/publicQueryGuard';

// Live demo 2026-11-09: "Ask the Coding specialist to run the unit tests in the price-tool folder … fix the bug in
// pricing.py" matched the product-price rule ("price" + "find"), so the Coding child was scoped to web_research only —
// which its agent scope does not include — and ran 519 model calls with zero tools; the parent then proposed a web search
// with the prompt itself as the query.
const DEMO = 'Ask the Coding specialist to run the unit tests in the price-tool folder, find out why they fail, fix the bug in pricing.py, and re-run the tests until they pass. Show me the real test output before and after.';

describe('local coding work is never scoped to public web research', () => {
  it('treats source files and named folders as local content', () => {
    expect(referencesLocalContent(DEMO)).toBe(true);
    expect(referencesLocalContent('Refactor app.ts so the tests pass')).toBe(true);
    expect(referencesLocalContent('Run the build inside the website repo')).toBe(true);
  });

  it('still lets genuine public price research through', () => {
    const shopping = 'Find the cheapest price for a 24 GB RTX 3090 in Germany';
    expect(isPublicResearchTask(shopping)).toBe(true);
    expect(referencesLocalContent(shopping)).toBe(false);
  });
});

describe('unknown-tool loop guard', () => {
  it('recognises pi-agent-core results for tools that are not offered', () => {
    expect(isUnknownToolResult('Tool run_checks not found')).toBe(true);
    expect(isUnknownToolResult('NOT DONE: run_checks failed (exit 1)')).toBe(false);
    expect(UNKNOWN_TOOL_STREAK_LIMIT).toBeGreaterThanOrEqual(3);
    expect(UNKNOWN_TOOL_STREAK_LIMIT).toBeLessThanOrEqual(10);
  });
});
