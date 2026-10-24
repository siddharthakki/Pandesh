import { describe, expect, it } from 'vitest';
import { validateToolArguments } from '../../tools/ToolArgumentValidator';
import { TOOL_SCHEMAS } from '../../tools/ToolSchemas';

function schema(name: string) {
  const match = TOOL_SCHEMAS.find(item => item.function.name === name);
  if (!match) { throw new Error(`Missing schema: ${name}`); }
  return match;
}

describe('tool argument validation', () => {
  it('accepts a complete write_file call', () => {
    expect(validateToolArguments(schema('write_file'), {
      path: 'docs/test.md',
      content: '# Test',
    })).toEqual({ ok: true });
  });

  it('rejects a write_file call without content', () => {
    const result = validateToolArguments(schema('write_file'), {
      path: 'docs/test.md',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) { expect(result.error).toMatch(/content/i); }
  });

  it('rejects a run_command call without command', () => {
    const result = validateToolArguments(schema('run_command'), {});
    expect(result.ok).toBe(false);
    if (!result.ok) { expect(result.error).toMatch(/command/i); }
  });
});
