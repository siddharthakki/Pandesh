/**
 * Removes a model's raw reasoning/channel markers from text before it is streamed or stored.
 *
 * Some local models write their hidden reasoning inline: `<|channel>thought ... <channel|>` (Gemma family) or
 * `<think> ... </think>`. Both the block and the markers are dropped; the remaining answer is kept. The filter is
 * stateful so a marker split across streamed chunks is still caught, and text that merely looks like the start of
 * a marker is held back until the next chunk decides.
 */

const HIDDEN_STARTS = ['<think>', '<thinking>'];
const HIDDEN_ENDS = ['<channel|>', '</think>', '</thinking>'];
/** Markers removed on their own, without hiding anything after them. */
const STRAY = ['<|channel>', '<channel|>', '<|turn>', '<turn|>', '<|think|>', '</think>', '</thinking>'];
const CHANNEL_OPEN = '<|channel>';
const THOUGHT = 'thought';
const ALL_MARKERS = [...HIDDEN_STARTS, ...STRAY];
const LONGEST = Math.max(...ALL_MARKERS.map((m) => m.length)) + THOUGHT.length;

function earliest(text: string, markers: string[]): { index: number; marker: string } | null {
  let best: { index: number; marker: string } | null = null;
  for (const marker of markers) {
    const index = text.indexOf(marker);
    if (index >= 0 && (!best || index < best.index || (index === best.index && marker.length > best.marker.length))) best = { index, marker };
  }
  return best;
}

/** Length of the longest suffix of `text` that is a proper prefix of a marker (and so might still complete). */
function pendingTail(text: string): number {
  const max = Math.min(text.length, LONGEST);
  for (let n = max; n > 0; n -= 1) {
    const tail = text.slice(text.length - n);
    if (ALL_MARKERS.some((m) => m.length > n && m.startsWith(tail))) return n;
  }
  return 0;
}

export interface ReasoningFilter {
  push(delta: string): string;
  flush(): string;
}

/**
 * Some runtimes drop the opening `<|channel>` token but keep the rest, so a reply starts with "thought", a newline, the reasoning, then `<channel|>`.
 * Only a reply that begins exactly that way is treated as reasoning, and only once the closing marker is seen.
 */
const LEAD = 'thought\n';

export function createReasoningFilter(): ReasoningFilter {
  let buffer = '';
  let hidden = false;
  let lead: 'unknown' | 'holding' | 'done' = 'unknown';
  const drain = (final: boolean): string => {
    if (lead === 'unknown') {
      if (buffer.length < LEAD.length && LEAD.startsWith(buffer) && !final) return '';
      lead = buffer.startsWith(LEAD) ? 'holding' : 'done';
    }
    if (lead === 'holding') {
      const end = buffer.indexOf('<channel|>');
      if (end < 0) {
        if (!final) return '';
        lead = 'done';
      } else {
        buffer = buffer.slice(end + '<channel|>'.length);
        lead = 'done';
      }
    }
    let out = '';
    for (;;) {
      if (hidden) {
        const end = earliest(buffer, HIDDEN_ENDS);
        if (end) { buffer = buffer.slice(end.index + end.marker.length); hidden = false; continue; }
        buffer = final ? '' : buffer.slice(Math.max(0, buffer.length - LONGEST));
        return out;
      }
      const start = earliest(buffer, [...HIDDEN_STARTS, ...STRAY]);
      if (!start) {
        const hold = final ? 0 : pendingTail(buffer);
        out += buffer.slice(0, buffer.length - hold);
        buffer = buffer.slice(buffer.length - hold);
        return out;
      }
      out += buffer.slice(0, start.index);
      const after = buffer.slice(start.index + start.marker.length);
      if (start.marker === CHANNEL_OPEN) {
        // `<|channel>thought` opens a hidden block; any other channel name is only stripped.
        if (!final && after.length < THOUGHT.length && THOUGHT.startsWith(after)) { buffer = buffer.slice(start.index); return out; }
        buffer = after;
        if (after.startsWith(THOUGHT)) { buffer = after.slice(THOUGHT.length); hidden = true; }
        continue;
      }
      buffer = after;
      if (HIDDEN_STARTS.includes(start.marker)) hidden = true;
    }
  };
  return {
    push(delta: string): string { buffer += delta; return drain(false); },
    flush(): string { const rest = drain(true); buffer = ''; hidden = false; lead = 'unknown'; return rest; },
  };
}

/** One-shot form for text that is already complete. */
export function stripReasoningMarkers(text: string): string {
  const filter = createReasoningFilter();
  return filter.push(text) + filter.flush();
}
