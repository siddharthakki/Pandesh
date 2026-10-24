import { afterEach, describe, expect, it } from 'vitest';
import { PolicyEngine } from '../../policy/PolicyEngine';
import { _resetConfig, _setConfig } from '../mocks/vscode';

afterEach(() => _resetConfig());

describe('hardened policy rules', () => {
  it('denies edit_file in Ask and Plan modes', () => {
    const engine = new PolicyEngine();
    expect(engine.evaluate('edit_file', { path: 'x.ts' }, 'ask').action).toBe('deny');
    expect(engine.evaluate('edit_file', { path: 'x.ts' }, 'plan').action).toBe('deny');
  });

  it('does not classify arbitrary runtime execution as safe', () => {
    _setConfig('ollama-agent.requireApprovalForCommands', false);
    const engine = new PolicyEngine();
    expect(engine.evaluate('run_command', { command: 'node script.js' }, 'agent').action).toBe('ask-once');
    expect(engine.evaluate('run_command', { command: 'python script.py' }, 'agent').action).toBe('ask-once');
  });

  it('requires approval for a chained validation command', () => {
    _setConfig('ollama-agent.requireApprovalForCommands', false);
    const command = ['npm run compile', 'echo done'].join(' && ');
    const decision = new PolicyEngine().evaluate('run_command', { command }, 'agent');
    expect(decision.action).toBe('ask-once');
    expect(decision.reason).toMatch(/shell-operator/i);
  });

  it('denies unknown tools rather than offering approval', () => {
    expect(new PolicyEngine().evaluate('invented_tool', {}, 'agent').action).toBe('deny');
  });
});
