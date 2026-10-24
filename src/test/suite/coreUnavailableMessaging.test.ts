import { describe, expect, it } from 'vitest';
import { describeCoreUnavailableForBaat } from '../../ui/AgentPanel';

/**
 * The Baat/Saath "Core is not connected" message must be truthful about
 * *why* — a permanent, misleading "please wait for it to reconnect" string
 * used to cover every case, including `authentication_failed`, which will
 * never resolve on its own.
 */
describe('describeCoreUnavailableForBaat', () => {
  it('reports "starting"/"reconnecting" as transient, not failed', () => {
    expect(describeCoreUnavailableForBaat({ state: 'starting' })).toMatch(/starting/i);
    expect(describeCoreUnavailableForBaat({ state: 'starting' })).not.toMatch(/failed|error/i);
    expect(describeCoreUnavailableForBaat({ state: 'reconnecting' })).toMatch(/starting|moment/i);
  });

  it('reports authentication_failed as a deliberate dead end with a concrete action, never "will reconnect"', () => {
    const message = describeCoreUnavailableForBaat({ state: 'authentication_failed', detail: 'a running Core rejected our credentials' });
    expect(message).not.toMatch(/wait for it to reconnect/i);
    expect(message).toMatch(/Restart KarkeDikha Core/);
  });

  it('reports incompatible and database_failed with an actionable restart pointer', () => {
    expect(describeCoreUnavailableForBaat({ state: 'incompatible', detail: 'apiVersion mismatch' })).toMatch(/Restart KarkeDikha Core/);
    expect(describeCoreUnavailableForBaat({ state: 'database_failed', detail: 'disk full' })).toMatch(/disk full/);
  });

  it('reports unavailable with the real detail, not a generic string', () => {
    const message = describeCoreUnavailableForBaat({ state: 'unavailable', detail: 'Core did not become healthy within 10000ms' });
    expect(message).toMatch(/Core did not become healthy within 10000ms/);
  });

  it('falls back sensibly when no status has ever been observed', () => {
    expect(describeCoreUnavailableForBaat(undefined)).toMatch(/not connected/i);
  });
});
