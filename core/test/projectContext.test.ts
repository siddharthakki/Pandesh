import { describe, it, expect, afterAll } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  resolveActiveProject,
  isProjectInspectionRequest,
  gatherProjectEvidence,
  formatProjectEvidenceForModel,
  composeEvidenceAnswer,
  isReplyGroundedInProject,
  isLocalModelEndpoint,
} from '../runtime/projectContext';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'project-context-'));
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

function makeProject(name: string, files: Record<string, string>): string {
  const root = path.join(tmp, name);
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(root, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  }
  fs.mkdirSync(root, { recursive: true });
  return root;
}

const pyRoot = makeProject('Sketcher', {
  'README.md': '# Sketcher\n\nSketcher turns text prompts into pencil-style drawings using a local diffusion model.\n\n## Run\n`launch.bat`\n',
  'requirements.txt': 'flask\nrequests\n',
  'app.py': 'print("hi")\n',
  'helpers.py': 'x = 1\n',
  'launch.bat': '@echo off\npython app.py\nset API_KEY=supersecret\n',
  '.env': 'TOKEN=abc',
  'node_modules/dep/index.js': 'ignored',
});
const nodeRoot = makeProject('Pinger', {
  'package.json': JSON.stringify({ name: 'pinger', description: 'Pings hosts', scripts: { start: 'node index.js', test: 'vitest' }, dependencies: { express: '^4' } }),
  'index.ts': 'export {}',
  'util.ts': 'export {}',
});

describe('request detection', () => {
  it.each([
    'What does this project do?',
    'what does this repo do',
    'Explain this codebase',
    'What language is it written in?',
    'How do I run it?',
    "what's in here?",
    'Tell me about the current project',
  ])('treats %j as a project-inspection request', (text) => expect(isProjectInspectionRequest(text)).toBe(true));

  it.each([
    'What is the weather in Paris?',
    'Draft an email to my landlord',
    'How do I run a marathon?',
    'hello',
    'Remind me to call mom tomorrow',
    'but i didnt get any notification!!! Why is that ? how is your notifcation system configured and how does it work ?',
    'How are your notifications configured?',
    "What's the status of my Gmail organization?",
    'What tasks are you running?',
    'Show my reminders.',
    'how does it work, the reminder thing?',
  ])('does not treat %j as one', (text) => expect(isProjectInspectionRequest(text)).toBe(false));
});

describe('workspace resolution', () => {
  it('resolves a real readable folder', () => {
    const r = resolveActiveProject(pyRoot);
    expect(r).toMatchObject({ ok: true, root: path.resolve(pyRoot), name: 'Sketcher' });
  });
  it('says exactly that no workspace is selected', () => {
    const r = resolveActiveProject(undefined);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('no_workspace');
  });
  it('says exactly that a missing folder is missing, and names it', () => {
    const gone = path.join(tmp, 'DeletedProject');
    const r = resolveActiveProject(gone);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toBe('missing');
      expect(r.message).toContain(gone);
      expect(r.message).toMatch(/does not exist or is no longer available/);
    }
  });
  it('rejects a file selected as the workspace', () => {
    const r = resolveActiveProject(path.join(pyRoot, 'app.py'));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('not_directory');
  });
});

describe('evidence gathering (read-only, bounded, private)', () => {
  it('reads README, manifests, run scripts and counts languages for a Python project', () => {
    const ev = gatherProjectEvidence(pyRoot);
    expect(ev.name).toBe('Sketcher');
    expect(ev.readme?.excerpt).toContain('pencil-style drawings');
    expect(ev.manifests.map((m) => m.file)).toContain('requirements.txt');
    expect(ev.languages[0]).toEqual({ language: 'Python', files: 2 });
    expect(ev.entryCandidates).toContain('app.py');
    expect(ev.filesRead.map((f) => f.path)).toEqual(expect.arrayContaining(['README.md', 'requirements.txt', 'launch.bat']));
  });
  it('never reads .env or vendored dependency folders, and redacts secret-looking lines', () => {
    const ev = gatherProjectEvidence(pyRoot);
    expect(ev.filesRead.map((f) => f.path)).not.toContain('.env');
    expect(ev.topLevel).not.toContain('.env');
    expect(ev.topLevel).not.toContain('node_modules/');
    const prompt = formatProjectEvidenceForModel(ev);
    expect(prompt).not.toContain('supersecret');
    expect(prompt).not.toContain('abc');
  });
  it('summarises a Node manifest and reports TypeScript', () => {
    const ev = gatherProjectEvidence(nodeRoot);
    expect(ev.languages[0].language).toBe('TypeScript');
    const answer = composeEvidenceAnswer(ev, 'How do I run it?');
    expect(answer).toContain('npm run start');
  });
  it('puts the project identity, not Pandesh, in the model prompt', () => {
    const prompt = formatProjectEvidenceForModel(gatherProjectEvidence(pyRoot));
    expect(prompt).toContain('Project name: Sketcher');
    expect(prompt).toContain(path.resolve(pyRoot));
    expect(prompt).toContain('NOT KarkeDikha');
  });
});

describe('reply grounding', () => {
  const ev = gatherProjectEvidence(pyRoot);
  it('rejects a reply that asks which project', () => {
    expect(isReplyGroundedInProject('Could you please specify which project you are referring to?', ev)).toBe(false);
  });
  it("rejects a reply that substitutes Pandesh's identity for the project", () => {
    expect(isReplyGroundedInProject('This project is KarkeDikha, a personal AI assistant.', ev)).toBe(false);
  });
  it('accepts a reply grounded in the project', () => {
    expect(isReplyGroundedInProject('Sketcher turns prompts into pencil drawings (README.md).', ev)).toBe(true);
  });
  it('the evidence-only fallback is itself grounded', () => {
    for (const q of ['What does this project do?', 'What language is it written in?', 'How do I run it?']) {
      expect(isReplyGroundedInProject(composeEvidenceAnswer(ev, q), ev)).toBe(true);
    }
  });
});

describe('local-only model endpoint', () => {
  it('accepts loopback and refuses remote hosts and cloud models', () => {
    expect(isLocalModelEndpoint('http://127.0.0.1:11434', 'qwen3:8b')).toBe(true);
    expect(isLocalModelEndpoint('http://localhost:11434', 'gemma')).toBe(true);
    expect(isLocalModelEndpoint('https://ollama.com', 'qwen3:8b')).toBe(false);
    expect(isLocalModelEndpoint('http://127.0.0.1:11434', 'gpt-oss:120b-cloud')).toBe(false);
  });
});

const IMAGEGEN = 'C:\\Projects\\ImageGeneration';
const JOBFINDER = 'C:\\Projects\\JobFinder';
describe.skipIf(!fs.existsSync(IMAGEGEN) || !fs.existsSync(JOBFINDER))('real workspaces on this machine', () => {
  it('ImageGeneration evidence comes from ImageGeneration, and a switch to another workspace changes it', () => {
    const a = gatherProjectEvidence(IMAGEGEN);
    const b = gatherProjectEvidence(JOBFINDER);
    expect(a.name).toBe('ImageGeneration');
    expect(a.languages[0].language).toBe('Python');
    expect(a.filesRead.map((f) => f.path)).toEqual(expect.arrayContaining(['README.md', 'requirements.txt']));
    expect(b.name).toBe('JobFinder');
    expect(b.root).not.toBe(a.root);
    expect(formatProjectEvidenceForModel(b)).not.toContain('ImageGeneration');
    expect(formatProjectEvidenceForModel(a)).not.toContain('JobFinder');
  });
});

describe('questions about Pandesh itself', () => {
  // 2026-11-10: "Where can I set up my Google credentials in this app?" was refused as "no active project to inspect"
  // when no workspace was selected, before the model saw it. "This app" with Pandesh's own setup words is Pandesh.
  it('are not project inspections, while questions about a project still are', () => {
    expect(isProjectInspectionRequest('Where can I set up my Google credentials in this app?')).toBe(false);
    expect(isProjectInspectionRequest('How do I connect my calendar in this app?')).toBe(false);
    expect(isProjectInspectionRequest('Where are the permission settings in this app?')).toBe(false);
    expect(isProjectInspectionRequest('What does this project do?')).toBe(true);
    expect(isProjectInspectionRequest('How do I run this app?')).toBe(true);
  });
});
