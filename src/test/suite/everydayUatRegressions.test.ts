import { describe, expect, it } from 'vitest';
import fs from 'fs';
import path from 'path';
import {
  isReadOnlyInspectionRequest,
  resolveExecutionMode,
} from '../../agent/TaskIntent';
import { ToolRegistry } from '../../tools/ToolRegistry';
import { readResolvedCss } from '../helpers/resolveCssImports';

describe('everyday MVP final UAT regressions', () => {
  it('constrains natural file inspection prompts to read-only Ask tools', () => {
    for (const prompt of [
      'Inspect README.md and summarize it.',
      'Inspect package.json and explain the main scripts.',
      'List the files in this workspace.',
    ]) {
      expect(isReadOnlyInspectionRequest(prompt)).toBe(true);
      const mode = resolveExecutionMode(prompt, 'agent');
      expect(mode).toBe('ask');
      const tools = ToolRegistry.schemasForMode(mode).map(tool => tool.function.name);
      expect(tools).toContain('read_file');
      expect(tools).not.toContain('run_command');
      expect(tools).not.toContain('write_file');
    }
  });

  it('does not downgrade an inspection request that also asks for mutation', () => {
    const prompt = 'Inspect README.md and add a new section.';
    expect(isReadOnlyInspectionRequest(prompt)).toBe(false);
    expect(resolveExecutionMode(prompt, 'agent')).toBe('agent');
  });

  it('ships Auto (unset) fresh-install defaults for task-role models, never a hardcoded Qwen name', () => {
    const packageJson = JSON.parse(
      fs.readFileSync(path.resolve(process.cwd(), 'package.json'), 'utf8'),
    ) as {
      contributes: {
        configuration: {
          properties: Record<string, { default: string }>;
        };
      };
    };
    const properties = packageJson.contributes.configuration.properties;
    // These roles feed automatic selection (see ProductionModelCandidates's
    // AUTO_ELIGIBLE_ROLES): a fresh install must discover and select a viable
    // installed model at runtime, never block on a historical named default.
    for (const key of ['model', 'chatModel', 'agentModel', 'codingModel', 'editModel', 'reviewerModel', 'codingFallbackModel']) {
      const propertyDefault = properties[`ollama-agent.${key}`].default;
      expect(propertyDefault, `ollama-agent.${key} default`).toBe('');
      expect(propertyDefault, `ollama-agent.${key} default`).not.toBe('qwen2.5:14b');
      expect(propertyDefault, `ollama-agent.${key} default`).not.toBe('qwen2.5-coder:14b');
    }
    // visionModel keeps a named default: vision needs an image-capable model
    // and generic chat/agent capability checks don't gate for that.
    expect(properties['ollama-agent.visionModel'].default).toBe('qwen3-vl:30b');
  });

  it('keeps the plain-language model suitability summary on the everyday surface', () => {
    const html = fs.readFileSync(path.resolve(process.cwd(), 'media/chat.html'), 'utf8');
    const runtime = fs.readFileSync(path.resolve(process.cwd(), 'media/chat-runtime-fixes.js'), 'utf8');
    const layout = readResolvedCss(path.resolve(process.cwd(), 'media/chat-layout-fixes.css'));
    expect(html).toContain('id="model-suitability-summary"');
    expect(runtime).toContain("message.type === 'modelSuitability'");
    expect(runtime).toContain('modelSuitabilitySummary.hidden = false');
    expect(layout).toContain('.model-suitability-summary');
    expect(layout).not.toMatch(/#model-suitability-summary\s*\{[^}]*display:\s*none/i);
  });
});
