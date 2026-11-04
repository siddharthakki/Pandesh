import { describe, expect, it } from 'vitest';
import { hasSoftwareBuildIntent, checkDeliveredOutcome } from '../domain/softwareIntent';
import { deriveToolSurface } from '../domain/taskToolSurface';

const ORIGAMI = 'Build a small app that takes an image as input and generates step-by-step origami instructions.';

describe('software-build intent', () => {
  it.each([
    ORIGAMI,
    'Create a web app that can generate images from text',
    'Please develop a simple tool to draw pictures of cats',
    'I need an app that renders a logo for my shop',
    'Make a small CLI that creates a photo collage',
  ])('recognises %s', (text) => expect(hasSoftwareBuildIntent(text)).toBe(true));

  it.each([
    'Generate an image of a red fox at sunset',
    'Create an app icon image for my notes app',
    'Draw a logo for the website',
    'Make a poster of a mountain landscape',
    'What is the weather today?',
  ])('does not treat %s as a build request', (text) => expect(hasSoftwareBuildIntent(text)).toBe(false));

  it('keeps the full tool surface for real image generation but not for building an app that mentions images', () => {
    const base = { mutationPolicy: 'allowed' as never, fileModificationRequired: true, hasWorkspace: true };
    expect(deriveToolSurface({ ...base, objectiveText: 'generate an image of a fox' }).reason).toBe('objective_mentions_image');
    expect(deriveToolSurface({ ...base, objectiveText: 'Build an app that can generate an image of a fox' }).surface).toBe('workspace_code_change');
  });

  it('never accepts generated media as the delivered outcome of a build request', () => {
    expect(checkDeliveredOutcome(ORIGAMI, [{ kind: 'image' }]).satisfied).toBe(false);
    expect(checkDeliveredOutcome(ORIGAMI, []).satisfied).toBe(false);
    expect(checkDeliveredOutcome(ORIGAMI, [{ kind: 'image' }, { kind: 'source_file' }]).satisfied).toBe(true);
    expect(checkDeliveredOutcome('generate an image of a fox', [{ kind: 'image' }]).satisfied).toBe(true);
  });
});
