/**
 * D15 / re-run F1: retrying a failed turn in the same conversation ended with an empty reply at ~26K prompt tokens,
 * while the same request in a new conversation answered. Core's own "no answer" notice sat in the history the model
 * saw, and the full context was ~26K tokens; Core now drops those notices from history and, when the model still
 * returns nothing after real tool results, answers from those results alone with one small tool-free call.
 */
import { describe, expect, it } from 'vitest';
import { buildToolEvidenceSynthesisPrompt, isUnansweredTurnNotice } from '../runtime/piAgentEngine';

describe('D15: Core notices are not conversation history', () => {
  it('recognises every notice describeUnansweredTurn writes (re-run F1 text)', () => {
    expect(isUnansweredTurnNotice('10 steps ran, but I did not write a final answer. Nothing is confirmed as done — the steps are listed under Details. Ask me to continue and I will pick up from there.\n\nCorrection: Lost the connection to the local model server (Ollama) before a reply was generated: read ECONNRESET.')).toBe(true);
    expect(isUnansweredTurnNotice('1 step ran, but I did not write a final answer.')).toBe(true);
    expect(isUnansweredTurnNotice('I finished this turn without producing a reply. Nothing is confirmed as done — please ask again.')).toBe(true);
  });

  it('keeps real answers', () => {
    expect(isUnansweredTurnNotice('Here are the effective dates for the files in the m12_documents folder:')).toBe(false);
    expect(isUnansweredTurnNotice('I ran 3 steps and found two invoices.')).toBe(false);
  });
});

describe('D15: tool-evidence synthesis prompt', () => {
  it('carries the request and every result, bounded', () => {
    const reads = Array.from({ length: 8 }, (_, i) => ({ tool: 'read_file', text: `policy_v${i + 1}.txt\nEffective date: 01.0${(i % 9) + 1}.2025\n${'x'.repeat(3_000)}` }));
    const prompt = buildToolEvidenceSynthesisPrompt('List the effective date in each file.', reads);
    expect(prompt).toContain('List the effective date in each file.');
    for (let i = 1; i <= 8; i += 1) expect(prompt).toContain(`policy_v${i}.txt`);
    expect(prompt.length).toBeLessThan(60_000);
  });

  it('truncates one huge result instead of dropping the others', () => {
    const prompt = buildToolEvidenceSynthesisPrompt('q', [{ tool: 'read_file', text: 'A'.repeat(50_000) }, { tool: 'read_file', text: 'second result' }]);
    expect(prompt).toContain('[…truncated]');
    expect(prompt).toContain('second result');
  });
});
