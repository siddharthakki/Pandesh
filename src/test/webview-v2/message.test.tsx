import React from 'react';
import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { Message } from '../../webview-v2/components/Message';
import { MARKDOWN_FIXTURE } from './markdownFixture';

afterEach(cleanup);

describe('Message (assistant, Markdown rendering)', () => {
  it('renders headings, lists, table, and fenced code from the required fixture', () => {
    render(
      <Message
        message={{ id: 'a1', role: 'assistant', content: MARKDOWN_FIXTURE }}
      />,
    );

    expect(screen.getByRole('heading', { name: 'Build Pipeline', level: 2 })).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Main Commands', level: 3 })).toBeTruthy();
    expect(screen.getByText('compile')).toBeTruthy();
    expect(screen.getByText('bundle')).toBeTruthy();

    const table = screen.getByRole('table');
    expect(table).toBeTruthy();
    expect(screen.getByRole('columnheader', { name: 'Command' })).toBeTruthy();
    expect(screen.getByRole('cell', { name: 'Build extension' })).toBeTruthy();

    expect(document.querySelector('pre code')).toBeTruthy();
    expect(document.body.textContent).toContain('npm run compile');
    expect(document.body.textContent).toContain('npm run package');
  });

  it('renders user messages as plain escaped text, not Markdown', () => {
    render(
      <Message
        message={{ id: 'u1', role: 'user', content: '**not bold** <script>x</script>' }}
      />,
    );
    expect(screen.getByText('**not bold** <script>x</script>')).toBeTruthy();
    expect(document.querySelector('script')).toBeNull();
  });

  it('surfaces a per-message error without hiding partial content', () => {
    render(
      <Message
        message={{ id: 'a2', role: 'assistant', content: 'partial', error: 'connection lost' }}
      />,
    );
    expect(screen.getByText('connection lost')).toBeTruthy();
  });
});
