/**
 * M49.2 — tolerant inline tool-call parsing (pure, deterministic). Executor-level atomicity,
 * native-path and guard behaviour are covered in validationInvariantAndReplacementGuard.test.ts (D).
 */
import { describe, it, expect } from 'vitest';
import { parseInlineToolCalls, validateNativeToolCalls, MAX_INLINE_TOOL_CALLS } from '../runtime/inlineToolCalls';
import { recoverInlineToolCalls } from '../runtime/modelBackend';
import { CoreToolRunner } from '../runtime/toolRunner';

const tools = new CoreToolRunner().definitions();
const READ = '{"name":"read_file","arguments":{"path":"a.js"}}';
const READ_B = '{"name":"read_file","arguments":{"path":"b.js"}}';
const PROPOSE_OPEN = '{"name":"propose_file_change","arguments":{"path":"expenses.js","content":"if (value <= 0) throw new Error(\\"bad\\");\\n"';

function ok(content: string) {
  const result = parseInlineToolCalls(content, tools);
  if (result.kind !== 'calls') throw new Error(`expected calls, got ${JSON.stringify(result)}`);
  return result;
}
function failure(content: string) {
  const result = parseInlineToolCalls(content, tools);
  if (result.kind !== 'failure') throw new Error(`expected failure, got ${JSON.stringify(result)}`);
  return result;
}

describe('parseInlineToolCalls (M49.2)', () => {
  it('accepts one valid inline call, fenced or bare, without any repair record', () => {
    expect(ok(READ).calls).toEqual([{ name: 'read_file', arguments: { path: 'a.js' } }]);
    const fenced = ok(`\`\`\`json\n${READ}\n\`\`\``);
    expect(fenced.calls).toHaveLength(1);
    expect(fenced.structuralRepair).toBeUndefined();
  });

  it('accepts two valid calls in order', () => {
    expect(ok(`${READ}\n${READ_B}`).calls.map((call) => call.arguments.path)).toEqual(['a.js', 'b.js']);
  });

  it('accepts two calls surrounded and separated by prose', () => {
    const result = ok(`I will look at both files {briefly}.\n${READ}\nThen the second one:\n${READ_B}\nThat is all.`);
    expect(result.calls.map((call) => call.arguments.path)).toEqual(['a.js', 'b.js']);
  });

  it('treats prose and unrelated JSON as no tool attempt', () => {
    expect(parseInlineToolCalls('The config is {"name": "x", "value": 1} and that is it.', tools)).toEqual({ kind: 'none' });
    expect(parseInlineToolCalls('Plain answer with no JSON.', tools)).toEqual({ kind: 'none' });
  });

  it('recovers a single missing final } and records structural_repair_applied / appendedClosers', () => {
    const result = ok(`${PROPOSE_OPEN}}`);
    expect(result.calls).toEqual([{ name: 'propose_file_change', arguments: { path: 'expenses.js', content: 'if (value <= 0) throw new Error("bad");\n' } }]);
    expect(result.structuralRepair).toEqual({ step: 'structural_repair_applied', appendedClosers: '}' });
  });

  it('recovers two missing structural closers, also before a closing code fence', () => {
    const result = ok(PROPOSE_OPEN);
    expect(result.structuralRepair).toEqual({ step: 'structural_repair_applied', appendedClosers: '}}' });
    expect(result.calls[0].arguments.path).toBe('expenses.js');
    expect(ok(`\`\`\`json\n${PROPOSE_OPEN}\n\`\`\``).structuralRepair?.appendedClosers).toBe('}}');
  });

  it('refuses more than two missing closers', () => {
    const f = failure('{"name":"read_file","arguments":{"path":"a.js","extra":{"k":[1');
    expect(f.code).toBe('invalid_json');
    expect(f.reason).toMatch(/^invalid_json: 4 closing delimiters missing at EOF \(limit 2\)/);
  });

  it('never repairs a reply that ended inside a string, or an object followed by more text', () => {
    expect(failure('{"name":"propose_file_change","arguments":{"path":"a.js","content":"abc').reason).toMatch(/inside a JSON string/);
    expect(failure(`${PROPOSE_OPEN} and then I kept talking`).reason).toMatch(/^invalid_json: missing closing delimiter\(s\) at EOF; appending "\}\}" did not give valid JSON/);
    expect(failure('{"name":"read_file","arguments":{"path":"a.js",').code).toBe('invalid_json');
  });

  it('does not repair an invalid escape inside argument content', () => {
    const f = failure('{"name":"propose_file_change","arguments":{"path":"a.js","content":"const r = /\\s+/;"}}');
    expect(f.code).toBe('invalid_escape');
    expect(f.reason).toMatch(/^invalid_escape: JSON string contains an invalid escape near /);
    // Also not when the object is additionally truncated: no repair, escape is reported.
    expect(failure('{"name":"propose_file_change","arguments":{"path":"a.js","content":"x\\s"').code).toBe('invalid_escape');
  });

  it('a malformed second call refuses the whole sequence', () => {
    const f = failure(`${READ}\n{"name":"read_file","arguments":{"path":"b.js",}}`);
    expect(f.code).toBe('invalid_json');
    expect(f.reason).toContain('tool call 2 of 2');
  });

  it('an unknown tool anywhere refuses the whole sequence', () => {
    const f = failure(`${READ}\n{"name":"delete_everything","arguments":{"path":"x"}}`);
    expect(f.code).toBe('unknown_tool');
    expect(f.reason).toMatch(/^unknown_tool: 'delete_everything' is not an available tool/);
  });

  it('invalid arguments anywhere refuse the whole sequence', () => {
    const missing = failure(`${READ}\n{"name":"read_file","arguments":{}}`);
    expect(missing.code).toBe('invalid_arguments');
    expect(missing.reason).toMatch(/missing required argument "path"/);
    expect(failure('{"name":"read_file","arguments":{"path":"a.js","startLine":"3"}}').code).toBe('invalid_arguments');
  });

  it('schema-validates nested mutation arguments and refuses the whole sequence, executing nothing', () => {
    const batchTool = {
      name: 'propose_batch_edit',
      description: 'nested mutation',
      parameters: {
        type: 'object',
        properties: {
          edits: {
            type: 'array',
            items: { type: 'object', properties: { path: { type: 'string' }, line: { type: 'integer' } }, required: ['path', 'find'] },
          },
        },
        required: ['edits'],
      },
    };
    const all = [...tools, batchTool];
    const run = (second: string) => parseInlineToolCalls(`${READ}\n${second}`, all);
    const bad = run('{"name":"propose_batch_edit","arguments":{"edits":[{"path":"a.js","find":"x"},{"path":"b.js"}]}}');
    expect(bad).toEqual({ kind: 'failure', code: 'invalid_arguments', reason: 'invalid_arguments: propose_batch_edit: missing required argument "edits[1].find" (tool call 2 of 2)' });
    const wrongType = run('{"name":"propose_batch_edit","arguments":{"edits":[{"path":"a.js","find":"x","line":"3"}]}}');
    expect(wrongType).toMatchObject({ kind: 'failure', code: 'invalid_arguments', reason: expect.stringContaining('argument "edits[0].line" must be an integer') });
    expect(run('{"name":"propose_batch_edit","arguments":{"edits":[{"path":"a.js","find":"x"}]}}').kind).toBe('calls');
  });

  it('keeps run_command accepting an argv-array command, the one dispatch coercion', () => {
    expect(ok('{"name":"run_command","arguments":{"command":["echo","hi"]}}').calls).toHaveLength(1);
    expect(failure('{"name":"run_command","arguments":{"command":5}}').reason).toContain('argument "command" must be a string');
  });

  it('accepts exactly 4 calls and refuses 5 with too_many_tool_calls', () => {
    expect(ok(Array.from({ length: MAX_INLINE_TOOL_CALLS }, () => READ).join('\n')).calls).toHaveLength(4);
    const f = failure(Array.from({ length: 5 }, () => READ).join('\n'));
    expect(f.code).toBe('too_many_tool_calls');
    expect(f.reason).toBe('too_many_tool_calls: 5 > 4');
  });

  it('flags a non-tool-shaped object that names a known tool as ambiguous_json', () => {
    expect(failure('{"tool_call":{"nam":"read_file"},"name":"read_file"}').code).toBe('ambiguous_json');
  });

  it('keeps XML function blocks on the existing strict single-call parser', () => {
    const one = '<function=read_file><parameter=path>a.js</parameter></function>';
    expect(recoverInlineToolCalls(one, tools)).toEqual({ kind: 'calls', calls: [{ name: 'read_file', arguments: { path: 'a.js' } }] });
    expect(recoverInlineToolCalls(`${one}${one}`, tools)).toEqual({ kind: 'none' });
  });
});

describe('native tool_calls gate (name + required arguments, as a unit)', () => {
  it('accepts exposed tools with their required arguments, including lenient native values', () => {
    expect(validateNativeToolCalls([{ name: 'read_file', arguments: { path: 'a.js', startLine: '2' } }], tools)).toBeNull();
    expect(validateNativeToolCalls([{ name: 'propose_text_edit', arguments: { path: 'a.js', find: 'x', replace: '' } }], tools)).toBeNull();
  });

  it('refuses a missing required argument without defaulting it', () => {
    expect(validateNativeToolCalls([{ name: 'propose_text_edit', arguments: { path: 'a.js', find: 'x' } }], tools))
      .toEqual({ code: 'invalid_arguments', reason: 'invalid_arguments: propose_text_edit: missing required argument "replace"' });
    expect(validateNativeToolCalls([{ name: 'propose_text_edit', arguments: { find: 'x', replace: 'y' } }], tools)?.reason)
      .toContain('missing required argument "path"');
  });

  it('refuses a tool outside the exposed set and labels its position in a multi-call reply', () => {
    expect(validateNativeToolCalls([{ name: 'read_file', arguments: { path: 'a.js' } }, { name: 'memory_remember', arguments: {} }], tools))
      .toEqual({ code: 'unknown_tool', reason: "unknown_tool: 'memory_remember' is not an available tool (tool call 2 of 2)" });
  });
});
