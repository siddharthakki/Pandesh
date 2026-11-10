/** @vitest-environment jsdom */
import { describe, expect, it } from 'vitest';
import { plainArrows } from '../renderer-v2/src/markdown';

describe('v2 Markdown', () => {
  // Seen in the live v2 test (2026-11-10): gemma4:12b wrote "System $\rightarrow$ Connections", shown raw.
  it('shows LaTeX arrows from local models as arrows', () => {
    expect(plainArrows('go to **System** $\\rightarrow$ **Connections**')).toBe('go to **System** → **Connections**');
    expect(plainArrows('A $\\to$ B $ \\Rightarrow $ C')).toBe('A → B ⇒ C');
    expect(plainArrows('costs $5 and $10')).toBe('costs $5 and $10');
  });
});
