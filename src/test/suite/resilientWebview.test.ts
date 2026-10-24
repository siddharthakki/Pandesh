import { describe, expect, it } from 'vitest';
import { renderWebviewStatus } from '../../ui/ResilientWebviewViewProvider';

describe('renderWebviewStatus', () => {
  it('renders an actionable status page', () => {
    const html = renderWebviewStatus('Ollama Agent failed', 'Open the Extension Host log.');

    expect(html).toContain('Ollama Agent failed');
    expect(html).toContain('Open the Extension Host log.');
    expect(html).toContain('<!DOCTYPE html>');
  });

  it('escapes runtime error text before inserting it into HTML', () => {
    const html = renderWebviewStatus('<script>alert(1)</script>', 'bad & worse');

    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(html).toContain('bad &amp; worse');
  });
});
