/**
 * Renaming or moving one file inside the selected folder.
 *
 * Everyday tasks, 2026-11-24: "Rename draft.txt to final.txt" had no tool. The model wrote a new final.txt holding
 * "[dummy content for renaming]", tried to blank draft.txt, and then said it could not rename, without mentioning the
 * file it had left behind. A rename is its own operation: the bytes are never rewritten, nothing is ever overwritten,
 * and the result is checked on disk before anything is reported.
 */
import * as fs from 'fs';
import * as path from 'path';

export type FileMovePlan =
  | { ok: true; from: string; to: string; relFrom: string; relTo: string; kind: 'rename' | 'move'; createsFolder: boolean; caseOnly: boolean }
  | { ok: false; reason: string; text: string };

const RESERVED_WINDOWS_NAME = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i;

function inside(root: string, target: string): string | null {
  const rel = path.relative(root, target);
  return rel && !rel.startsWith('..') && !path.isAbsolute(rel) ? rel.replace(/\\/g, '/') : null;
}

function clean(value: unknown): string {
  return String(value ?? '').trim().replace(/^["'`]|["'`]$/g, '');
}

/** Where the file would go, or why it must not. Reads the disk, changes nothing. */
export function planFileMove(input: { from: unknown; to: unknown; workspaceRoot: string | null }): FileMovePlan {
  const no = (reason: string, detail: string): FileMovePlan => ({ ok: false, reason, text: `NOT MOVED: ${detail} Nothing was changed.` });
  const fromRaw = clean(input.from);
  const toRaw = clean(input.to);
  if (!fromRaw || !toRaw) return no('missing argument', 'move_file needs the file (from) and its new name or place (to).');
  if (!input.workspaceRoot) return no('no folder selected', 'no folder is selected for this conversation, so there is no file Pandesh may rename or move.');
  const root = path.resolve(input.workspaceRoot);
  const from = path.resolve(root, fromRaw);
  const relFrom = inside(root, from);
  if (!relFrom) return no('source outside the selected folder', `${fromRaw} is outside the selected folder ${root}.`);
  let stat: fs.Stats;
  try { stat = fs.lstatSync(from); } catch { return no('source does not exist', `${relFrom} does not exist in ${root}. Use list_directory to see the real file names.`); }
  if (stat.isSymbolicLink()) return no('source is a link', `${relFrom} is a link, not a file.`);
  if (stat.isDirectory()) return no('source is a folder', `${relFrom} is a folder. move_file renames or moves one file; Pandesh has no tool that renames or moves a folder.`);
  if (!stat.isFile()) return no('source is not a regular file', `${relFrom} is not a regular file.`);

  // A bare name ("final.txt") is a new name next to the file; anything with a folder in it is a place in the selected folder.
  const bareName = !path.isAbsolute(toRaw) && !/[\\/]/.test(toRaw);
  let to = bareName ? path.join(path.dirname(from), toRaw) : path.resolve(root, toRaw);
  let toIsFolder = /[\\/]$/.test(toRaw);
  try { if (fs.statSync(to).isDirectory()) toIsFolder = true; } catch { /* not there yet */ }
  if (toIsFolder) to = path.join(to, path.basename(from));
  const relTo = inside(root, to);
  if (!relTo) return no('destination outside the selected folder', `${toRaw} is outside the selected folder ${root}. Pandesh only renames or moves files inside it.`);
  const name = path.basename(to);
  if (/[<>:"|?*\u0000-\u001f]/.test(name) || /[. ]$/.test(name) || RESERVED_WINDOWS_NAME.test(name)) return no('invalid file name', `"${name}" is not a valid file name on this PC.`);

  const sameSpelling = from === to;
  const caseOnly = !sameSpelling && process.platform === 'win32' && from.toLowerCase() === to.toLowerCase();
  if (sameSpelling) return no('already has this name', `${relFrom} already has this name and place.`);
  if (!caseOnly && fs.existsSync(to)) return no('destination exists', `${relTo} already exists, and move_file never overwrites a file. Ask the user what to do with the existing ${name}.`);

  const parent = path.dirname(to);
  let createsFolder = false;
  try { if (!fs.statSync(parent).isDirectory()) return no('destination folder is a file', `${inside(root, parent) ?? parent} is a file, not a folder.`); } catch { createsFolder = true; }
  const kind = path.dirname(from).toLowerCase() === parent.toLowerCase() ? 'rename' : 'move';
  return { ok: true, from, to, relFrom, relTo, kind, createsFolder, caseOnly };
}

/** One sentence for the approval card and the result. */
export function describeFileMove(plan: Extract<FileMovePlan, { ok: true }>): string {
  return plan.kind === 'rename'
    ? `rename ${plan.relFrom} to ${path.basename(plan.to)}`
    : `move ${plan.relFrom} to ${plan.relTo}${plan.createsFolder ? ' (the folder is created)' : ''}`;
}

/**
 * Does the move and checks it on disk: the file is at the new place with the same size, and no longer at the old one.
 * Never overwrites: the destination is checked again immediately before the rename.
 */
export function performFileMove(plan: Extract<FileMovePlan, { ok: true }>): { ok: true; bytes: number } | { ok: false; error: string } {
  try {
    const before = fs.statSync(plan.from);
    if (!plan.caseOnly && fs.existsSync(plan.to)) return { ok: false, error: `${plan.relTo} appeared in the meantime; nothing was overwritten` };
    if (plan.createsFolder) fs.mkdirSync(path.dirname(plan.to), { recursive: true });
    fs.renameSync(plan.from, plan.to);
    const after = fs.statSync(plan.to);
    if (!after.isFile() || after.size !== before.size) return { ok: false, error: `${plan.relTo} is not the same file after the move (${after.size} bytes, expected ${before.size})` };
    if (!plan.caseOnly && fs.existsSync(plan.from)) return { ok: false, error: `${plan.relFrom} is still there after the move` };
    if (plan.caseOnly && !fs.readdirSync(path.dirname(plan.to)).includes(path.basename(plan.to))) return { ok: false, error: `the folder does not list ${path.basename(plan.to)} after the rename` };
    return { ok: true, bytes: after.size };
  } catch (err: any) {
    return { ok: false, error: err?.code === 'EXDEV' ? 'the destination is on another drive' : String(err?.message ?? err) };
  }
}
