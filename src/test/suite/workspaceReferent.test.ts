import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { isWholeWorkspaceQuestion } from '../../context/ContextSelector';
import { detectWorkspaceProjectEvidence, resolveWorkspaceReferent } from '../../context/WorkspaceReferent';

const made: string[] = [];
function workspace(files: Record<string, string>, opts: { git?: boolean } = {}): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kkd-referent-'));
  made.push(root);
  if (opts.git) fs.mkdirSync(path.join(root, '.git'));
  for (const [file, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), content);
  }
  return root;
}
afterEach(() => { while (made.length) fs.rmSync(made.pop()!, { recursive: true, force: true }); });

const ASK = 'What does this do?';

describe('workspace referent: ambiguous questions resolve against the active workspace', () => {
  it('1. Git repo + "What does this do?" -> repository overview', async () => {
    const root = workspace({ 'package.json': '{}', 'src/index.js': 'console.log(1)' }, { git: true });
    const evidence = await detectWorkspaceProjectEvidence(root);
    expect(evidence.git).toBe(true);
    expect(resolveWorkspaceReferent({ text: ASK, evidence, conversationReferent: 'none' })).toBe('workspace_overview');
  });

  it('2. non-Git source folder + "What does this do?" -> workspace overview (Git is optional)', async () => {
    const root = workspace({ 'app.py': 'print(1)', 'lib/util.py': 'x = 1' });
    const evidence = await detectWorkspaceProjectEvidence(root);
    expect(evidence.git).toBe(false);
    expect(evidence.hasProject).toBe(true);
    expect(resolveWorkspaceReferent({ text: ASK, evidence, conversationReferent: 'none' })).toBe('workspace_overview');
  });

  it('3. empty folder (or README only) + "What does this do?" -> generic/clarifying path', async () => {
    const empty = await detectWorkspaceProjectEvidence(workspace({}));
    expect(resolveWorkspaceReferent({ text: ASK, evidence: empty, conversationReferent: 'none' })).toBe('not_workspace');
    const readmeOnly = await detectWorkspaceProjectEvidence(workspace({ 'README.md': '# Empty project folder' }));
    expect(readmeOnly.hasProject).toBe(false);
    expect(resolveWorkspaceReferent({ text: ASK, evidence: readmeOnly, conversationReferent: 'none' })).toBe('not_workspace');
    expect(await detectWorkspaceProjectEvidence(undefined)).toMatchObject({ hasProject: false });
  });

  it('4. active repo but the conversation clearly refers to something else -> not forced to the repository', async () => {
    const evidence = await detectWorkspaceProjectEvidence(workspace({ 'package.json': '{}', 'src/a.ts': 'export {}' }, { git: true }));
    expect(resolveWorkspaceReferent({ text: ASK, evidence, conversationReferent: 'other' })).toBe('not_workspace');
    expect(resolveWorkspaceReferent({ text: ASK, evidence, conversationReferent: 'none', hasAttachments: true })).toBe('not_workspace');
    // a conversation that has already been about the workspace keeps the workspace reading
    expect(resolveWorkspaceReferent({ text: ASK, evidence, conversationReferent: 'workspace' })).toBe('workspace_overview');
  });

  it('does not treat ordinary or topic-specific questions as whole-workspace questions', async () => {
    const evidence = await detectWorkspaceProjectEvidence(workspace({ 'package.json': '{}' }));
    for (const text of ['What time is it?', 'How does a mutex work?', 'Explain the structure of a TCP packet', 'Why that one?', 'What does this word mean in French?']) {
      expect(resolveWorkspaceReferent({ text, evidence, conversationReferent: 'none' }), text).toBe('not_workspace');
    }
  });
});

describe('isWholeWorkspaceQuestion', () => {
  it('recognises the plain ways of asking about the place you are standing in', () => {
    for (const text of ['What does this do?', 'How does this work?', 'Where does this start?', "What's going on here?", 'Explain this to me.',
      'What does this project do and where does the main execution start?']) {
      expect(isWholeWorkspaceQuestion(text), text).toBe(true);
    }
  });
});
