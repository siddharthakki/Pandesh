import { describe, expect, it } from 'vitest';
import { ModelProfileRegistry } from '../../reliability/ModelProfiles';
import { ToolCallNormalizer } from '../../reliability/ToolCallReliability';
import { ToolDefinition } from '../../tools/ToolTypes';

const readFileTool: ToolDefinition = {
  type: 'function',
  function: {
    name: 'read_file',
    description: 'Read a file',
    parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
  },
};

const writeFileTool: ToolDefinition = {
  type: 'function',
  function: {
    name: 'write_file',
    description: 'Write a file',
    parameters: {
      type: 'object',
      properties: { path: { type: 'string' }, content: { type: 'string' } },
      required: ['path', 'content'],
    },
  },
};

const TOOLS = [readFileTool, writeFileTool];
const qwen = ModelProfileRegistry.resolve('qwen3-coder:30b', 'ollama'); // openai-tools, qwen-xml, json-envelope
const llama = ModelProfileRegistry.resolve('llama3.1:8b', 'ollama');    // openai-tools, json-envelope (no XML)
const vision = ModelProfileRegistry.resolve('qwen2.5vl:7b', 'ollama');  // none

const normalizer = new ToolCallNormalizer();

function normalize(content: string, profile = qwen, nativeCalls?: Parameters<ToolCallNormalizer['normalize']>[0]['nativeCalls'], budget = 512) {
  return normalizer.normalize({ content, nativeCalls, tools: TOOLS, profile, repairBudgetTokens: budget });
}

const XML_BLOCK = [
  '<function=write_file>',
  '<parameter=path>',
  'a.txt',
  '</parameter>',
  '<parameter=content>',
  'hello',
  '</parameter>',
  '</function>',
  '</tool_call>',
].join('\n');

describe('M11 profile-gated tool protocols (Blocker 8)', () => {
  it('extracts an XML function block when the profile allows qwen-xml', () => {
    const result = normalize(`Creating the file now.\n${XML_BLOCK}`);
    expect(result.ok).toBe(true);
    expect(result.calls).toEqual([{
      function: { name: 'write_file', arguments: { path: 'a.txt', content: 'hello' } },
    }]);
    expect(result.textContent).toBe('Creating the file now.');
  });

  it('rejects XML tool output when the profile does not allow the XML protocol', () => {
    const result = normalize(XML_BLOCK, llama);
    expect(result.ok).toBe(false);
    expect(result.code).toBe('unsupported_tool_protocol');
  });

  it('accepts JSON envelopes when the profile allows json-envelope', () => {
    const result = normalize('{"name":"read_file","arguments":{"path":"a.ts"}}', llama);
    expect(result.ok).toBe(true);
    expect(result.calls[0].function.name).toBe('read_file');
  });

  it('a profile declaring none never parses textual tool calls and fails closed on recognizable envelopes', () => {
    const json = normalize('{"name":"read_file","arguments":{"path":"a.ts"}}', vision);
    expect(json.ok).toBe(false);
    expect(json.code).toBe('unsupported_tool_protocol');

    const xml = normalize(XML_BLOCK, vision);
    expect(xml.ok).toBe(false);
    expect(xml.code).toBe('unsupported_tool_protocol');
  });

  it('rejects native tool calls when the profile does not allow the native protocol', () => {
    const result = normalize('', vision, [{ function: { name: 'read_file', arguments: { path: 'a.ts' } } }]);
    expect(result.ok).toBe(false);
    expect(result.code).toBe('unsupported_tool_protocol');
  });
});

describe('M11 fail-closed envelope handling (Blocker 9)', () => {
  it('keeps plain natural-language responses as valid text', () => {
    const result = normalize('The file contains three exported functions and no bugs.');
    expect(result.ok).toBe(true);
    expect(result.calls).toHaveLength(0);
  });

  it('keeps fenced non-tool JSON (example data) as valid text', () => {
    const result = normalize('Example config:\n```json\n{"port": 8080, "debug": false}\n```');
    expect(result.ok).toBe(true);
    expect(result.calls).toHaveLength(0);
    expect(result.textContent).toContain('8080');
  });

  it('keeps fenced source code as valid text', () => {
    const result = normalize('Use this:\n```ts\nconst x: number = 1;\n```');
    expect(result.ok).toBe(true);
    expect(result.calls).toHaveLength(0);
  });

  it('fails a recognized envelope with an unknown tool instead of passing it as prose', () => {
    const result = normalize('```json\n{"name":"delete_everything","arguments":{"path":"/"}}\n```');
    expect(result.ok).toBe(false);
    expect(result.code).toBe('unknown_tool');
  });

  it('fails a recognized envelope with invalid arguments as malformed_tool_call', () => {
    const result = normalize('```json\n{"name":"write_file","arguments":{"path":"a.txt"}}\n```');
    expect(result.ok).toBe(false);
    expect(result.code).toBe('malformed_tool_call');
    expect(result.reason).toContain('Missing required field');
  });

  it('fails a recognized malformed envelope whose repair fails with tool_call_repair_failed', () => {
    const result = normalize('```json\n{"name":"read_file","arguments":{"path": BROKEN}}\n```');
    expect(result.ok).toBe(false);
    expect(result.code).toBe('tool_call_repair_failed');
  });

  it('fails malformed XML blocks instead of guessing', () => {
    const result = normalize('<function=write_file><parameter=path>a.txt</parameter>residue</function>');
    expect(result.ok).toBe(false);
    expect(result.code).toBe('malformed_tool_call');
  });

  it('fails unknown tools in XML blocks instead of ignoring them', () => {
    const result = normalize('<function=dangerous_unknown_tool><parameter=path>x</parameter></function>');
    expect(result.ok).toBe(false);
    expect(result.code).toBe('unknown_tool');
  });
});

describe('M11 native tool-call validation (Blocker 10)', () => {
  it('validates names and schemas and reports schema_validated only after success', () => {
    const result = normalize('', qwen, [
      { id: 'call_1', function: { name: 'read_file', arguments: { path: 'a.ts' } } },
    ]);
    expect(result.ok).toBe(true);
    expect(result.steps).toEqual(['native_tool_calls', 'schema_validated']);
    expect(result.calls[0].id).toBe('call_1');
  });

  it('rejects the complete call set when any call names an unknown tool', () => {
    const result = normalize('', qwen, [
      { function: { name: 'read_file', arguments: { path: 'a.ts' } } },
      { function: { name: 'no_such_tool', arguments: {} } },
    ]);
    expect(result.ok).toBe(false);
    expect(result.code).toBe('unknown_tool');
    expect(result.calls).toHaveLength(0);
    expect(result.steps).not.toContain('schema_validated');
  });

  it('rejects the complete call set when any call has invalid arguments', () => {
    const result = normalize('', qwen, [
      { function: { name: 'read_file', arguments: { path: 'a.ts' } } },
      { function: { name: 'write_file', arguments: { path: 'b.ts' } } },
    ]);
    expect(result.ok).toBe(false);
    expect(result.code).toBe('malformed_tool_call');
    expect(result.calls).toHaveLength(0);
  });

  it('preserves provider-assigned tool-call IDs on every accepted call', () => {
    const result = normalize('', qwen, [
      { id: 'call_a', function: { name: 'read_file', arguments: { path: 'a.ts' } } },
      { id: 'call_b', function: { name: 'write_file', arguments: { path: 'b.ts', content: 'x' } } },
    ]);
    expect(result.ok).toBe(true);
    expect(result.calls.map(call => call.id)).toEqual(['call_a', 'call_b']);
  });
});

describe('M11 bounded single repair (Blocker 11)', () => {
  const MALFORMED = '```json\n{"name":"read_file","arguments":{"path":"a.ts",}}\n```';

  it('repairs at most once, deterministically, and reports the attempt', () => {
    const result = normalize(MALFORMED);
    expect(result.ok).toBe(true);
    expect(result.repaired).toBe(true);
    expect(result.repair).toMatchObject({ attempted: true, result: 'succeeded' });
    expect(result.repair.candidateTokens).toBeGreaterThan(0);
    expect(result.repair.budgetTokens).toBe(512);
  });

  it('refuses repair when the candidate exceeds the repair budget', () => {
    const result = normalize(MALFORMED, qwen, undefined, 2);
    expect(result.ok).toBe(false);
    expect(result.code).toBe('tool_call_repair_failed');
    expect(result.repair.attempted).toBe(false);
    expect(result.reason).toContain('repair budget');
  });

  it('rejects ambiguous multiple malformed candidates without attempting repair', () => {
    const twoBroken = [
      '```json\n{"name":"read_file","arguments":{"path":"a.ts",}}\n```',
      '```json\n{"name":"read_file","arguments":{"path":"b.ts",}}\n```',
    ].join('\n');
    const result = normalize(twoBroken);
    expect(result.ok).toBe(false);
    expect(result.code).toBe('ambiguous_tool_call_candidates');
    expect(result.repair.attempted).toBe(false);
  });

  it('never invents required arguments during repair', () => {
    const result = normalize('```json\n{"name":"write_file","arguments":{"path":"a.txt",}}\n```');
    expect(result.ok).toBe(false);
    expect(result.code).toBe('malformed_tool_call');
    expect(result.repair.result).toBe('failed');
    expect(result.reason).toContain('Missing required field');
  });

  it('does not embed raw arguments in failure reasons', () => {
    const secret = 'super-secret-value-abc123';
    const result = normalize(`\`\`\`json\n{"name":"write_file","arguments":{"path":"a.txt","content":"${secret}" BROKEN}}\n\`\`\``);
    expect(result.ok).toBe(false);
    expect(result.code).toBe('tool_call_repair_failed');
    expect(JSON.stringify({ reason: result.reason, repair: result.repair, steps: result.steps })).not.toContain(secret);
  });
});
