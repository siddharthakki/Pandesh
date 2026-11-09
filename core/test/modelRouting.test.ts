import { describe, expect, it } from 'vitest';
import {
  AUTO_CHAT_MODEL,
  AUTO_FALLBACK_MODEL,
  AUTO_MUTATION_MODEL,
  AUTO_QUESTION_MODEL,
  AUTO_RECOVERY_MODEL,
  routeModel,
} from '../domain/modelRouting';
import { LOCAL_CORE_QUESTION_PROFILE } from '../runtime/localCoreQuestion';
import { AUTONOMOUS_MISSION_PROFILE } from '../runtime/missionLoop';
import { CoreError } from '../domain/errors';

const reachable = (models: string[]) => ({ reachable: true, models });

describe('Core-owned local model routing', () => {
  it('selects the measured primary for each request kind', () => {
    const catalog = reachable([AUTO_CHAT_MODEL, AUTO_QUESTION_MODEL, AUTO_MUTATION_MODEL]);
    expect(routeModel('baat_kar', undefined, catalog).selectedModel).toBe(AUTO_CHAT_MODEL);
    expect(routeModel('saath_kar', LOCAL_CORE_QUESTION_PROFILE, catalog).selectedModel).toBe(AUTO_QUESTION_MODEL);
    expect(routeModel('saath_kar', AUTONOMOUS_MISSION_PROFILE, catalog).selectedModel).toBe(AUTO_MUTATION_MODEL);
    expect(routeModel('karke_dikha', undefined, catalog).selectedModel).toBe(AUTO_MUTATION_MODEL);
  });

  it('uses Laguna as the explicit recovery tier when it is the first installed candidate', () => {
    const result = routeModel('saath_kar', LOCAL_CORE_QUESTION_PROFILE, reachable([AUTO_RECOVERY_MODEL]));
    expect(result.selectedModel).toBe(AUTO_RECOVERY_MODEL);
    expect(result.candidates.find((candidate) => candidate.model === AUTO_QUESTION_MODEL)).toMatchObject({ available: false });
    expect(result.candidates.find((candidate) => candidate.model === AUTO_RECOVERY_MODEL)).toMatchObject({ available: true });
  });

  // D9: an installed model serves when no chain tag is installed; only a catalog with no generative model fails closed.
  it('fails closed when Ollama is reachable but no generative model is installed', () => {
    expect(() => routeModel('karke_dikha', AUTONOMOUS_MISSION_PROFILE, reachable(['nomic-embed-text:latest'])))
      .toThrow(CoreError);
    expect(routeModel('karke_dikha', AUTONOMOUS_MISSION_PROFILE, reachable(['unrelated:model'])).selectedModel).toBe('unrelated:model');
  });

  // D9: an unreachable catalog never "selects" a model it cannot see installed.
  it('refuses to select a model when catalog discovery is unreachable', () => {
    expect(() => routeModel('saath_kar', LOCAL_CORE_QUESTION_PROFILE, { reachable: false, models: [] })).toThrow(/not reachable/);
  });

  it('freezes the introspected window of the selected model with its provenance', () => {
    const catalog = { reachable: true, models: [AUTO_CHAT_MODEL, AUTO_RECOVERY_MODEL], contextWindows: { [AUTO_CHAT_MODEL]: 16_384 } };
    expect(routeModel('baat_kar', undefined, catalog)).toMatchObject({
      contextWindowTokens: 16_384,
      contextWindowSource: 'provider_introspection',
    });
  });

  it('omits the window when introspection returned nothing, so Core records its assumption', () => {
    const result = routeModel('baat_kar', undefined, reachable([AUTO_CHAT_MODEL]));
    expect(result).not.toHaveProperty('contextWindowTokens');
    expect(result).not.toHaveProperty('contextWindowSource');
    // Only the *selected* model's window matters, not another model's.
    const other = routeModel('baat_kar', undefined, { reachable: true, models: [AUTO_CHAT_MODEL], contextWindows: { [AUTO_RECOVERY_MODEL]: 65_536 } });
    expect(other).not.toHaveProperty('contextWindowTokens');
  });

  it('honours an explicit override but never above the introspected window', () => {
    const catalog = { reachable: true, models: [AUTO_CHAT_MODEL], contextWindows: { [AUTO_CHAT_MODEL]: 16_384 } };
    expect(routeModel('baat_kar', undefined, catalog, { contextWindowOverrideTokens: 8192 }))
      .toMatchObject({ contextWindowTokens: 8192, contextWindowSource: 'explicit_config' });
    expect(routeModel('baat_kar', undefined, catalog, { contextWindowOverrideTokens: 65_536 }))
      .toMatchObject({ contextWindowTokens: 16_384, contextWindowSource: 'explicit_config' });
    expect(routeModel('baat_kar', undefined, reachable([AUTO_CHAT_MODEL]), { contextWindowOverrideTokens: 12_000 }))
      .toMatchObject({ contextWindowTokens: 12_000, contextWindowSource: 'explicit_config' });
  });

  it('records accurate capability requirements for read-only questions and mutations', () => {
    const catalog = reachable([AUTO_QUESTION_MODEL, AUTO_MUTATION_MODEL]);
    expect(routeModel('saath_kar', LOCAL_CORE_QUESTION_PROFILE, catalog).requiredCapabilities).toMatchObject({
      readOnlyExplanation: true,
      repositoryExploration: true,
      toolCalling: true,
      fileModification: false,
      validationAndRepair: false,
    });
    expect(routeModel('saath_kar', AUTONOMOUS_MISSION_PROFILE, catalog).requiredCapabilities).toMatchObject({
      fileModification: true,
      validationAndRepair: true,
    });
  });
});
