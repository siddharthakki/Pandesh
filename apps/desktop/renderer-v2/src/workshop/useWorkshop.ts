/**
 * The Workshop's place in a conversation: which workshop and version the window shows, in the side panel or the
 * full window. Remembered per conversation (localStorage in the window's own profile), so it reopens after a
 * restart, and told to Core (focusWorkshop), so "make it blue" in chat means the thing on screen.
 *
 * Core's view commands arrive here first. One for another conversation is refused with the reason; open, close and
 * full-window are carried out here; everything else waits in a queue until the right version is on screen, where
 * the viewer itself carries it out and answers.
 */
import { useEffect, useRef, useState } from 'react';
import { api, onDesktopEvent, type WorkshopCommandEvent, type WorkshopSummary } from '../bridge';
import type { WorkshopUi } from './viewerTypes';

const key = (conversationId: string) => `pandesh.v2.workshop.${conversationId}`;

function readUi(conversationId: string | null): WorkshopUi | null {
  if (!conversationId) return null;
  try {
    const raw = JSON.parse(localStorage.getItem(key(conversationId)) ?? 'null') as (WorkshopUi & { open?: boolean }) | null;
    if (!raw || raw.open === false || typeof raw.workshopId !== 'string') return null;
    return { workshopId: raw.workshopId, artifactId: typeof raw.artifactId === 'string' ? raw.artifactId : null, mode: raw.mode === 'full' ? 'full' : 'side' };
  } catch { return null; }
}

function writeUi(conversationId: string | null, ui: WorkshopUi | null): void {
  if (!conversationId) return;
  try { localStorage.setItem(key(conversationId), JSON.stringify(ui ? { ...ui, open: true } : { open: false })); } catch { /* still works this session */ }
}

export interface WorkshopProgress { workshopId: string | null; stage: string; index?: number; total?: number; at: string }

/** Core waits at most this long for an answer, so an older command is history, not a request. */
const COMMAND_FRESH_MS = 45_000;
/** Chats on screen that take Workshop commands (0 while the window shows another view). */
let mounted = 0;
/** Commands that arrived while no chat was on screen; the chat takes them when it mounts. */
const waiting: Array<WorkshopCommandEvent & { receivedAt: number }> = [];
let intake = false;

/**
 * Called once by App: keeps Workshop commands that arrive while the window shows another view (Board, a space…),
 * and tells App to bring the chat back, so "open it" works wherever the person is, as navigate_to does.
 */
export function startWorkshopIntake(onNeedsChat: () => void): () => void {
  if (intake) return () => undefined;
  intake = true;
  const off = onDesktopEvent((e) => {
    if (e.kind !== 'workshop_command' || !e.workshopCommand || mounted > 0) return;
    waiting.push({ ...e.workshopCommand, receivedAt: Date.now() });
    if (waiting.length > 20) waiting.shift();
    onNeedsChat();
  });
  return () => { intake = false; off(); };
}

export function useWorkshop(conversationId: string | null, coreReady = true) {
  const [ui, setUi] = useState<WorkshopUi | null>(() => readUi(conversationId));
  const [list, setList] = useState<WorkshopSummary[]>([]);
  const [queue, setQueue] = useState<WorkshopCommandEvent[]>([]);
  const [progress, setProgress] = useState<WorkshopProgress | null>(null);
  const conv = useRef(conversationId);
  conv.current = conversationId;

  const refresh = async (): Promise<WorkshopSummary[]> => {
    const id = conv.current;
    if (!id) { setList([]); return []; }
    try {
      const next = await api.listWorkshops(id);
      if (conv.current === id) setList(next);
      return next;
    } catch { return []; }
  };

  // Another conversation: its own remembered Workshop.
  useEffect(() => { setUi(readUi(conversationId)); setQueue([]); setProgress(null); void refresh(); }, [conversationId]);
  // After a restart the chat is on screen before Core has connected: read the workshops again once it has.
  useEffect(() => { if (coreReady) void refresh(); }, [coreReady]);

  // Remember it, and tell Core what is on screen.
  useEffect(() => {
    writeUi(conversationId, ui);
    if (conversationId) void api.focusWorkshop(conversationId, ui?.workshopId ?? null, ui?.artifactId ?? null, Boolean(ui)).catch(() => undefined);
  }, [conversationId, ui?.workshopId, ui?.artifactId, ui?.mode, Boolean(ui)]);

  const confirm = (cmd: WorkshopCommandEvent, ok: boolean, detail: string, state?: Record<string, unknown>) =>
    void api.confirmWorkshopCommand(cmd.id, ok, detail, state).catch(() => undefined);

  const handle = (cmd: WorkshopCommandEvent) => {
    if (!conv.current) { confirm(cmd, false, 'no conversation is open in the Pandesh window'); return; }
    if (cmd.conversationId && cmd.conversationId !== conv.current) { confirm(cmd, false, 'the Pandesh window is showing a different conversation'); return; }
    if (cmd.action === 'close') { setUi(null); confirm(cmd, true, 'the Workshop panel is closed'); return; }
    if (cmd.action === 'fullscreen' || cmd.action === 'exit_fullscreen') {
      const mode = cmd.action === 'fullscreen' ? 'full' : 'side';
      setUi((cur) => ({ workshopId: cur?.workshopId ?? cmd.workshopId, artifactId: cur?.workshopId === cmd.workshopId ? cur.artifactId : cmd.artifactId, mode }));
      // Confirmed from what the window then shows, not from the request.
      setTimeout(() => {
        const shown = document.querySelector('.ws-panel')?.getAttribute('data-mode');
        confirm(cmd, shown === mode, shown === mode ? (mode === 'full' ? 'the Workshop fills the window' : 'the Workshop is back beside the chat') : 'the window did not switch');
      }, 120);
      return;
    }
    const pinsVersion = cmd.action === 'open' || cmd.action === 'show_version' || cmd.action === 'compare';
    setUi((cur) => ({
      workshopId: cmd.workshopId,
      artifactId: pinsVersion ? cmd.artifactId : cur?.workshopId === cmd.workshopId ? cur.artifactId : null,
      mode: cur?.mode ?? 'side',
    }));
    setQueue((q) => [...q, cmd]);
    void refresh();
  };

  useEffect(() => {
    // Commands that arrived while the window showed another view (App switched back to the chat for them).
    mounted += 1;
    for (const cmd of waiting.splice(0)) if (Date.now() - cmd.receivedAt < COMMAND_FRESH_MS) handle(cmd);
    const off = onDesktopEvent((e) => {
      if (e.kind === 'workshop_changed' && (!e.conversationId || e.conversationId === conv.current)) void refresh();
      if (e.kind === 'workshop_progress' && e.workshop) setProgress({ workshopId: e.workshop.workshopId, stage: e.workshop.stage ?? e.summary, index: e.workshop.index, total: e.workshop.total, at: e.at });
      if (e.kind === 'workshop_command' && e.workshopCommand) handle(e.workshopCommand);
    });
    return () => { mounted -= 1; off(); };
  }, []);

  const take = (id: string) => setQueue((q) => q.filter((c) => c.id !== id));

  return { ui, setUi, list, refresh, queue, take, progress, confirm };
}

export type WorkshopState = ReturnType<typeof useWorkshop>;
