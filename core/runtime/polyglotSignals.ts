/**
 * Minimal, registry-shaped ecosystem detection for `discoverValidationGates`.
 * Lives inside `core/` (not `src/workspace/`) because Core builds standalone
 * from `core/` alone (see `workspaceValidation.ts`'s header) — the richer
 * multi-signal workspace discovery for the extension host lives in
 * `src/workspace/PolyglotDiscovery.ts` and does not feed this file.
 *
 * Each entry is additive: detecting a new ecosystem here means adding one
 * entry, not touching the callers. `discoverValidationGates` still runs at
 * most one gate per mutation (`MAX_GATES_PER_MUTATION`), so ecosystem gates
 * are only reached when no stronger npm/TypeScript gate already claimed the
 * slot.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { ValidationGate } from './workspaceValidation';

function exists(cwd: string, relativePath: string): boolean {
  return fs.existsSync(path.join(cwd, relativePath));
}

interface PolyglotEcosystem {
  id: string;
  /** True if signal files for this ecosystem are present in `cwd`. */
  detect(cwd: string): boolean;
  gate(): ValidationGate;
}

const ECOSYSTEMS: PolyglotEcosystem[] = [
  {
    id: 'python-pytest',
    detect: cwd =>
      (exists(cwd, 'pyproject.toml') || exists(cwd, 'requirements.txt') || exists(cwd, 'setup.py'))
      && (exists(cwd, 'pytest.ini') || exists(cwd, 'tests') || exists(cwd, 'test')),
    gate: () => ({ id: 'convention-python-pytest', category: 'unit_test', command: 'python -m pytest', source: 'convention' }),
  },
];

/**
 * Ecosystem-derived gates beyond the npm/TypeScript conventions
 * `discoverValidationGates` already checks directly. Order matters only in
 * that earlier entries are tried first; the caller still bounds the total.
 */
export function discoverPolyglotValidationGates(cwd: string): ValidationGate[] {
  return ECOSYSTEMS.filter(ecosystem => ecosystem.detect(cwd)).map(ecosystem => ecosystem.gate());
}
