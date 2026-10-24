/** Host-owned metadata. Core reads it; the model must not investigate it. */
export function isHostOwnedSearchPath(relative: string): boolean {
  const normalized = relative.replace(/\\/g, '/').replace(/^\.\//, '');
  return normalized === '.karkedikha' || normalized.startsWith('.karkedikha/');
}
