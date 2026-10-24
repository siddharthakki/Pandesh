import { beforeEach, describe, expect, it } from 'vitest';
import { _resetConfig, _setConfig } from '../mocks/vscode';
import { ResolvedModelDefaults } from '../../config/ResolvedModelDefaults';
import { configuredModelRoles, unconfiguredAutoEligibleRoles } from '../../models/ProductionModelCandidates';

/**
 * A remembered Auto pick (ResolvedModelDefaults) is not user configuration. When candidate building treated it as
 * one, the first Auto selection for a role (made against a light baseline) silently became that role's only
 * "configured" model, every other installed model lost the role, and a stronger task found no capable candidate
 * ("No available configured model ... satisfies the task requirements").
 */
describe('Auto-resolved role defaults do not become explicit configuration', () => {
  beforeEach(() => {
    _resetConfig();
    ResolvedModelDefaults.clear();
  });

  it('leaves a role Auto when only a remembered pick exists for it', () => {
    ResolvedModelDefaults.set('agent', 'weak-baseline:7b');
    ResolvedModelDefaults.set('chat', 'weak-baseline:7b');
    expect(configuredModelRoles().get('weak-baseline:7b')).toBeUndefined();
    expect(unconfiguredAutoEligibleRoles().has('agent')).toBe(true);
    expect(unconfiguredAutoEligibleRoles().has('chat')).toBe(true);
  });

  it('still honours an explicit setting, which wins over any remembered pick', () => {
    ResolvedModelDefaults.set('agent', 'weak-baseline:7b');
    _setConfig('ollama-agent.agentModel', 'chosen:27b');
    expect(configuredModelRoles().get('chosen:27b')).toEqual(new Set(['agent']));
    expect(configuredModelRoles().get('weak-baseline:7b')).toBeUndefined();
    expect(unconfiguredAutoEligibleRoles().has('agent')).toBe(false);
  });
});
