import { describe, expect, it } from 'vitest';
import * as fs from 'fs/promises';
import * as path from 'path';

describe('chat.html mode selector', () => {
  it('offers a visible top-bar mode selector for all three modes', async () => {
    const html = await fs.readFile(path.join(__dirname, '../../../media/chat.html'), 'utf8');

    const modeButtonsMatch = html.match(/<div id="mode-buttons"[^>]*>/);
    expect(modeButtonsMatch).not.toBeNull();
    expect(modeButtonsMatch![0]).not.toMatch(/\bhidden\b/);

    expect(html).toMatch(/<option value="agent">Saath Kar<\/option>/);
    expect(html).toMatch(/<option value="chat">Baat Kar<\/option>/);
    expect(html).toMatch(/<option value="autonomous">Karke Dikha<\/option>/);
  });

  it('keeps the autonomous composer hidden until autonomous mode is selected', async () => {
    const html = await fs.readFile(path.join(__dirname, '../../../media/chat.html'), 'utf8');
    const composerMatch = html.match(/<section id="autonomous-composer"[^>]*>/);
    expect(composerMatch).not.toBeNull();
    expect(composerMatch![0]).toMatch(/\bhidden\b/);
  });

  it('keeps the chat conversation and composer present in the base markup', async () => {
    const html = await fs.readFile(path.join(__dirname, '../../../media/chat.html'), 'utf8');
    expect(html).toMatch(/id="messages"/);
    expect(html).toMatch(/id="user-input"/);
  });
});

describe('chat-autonomous.js mode switching', () => {
  it('deduplicates polling and reconnect replay by task-scoped event identity', async () => {
    const js = await fs.readFile(path.join(__dirname, '../../../media/chat-autonomous.js'), 'utf8');
    expect(js).toContain('const renderedEventIds = new Set()');
    expect(js).toContain('`${activeTaskId}:${item.eventId ?? item.seq}`');
    expect(js).toContain('if (renderedEventIds.has(identity)) continue');
  });
  it('only reveals the autonomous composer for autonomous mode, and leaves other modes untouched', async () => {
    const js = await fs.readFile(path.join(__dirname, '../../../media/chat-autonomous.js'), 'utf8');
    expect(js).toMatch(/const isAutonomous = mode === 'autonomous';/);
    expect(js).toMatch(/composer\.hidden = !isAutonomous;/);
  });
});
