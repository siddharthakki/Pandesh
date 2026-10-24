import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { _setConfig, _resetConfig } from '../mocks/vscode';
import { ModelRouter } from '../../agent/ModelRouter';
import { DEFAULTS } from '../../config/Defaults';
import { ResolvedModelDefaults } from '../../config/ResolvedModelDefaults';
import type { ChatMessage } from '../../tools/ToolTypes';

const msg = (content: string): ChatMessage[] => [
  { role: 'system', content: 'You are a helpful assistant.' },
  { role: 'user', content },
];

// codingModel/chatModel default to '' ("Auto" — see Defaults.ts). In real
// usage AgentPanel.loadModels() always runs discovery before ModelRouter can
// be reached and populates ResolvedModelDefaults with the model Auto
// actually selected (see Config.ts). These tests simulate that same ordering
// using real ModelCapabilityRegistry-known names (not arbitrary
// placeholders) rather than asserting against the now-empty literal.
const AUTO_CODING_MODEL = 'qwen3-coder:30b';
const AUTO_CHAT_MODEL = 'qwen2.5-coder:14b';

describe('ModelRouter — model selection', () => {
  beforeEach(() => {
    _resetConfig();
    ResolvedModelDefaults.clear();
    ResolvedModelDefaults.set('agent', AUTO_CODING_MODEL);
    ResolvedModelDefaults.set('chat', AUTO_CHAT_MODEL);
  });
  afterEach(() => {
    _resetConfig();
    ResolvedModelDefaults.clear();
  });

  it('selects coding model for a coding task', () => {
    const model = ModelRouter.selectModel(msg('write a typescript function to parse JSON'), false);
    expect(model).toBe(AUTO_CODING_MODEL);
  });

  it('selects chat model for a general question', () => {
    const model = ModelRouter.selectModel(msg('what is the capital of France?'), false);
    expect(model).toBe(AUTO_CHAT_MODEL);
  });

  it('selects vision model when images are present', () => {
    const model = ModelRouter.selectModel(msg('describe this image'), true);
    expect(model).toBe(DEFAULTS.visionModel);
  });

  it('selects vision model when hasDocuments is true', () => {
    const model = ModelRouter.selectModel(msg('summarise this document'), false, true);
    expect(model).toBe(DEFAULTS.visionModel);
  });

  it('selects vision model when content contains [Attached document:]', () => {
    const model = ModelRouter.selectModel(
      msg('[Attached document: report.pdf] Please summarise'),
      false,
    );
    expect(model).toBe(DEFAULTS.visionModel);
  });

  it('respects custom coding model set via config', () => {
    _setConfig('ollama-agent.codingModel', 'custom-coder:7b');
    const model = ModelRouter.selectModel(msg('fix this typescript bug'), false);
    expect(model).toBe('custom-coder:7b');
  });

  it('respects custom chat model set via config', () => {
    _setConfig('ollama-agent.chatModel', 'custom-chat:3b');
    const model = ModelRouter.selectModel(msg('hello how are you'), false);
    expect(model).toBe('custom-chat:3b');
  });

  it('describeSelection returns a human-readable reason', () => {
    const desc = ModelRouter.describeSelection(msg('write a python script'), false);
    expect(desc).toMatch(/coding/);
  });

  it('describeSelection includes model name in reason', () => {
    const desc = ModelRouter.describeSelection(msg('hello'), false);
    expect(desc).toContain(AUTO_CHAT_MODEL);
  });

  // Regression: autocomplete model (qwen2.5-coder:1.5b) must not be used for agent mode.
  // ModelRouter does not know about agent vs autocomplete — that gate is in AgentRuntime.
  // codingModel/chatModel default to '' (Auto), never a hardcoded name at all,
  // so they can never coincide with the autocomplete default by construction.
  it('fresh-install coding and chat defaults are Auto (unset), never the autocomplete model or any hardcoded name', () => {
    const autocomplete = 'qwen2.5-coder:1.5b';
    expect(DEFAULTS.codingModel).toBe('');
    expect(DEFAULTS.chatModel).toBe('');
    expect(DEFAULTS.codingModel).not.toBe(autocomplete);
    expect(DEFAULTS.chatModel).not.toBe(autocomplete);
  });
});
