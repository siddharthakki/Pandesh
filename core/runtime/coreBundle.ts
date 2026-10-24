import * as crypto from 'node:crypto';
import * as fs from 'node:fs';

/** Content hash of a Core bundle file. Used to detect an outdated running process
 * after a rebuild that did not bump the semver string. */
export function hashCoreBundle(filePath: string | undefined): string | undefined {
  if (!filePath) return undefined;
  try {
    if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) return undefined;
    return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
  } catch {
    return undefined;
  }
}
