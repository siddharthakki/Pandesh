/**
 * Capability rows for Setup's CAPABILITIES section.
 *
 * Each platform module registers one provider that reports its own *current, evidenced* state; Setup never lists a
 * capability nothing registered. A provider returns undefined when it has nothing true to say (for example not set up).
 */
import type { CapabilityRow } from './OnboardingReadiness';

export type CapabilityProvider = () => CapabilityRow | undefined;

const providers = new Map<string, CapabilityProvider>();

export function registerCapability(id: string, provider: CapabilityProvider): { dispose(): void } {
  providers.set(id, provider);
  return { dispose: () => { if (providers.get(id) === provider) providers.delete(id); } };
}

export function collectCapabilityRows(): CapabilityRow[] {
  const rows: CapabilityRow[] = [];
  for (const [id, provider] of providers) {
    try {
      const row = provider();
      if (row) rows.push(row);
    } catch {
      rows.push({ name: id, status: 'warn', detail: 'Status unavailable' });
    }
  }
  return rows;
}

/** Test helper. */
export function clearCapabilitiesForTests(): void { providers.clear(); }
