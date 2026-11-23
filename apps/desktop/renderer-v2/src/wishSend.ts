/**
 * Sending a wish: one real chat message in a NEW conversation (never appended to whatever chat was open), then
 * remembered here so Wish to Reality can follow it. Core decides what to do with it under the normal permission engine.
 * The list is a per-window convenience: the wish itself lives in Core as its conversation, mission or task.
 */
import { api } from './bridge';
import type { TrackedWish } from './journeyModel';

const KEY = 'pandesh.wishes.v1';
export function readTracked(): TrackedWish[] {
  try { const v = JSON.parse(localStorage.getItem(KEY) ?? '[]'); return Array.isArray(v) ? v : []; } catch { return []; }
}
function writeTracked(v: TrackedWish[]): void {
  try { localStorage.setItem(KEY, JSON.stringify(v.slice(0, 50))); } catch { /* the wish still exists as its chat and mission */ }
}

export async function sendWish(text: string): Promise<TrackedWish> {
  const t = text.trim();
  if (!t) throw new Error('Say what you want first.');
  await api.newConversation();
  await api.submitTask(t);
  const s = await api.getSnapshot();
  const conversationId = s?.selectedConversationId ?? s?.activeConversationId ?? null;
  if (!conversationId) throw new Error('Sent, but Core has not reported its conversation yet; it is in Chat.');
  const wish = { conversationId, text: t, at: new Date().toISOString() };
  writeTracked([wish, ...readTracked().filter((w) => w.conversationId !== conversationId)]);
  return wish;
}
