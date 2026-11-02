/**
 * Regression: an explicit local model stays exact, an app-building request is never turned into an
 * image-generation job, and no host placeholder conversation id leaks to the UI.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { DesktopSession } from '../src/host/desktopSession';
import { detectImageGenerationIntent, detectImageFollowUp, detectVideoGenerationIntent, isPlaceholderConversationId } from '../src/host/desktopInteractionRouting';

const GEMMA = 'gemma4:26b-a4b-it-qat';
const ORIGAMI = 'Build a small app that takes an image as input and generates step-by-step origami instructions.';
const ORIGAMI_GENERATE = 'Create an app that can generate an image of each origami fold from a photo';

let dataDir: string; let host: DesktopSession; let submits: Array<Record<string, any>>;
type Internals = { client: unknown; coreState: string; provider: unknown; modelAvailable: boolean; installedModels: string[]; operatorSelectedModel: string; refreshProvider(): void; refreshProviderSoft(): void; refreshModelAvailability(): Promise<void>; handleImageGenerationIntent: (...a: unknown[]) => unknown };

beforeEach(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'panda-routing-regression-'));
  submits = [];
  host = new DesktopSession({ productRoot: process.cwd(), dataDir });
  const internal = host as unknown as Internals;
  internal.client = {
    createConversation: async () => ({ id: 'conv-1' }),
    submit: async (input: Record<string, any>) => { submits.push(input); return { request: { id: 'req-1' }, attempt: { id: 'att-1' }, planningOnly: false, messageId: 'm1', modelSelection: input.modelSelection }; },
    listArtifacts: async () => ({ artifacts: [] }),
    executeAttempt: async () => ({}),
  };
  internal.coreState = 'connected';
  internal.provider = { model: GEMMA, apiBase: 'http://127.0.0.1:11434', source: 'test' };
  internal.modelAvailable = true;
  internal.installedModels = [GEMMA, 'gemma4:12b'];
  internal.operatorSelectedModel = GEMMA;
  vi.spyOn(internal, 'refreshProvider').mockImplementation(() => undefined);
  vi.spyOn(internal, 'refreshProviderSoft').mockImplementation(() => undefined);
  vi.spyOn(internal, 'refreshModelAvailability').mockResolvedValue(undefined);
});
afterEach(() => { vi.unstubAllGlobals(); fs.rmSync(dataDir, { recursive: true, force: true }); });

describe('keyword shortcuts yield to software-build intent', () => {
  it.each([ORIGAMI, ORIGAMI_GENERATE])('does not treat "%s" as a media request', (text) => {
    expect(detectImageGenerationIntent(text)).toBe(false);
    expect(detectImageFollowUp(text)).toBeNull();
    expect(detectVideoGenerationIntent(text)).toBe(false);
  });
  it('still recognises genuine image requests', () => {
    expect(detectImageGenerationIntent('Generate an image of an origami crane')).toBe(true);
    expect(detectImageGenerationIntent('draw a picture of a fox in the snow')).toBe(true);
    expect(detectImageGenerationIntent('Create an app icon image for my notes app')).toBe(true);
  });
});

describe('explicit model selection through the desktop host', () => {
  it.each([['chat', 'Hello there'], ['app building', ORIGAMI]])('%s: submits the exact selected model as a manual choice and never opens Image Studio', async (_l, text) => {
    const imageSpy = vi.spyOn(host as unknown as Internals, 'handleImageGenerationIntent');
    await host.submitTask(text);
    expect(imageSpy).not.toHaveBeenCalled();
    expect(submits).toHaveLength(1);
    expect(submits[0].requestedModel).toBe(GEMMA);
    expect(submits[0].modelSelection.selectedModel).toBe(GEMMA);
    expect(submits[0].modelSelection.userOverrode).toBe(true);
    expect(submits[0].autoSelectModel).toBeUndefined();
  });

  it('an app-building request with media words and no repository is blocked for a workspace, never routed to Image Studio', async () => {
    const imageSpy = vi.spyOn(host as unknown as Internals, 'handleImageGenerationIntent');
    await expect(host.submitTask(ORIGAMI_GENERATE)).rejects.toThrow(/Select a repository/);
    expect(imageSpy).not.toHaveBeenCalled();
    expect(submits).toHaveLength(0);
  });

  it('a genuine image request still goes to Image Studio', async () => {
    const imageSpy = vi.spyOn(host as unknown as Internals, 'handleImageGenerationIntent').mockResolvedValue({ requestId: 'r', attemptId: 'a', model: 'image-studio' });
    await host.submitTask('Generate an image of an origami crane');
    expect(imageSpy).toHaveBeenCalledTimes(1);
    expect(submits).toHaveLength(0);
  });
});

describe('placeholder conversation ids', () => {
  it('identifies host-side image placeholders and never exposes one as the active conversation', () => {
    expect(isPlaceholderConversationId('image_1730000000000')).toBe(true);
    expect(isPlaceholderConversationId('conv_abc')).toBe(false);
    (host as unknown as { active: unknown }).active = { attemptId: 'image_att_1', requestId: 'image_req_1', conversationId: 'image_1730000000000', goal: 'x', tokenBuffer: '', terminal: false };
    expect(host.snapshot().activeConversationId).toBeNull();
    (host as unknown as { active: unknown }).active = { attemptId: 'att', requestId: 'req', conversationId: 'conv_real', goal: 'x', tokenBuffer: '', terminal: false };
    expect(host.snapshot().activeConversationId).toBe('conv_real');
  });
});
