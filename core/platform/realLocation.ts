import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * Where a path really is: its nearest existing ancestor resolved by the OS (junctions, symbolic links, 8.3 short names,
 * subst drives), with the not-yet-existing rest appended. Folder checks compare these, never spellings (Build 161
 * audit: a junction inside an allowed folder that pointed elsewhere passed every check by its spelling).
 */
export function realLocation(p: string): string {
  const tail: string[] = [];
  let current = path.resolve(p);
  for (;;) {
    try {
      return path.join(fs.realpathSync.native(current), ...[...tail].reverse());
    } catch {
      const parent = path.dirname(current);
      if (parent === current) return path.resolve(p);
      tail.push(path.basename(current));
      current = parent;
    }
  }
}

/** Whether `p` really lies inside `root` (or is it). */
export function reallyInside(p: string, root: string): boolean {
  const rel = path.relative(realLocation(root), realLocation(p));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}
