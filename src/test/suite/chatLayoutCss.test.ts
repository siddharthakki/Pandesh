import { readFileSync } from 'fs';
import { resolve } from 'path';
import { describe, expect, it } from 'vitest';

describe('chat layout scrollbar ownership', () => {
  it('keeps the chat message list as the only automatic vertical scroller', () => {
    const css = readFileSync(resolve(process.cwd(), 'media/chat-layout-fixes.css'), 'utf8');

    expect(css).toContain('.chat-window {');
    expect(css).toContain('overflow: hidden;');
    expect(css).toContain('overflow-y: auto;');
    expect(css).not.toContain('overflow-y: scroll;');
    expect(css).not.toContain('scrollbar-gutter: stable;');
    expect(css).toContain('overflow-anchor: none;');
    expect(css).not.toMatch(/\.autonomous-timeline \{[^}]*overflow-y:\s*auto/);
  });

  it('preserves each timeline entry height so approval controls contribute to the scroll range', () => {
    const css = readFileSync(resolve(process.cwd(), 'media/chat-layout-fixes.css'), 'utf8');

    expect(css).toMatch(/\.chat-messages > \*,\s*#messages > \* \{\s*flex-shrink: 0;/);
  });
});
