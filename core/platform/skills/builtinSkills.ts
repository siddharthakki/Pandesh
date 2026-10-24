/**
 * Built-in skills. The six cloud invocation skills are host-side behaviours (their implementations are in
 * core/platform/cloudSkills.ts and the Core cloud backend); here they are first-class registry entries so Setup, resolution
 * and diagnostics see one uniform skill model. A few procedural skills show the Capability/Tool/Skill split.
 */
import type { SkillManifest } from './skillRuntime';

const BUILTIN_PROVENANCE = { origin: 'builtin', hash: 'builtin', loadedAt: '2026-10-06T00:00:00.000Z' } as const;

function skill(partial: Partial<SkillManifest> & Pick<SkillManifest, 'id' | 'name' | 'description'>): SkillManifest {
  return {
    version: '1.0.0', kind: 'procedure', source: 'builtin', trust: 'builtin', provenance: { ...BUILTIN_PROVENANCE },
    tags: [], intents: [], taskClasses: [], requires: { capabilities: [] }, validation: [], hostHooks: [], body: '', flags: [],
    ...partial,
  };
}

export const BUILTIN_SKILLS: readonly SkillManifest[] = [
  skill({ id: 'cloud-token-budget', name: 'Cloud token budget', description: 'Deduplicate history, trim old turns and reserve output budget before any cloud call.', kind: 'host-hook', hostHooks: ['cloud-token-budget'], tags: ['cloud', 'tokens', 'cost', 'context'], taskClasses: ['general'] }),
  skill({ id: 'cloud-cost-guard', name: 'Cloud cost guard', description: 'Enforce the spend policy and per-task request and token ceilings for cloud models.', kind: 'host-hook', hostHooks: ['cloud-cost-guard'], tags: ['cloud', 'cost', 'quota', 'free'], taskClasses: ['general'] }),
  skill({ id: 'cloud-tool-discipline', name: 'Cloud tool discipline', description: 'Stop duplicate reads and runaway tool-call counts on cloud models.', kind: 'host-hook', hostHooks: ['cloud-tool-discipline'], tags: ['cloud', 'tools', 'duplicate'], taskClasses: ['general'] }),
  skill({ id: 'evidence-before-claim', name: 'Evidence before claim', description: 'Cross-check claims such as tests passed or file created against recorded evidence.', kind: 'host-hook', hostHooks: ['evidence-before-claim'], tags: ['evidence', 'claims', 'verify'], taskClasses: ['general'] }),
  skill({ id: 'objective-completion', name: 'Objective completion', description: 'An objective is complete only when every required target has recorded evidence.', kind: 'host-hook', hostHooks: ['objective-completion'], tags: ['complete', 'objective', 'targets'], taskClasses: ['create', 'refactor', 'general'] }),
  skill({
    id: 'grounded-repository-answer', name: 'Grounded repository answer',
    description: 'Answer repository questions only from supplied evidence, labelling what is known, derived, inferred or unknown.',
    kind: 'host-hook', hostHooks: ['grounded-repository-answer'], tags: ['repository', 'grounded', 'evidence', 'architecture'], taskClasses: ['explain', 'review'],
    requires: { capabilities: ['workspace.read'], workspace: true },
  }),
  skill({
    id: 'debug-web-application', name: 'Debug web application',
    description: 'Reproduce a web application bug in a browser, inspect the page, fix the code, and verify again.',
    tags: ['web', 'browser', 'frontend', 'bug', 'localhost'], intents: ['debug the web app', 'fix the page', 'reproduce in the browser'], taskClasses: ['debug', 'browser'],
    requires: { capabilities: ['workspace.read', 'workspace.write', 'terminal.execute', 'browser.navigate', 'browser.inspect'], browser: true, workspace: true },
    validation: ['tests_passed'],
    body: '1. Start the app through the governed run target and open its local URL.\n2. Reproduce the problem; capture a screenshot and the relevant DOM text as before-evidence.\n3. Locate the responsible source with repository search, read it, and make the smallest fix.\n4. Re-run the app, repeat the steps, and capture after-evidence.\n5. Run the project tests; report only what the recorded results show.',
  }),
  skill({
    id: 'fix-failing-test', name: 'Fix a failing test',
    description: 'Run the failing test, read the error and the code under test, fix the cause, and re-run.',
    tags: ['test', 'failure', 'assertion', 'regression'], intents: ['fix the failing test', 'tests are failing'], taskClasses: ['debug', 'test'],
    requires: { capabilities: ['workspace.read', 'workspace.write', 'terminal.execute'], workspace: true },
    validation: ['tests_passed'],
    body: '1. Run only the failing test and read its exact error.\n2. Read the test and the code it exercises; decide whether the test or the code is wrong.\n3. Change the smallest thing that fixes the cause (not the symptom).\n4. Re-run the test, then the surrounding suite. Do not claim success without a green run.',
  }),
  skill({
    id: 'explain-architecture', name: 'Explain architecture',
    description: 'Explain how a codebase or subsystem is organised from manifests, entry points and imports.',
    tags: ['architecture', 'overview', 'structure', 'modules'], intents: ['how is this organised', 'explain the architecture'], taskClasses: ['explain'],
    requires: { capabilities: ['workspace.read'], workspace: true },
    body: 'Start from manifests and entry points, follow imports to the modules the question is about, and cite files by path. Separate what the files show from what you infer. Say what you did not read.',
  }),
  skill({
    id: 'analyze-image', name: 'Analyze an image',
    description: 'Describe and analyse an attached screenshot, diagram or mockup using a vision-capable model.',
    tags: ['image', 'screenshot', 'diagram', 'mockup', 'vision'], intents: ['what is in this image', 'look at this screenshot'], taskClasses: ['explain', 'debug', 'general'],
    requires: { capabilities: [], vision: true },
    body: 'Describe only what is visible. Quote visible text exactly. For error screenshots, identify the message and the likely failing component, and say what is not visible.',
  }),
];
