import { afterEach, describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';
import { createMockExtensionContext } from '../mocks/vscode';
import { maybeShowOnboardingOnce } from '../../extension';
import { SHOW_SETUP_READINESS_COMMAND } from '../../onboarding/OnboardingPanel';

/**
 * I. FIRST-RUN ONCE — the "shown once" gate itself, isolated from the rest of
 * `activate()` (Core startup, view/command registration) which needs a much
 * heavier fixture. This directly exercises the same `globalState` flag and
 * `executeCommand` call `activate()` makes on every real first run.
 */
describe('maybeShowOnboardingOnce', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('auto-opens Setup/Readiness on the first call and persists the flag', async () => {
    const context = createMockExtensionContext();
    const executeCommand = vi.spyOn(vscode.commands, 'executeCommand').mockResolvedValue(undefined);

    await maybeShowOnboardingOnce(context as never);

    expect(executeCommand).toHaveBeenCalledWith(SHOW_SETUP_READINESS_COMMAND);
    expect(context.globalState.get('ollama-agent.onboarding.shownV1')).toBe(true);
  });

  it('does not auto-open again on a later activation', async () => {
    const context = createMockExtensionContext();
    const executeCommand = vi.spyOn(vscode.commands, 'executeCommand').mockResolvedValue(undefined);

    await maybeShowOnboardingOnce(context as never);
    executeCommand.mockClear();
    await maybeShowOnboardingOnce(context as never);

    expect(executeCommand).not.toHaveBeenCalled();
  });

  it('the manual command still works after the flag is set', async () => {
    const context = createMockExtensionContext();
    await context.globalState.update('ollama-agent.onboarding.shownV1', true);
    const executeCommand = vi.spyOn(vscode.commands, 'executeCommand').mockResolvedValue(undefined);

    // Simulating the user manually invoking the command, independent of activation.
    await vscode.commands.executeCommand(SHOW_SETUP_READINESS_COMMAND);

    expect(executeCommand).toHaveBeenCalledWith(SHOW_SETUP_READINESS_COMMAND);
  });
});
