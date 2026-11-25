/**
 * Plain questions that a read-only system tool answers completely, so no model has to be loaded to answer them.
 * Today: "How much free space is left on C: and D:?". The wording check is deliberately narrow: anything that asks for more
 * than the numbers (cleaning up, finding what is large, comparing, explaining) goes to the model as before.
 */

const ASKS_FREE_SPACE = /\b(?:free|left|available|remaining)\b[^.?!]{0,30}\b(?:disk\s+)?(?:space|storage)\b|\b(?:disk|drive|storage)\s+space\b|\bhow\s+much\b[^.?!]{0,20}\b(?:space|storage)\b/i;
// Anything beyond reading the numbers: an action, a search, a reason, a list of files or programs.
const ASKS_MORE = /\b(?:free\s+up|clean(?:\s*up)?|clear|delete|remove|uninstall|move|compress|why|explain|largest|biggest|which|find|list|folders?|files?|programs?|apps?|and\s+(?:then|also)|then|compare|trend|over\s+time|forecast|will\s+it|enough\s+(?:for|to))\b/i;

/** True for a short, single question about how much disk space is free or left. */
export function isDiskSpaceRequest(text: string): boolean {
  const t = text.trim();
  if (!t || t.length > 160 || t.split(/[.?!]\s+\S/).length > 1) return false;
  return ASKS_FREE_SPACE.test(t) && !ASKS_MORE.test(t);
}

/** The drives the question names ("C:", "the D drive", "C and D"), upper-case letters; empty when it names none. */
export function drivesAsked(text: string): string[] {
  const letters = new Set<string>();
  for (const m of text.matchAll(/\b([A-Za-z]):(?![\\/\w])|\b([A-Za-z])\s+drive\b|\bdrive\s+([A-Za-z])\b/gi)) letters.add((m[1] ?? m[2] ?? m[3]).toUpperCase());
  const pair = /\b([A-Za-z])\s*(?:,|and|&)\s*([A-Za-z])\s+drives?\b/i.exec(text);
  if (pair) { letters.add(pair[1].toUpperCase()); letters.add(pair[2].toUpperCase()); }
  return [...letters];
}

interface Disk { DeviceId?: string; TotalGB?: number; FreeGB?: number }

const gb = (n: number) => `${n.toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 1 })} GB`;

/**
 * The answer, written from system_hardware_telemetry's own JSON (Disks: DeviceId, TotalGB, FreeGB). Null when the output has no
 * readable disk list or none of the asked drives exists, so the caller can hand the question to the model instead of guessing.
 */
export function formatDiskSpace(telemetryOutput: string, asked: string[]): string | null {
  let parsed: { Disks?: Disk | Disk[] } | null = null;
  try { parsed = JSON.parse(telemetryOutput); } catch { return null; }
  const raw = parsed?.Disks;
  const disks = (Array.isArray(raw) ? raw : raw ? [raw] : []).filter((d): d is Required<Disk> => typeof d?.DeviceId === 'string' && Number.isFinite(d.FreeGB) && Number.isFinite(d.TotalGB));
  if (!disks.length) return null;
  const want = asked.map((l) => `${l}:`);
  const shown = want.length ? disks.filter((d) => want.includes(d.DeviceId.toUpperCase())) : disks;
  if (!shown.length) return null;
  const missing = want.filter((w) => !disks.some((d) => d.DeviceId.toUpperCase() === w));
  const lines = shown.map((d) => `- **${d.DeviceId}** ${gb(d.FreeGB)} free of ${gb(d.TotalGB)} (${Math.round((d.FreeGB / d.TotalGB) * 100)}% free)`);
  return `Free space on this PC, read just now:\n\n${lines.join('\n')}${missing.length ? `\n\nNo local drive ${missing.join(', ')} was found.` : ''}`;
}
