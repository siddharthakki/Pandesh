import { describe, expect, it } from 'vitest';
import { ToolRegistry } from '../../tools/ToolRegistry';

function names(mode: 'ask' | 'plan' | 'agent' | 'chat'): string[] {
  return ToolRegistry.schemasForMode(mode).map(tool => tool.function.name);
}

describe('ToolRegistry mode-scoped schemas', () => {
  it.each(['ask', 'plan'] as const)(
    'exposes only safe read tools in %s mode',
    mode => {
      const exposed = names(mode);

      expect(exposed).toEqual(expect.arrayContaining([
        'read_file',
        'read_file_range',
        'list_directory',
        'search_files',
        'grep',
        'git_status',
        'git_diff',
        'git_branch',
        'git_log',
      ]));
      expect(exposed).not.toContain('write_file');
      expect(exposed).not.toContain('edit_file');
      expect(exposed).not.toContain('propose_file_change');
      expect(exposed).not.toContain('run_command');
    },
  );

  it('exposes no tools in chat mode', () => {
    expect(names('chat')).toEqual([]);
  });

  it('retains the complete governed tool set in agent mode', () => {
    expect(names('agent')).toEqual(expect.arrayContaining([
      'read_file',
      'write_file',
      'edit_file',
      'run_command',
    ]));
  });
});
