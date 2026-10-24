import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  OPENROUTER_API_KEY_ENV,
  OpenRouterCredentialError,
  clearOpenRouterApiKey,
  loadOpenRouterApiKey,
  openRouterApiKeyPath,
  openRouterApiKeyPresent,
  redactSensitiveEnv,
  storeOpenRouterApiKey,
  type SecretBox,
} from '../src/host/openRouterCredential';
import {
  OPENROUTER_OFFICIAL_API_BASE,
  openRouterModelsUrl,
  probeOpenRouterModels,
  requireOpenRouterSelection,
  resolveOpenRouterConfig,
} from '../src/host/desktopConfig';
import { DESKTOP_CHANNELS, RENDERER_VISIBLE_KEYS, type DesktopSnapshot } from '../src/ipc';

function memoryBox(available = true): SecretBox {
  return {
    isEncryptionAvailable: () => available,
    encryptString: (plain) => Buffer.from(JSON.stringify({ v: 1, p: Buffer.from(plain, 'utf8').toString('base64') }), 'utf8'),
    decryptString: (cipher) => {
      const parsed = JSON.parse(cipher.toString('utf8')) as { p?: string };
      if (typeof parsed.p !== 'string') throw new Error('undecryptable');
      return Buffer.from(parsed.p, 'base64').toString('utf8');
    },
  };
}

function emptyOpenRouterSnapshot(extra: Partial<DesktopSnapshot['openRouter']> = {}): DesktopSnapshot {
  return {
    coreState: 'connected',
    folder: 'C:\\tmp\\repo',
    model: 'qwen3.8:27b-mtp-q4_K_M',
    modelIsAuto: false,
    modelAvailable: true,
    selectedInferenceProvider: 'ollama',
    installedModels: [],
    provider: 'ollama',
    routingPolicy: 'local-only',
    apiBase: 'http://127.0.0.1:11434',
    attemptId: null,
    requestId: null,
    task: null,
    running: false,
    awaitingApproval: false,
    pendingApproval: null,
    taskScope: null,
    cockpit: {
      requestId: null,
      attemptId: null,
      running: false,
      terminal: false,
      phase: 'investigation',
      currentAction: null,
      startedAt: null,
      elapsedMs: 0,
      remainingAbsoluteMs: 0,
      productiveUsed: 0,
      phaseAllowance: 0,
      repairCycle: 0,
      filesRead: [],
      filesChanged: [],
      validationStatus: '',
      verificationStatus: '',
      checkpoints: [],
      diagnostics: [],
      metrics: {
        aiResponses: 0,
        promptTokens: null,
        generatedTokens: null,
        generationRate: null,
        cloudCostAvoidedUsd: null,
        actualSpendUsd: null,
        spendCapUsd: null,
        comparison: {
          model: 'x',
          inputUsdPerMTok: 0,
          outputUsdPerMTok: 0,
          verifiedOn: '',
          source: '',
          exclusions: '',
        },
      },
      finalOutcome: null,
      authState: 'none',
      pendingApproval: null,
      approvedApproval: null,
    },
    workers: [],
    selectedWorker: 'local-core',
    activeWorker: null,
    openRouter: {
      keyConfigured: false,
      apiBase: OPENROUTER_OFFICIAL_API_BASE,
      model: null,
      maxUsd: null,
      submissionReady: false,
      statusDetail: 'OpenRouter cloud submission is not ready; use Ollama (local-only).',
      ...extra,
    },
    localSpeech: {
      capability: 'available',
      engine: 'whisper-base.en',
      blocker: '',
    },
    localSpeechResponse: {
      capability: 'unavailable_no_local_engine',
      engine: null,
      blocker: 'Piper TTS is not staged in this Desktop build.',
      voices: [],
    },
    wakeWord: {
      capability: 'unavailable_no_local_engine',
      engine: null,
      blocker: 'openWakeWord not staged',
      phrase: 'Hey Jarvis',
      enabled: false,
      muted: false,
    },
    wakeDiagnostics: {
      engineReady: false,
      captureActive: false,
      captureError: '',
      contextSampleRate: null,
      trackLabel: '',
      micRms: 0,
      framesReceived: 0,
      lastScore: 0,
      peakScore: 0,
      lastScoreAt: null,
      lastDetectedAt: null,
      lastDetectedScore: null,
      threshold: 0.45,
      thresholdCrossings: 0,
      approachCount: 0,
      framesSinceReset: 0,
      readyForDetect: false,
      wakeDetectMs: null,
      lastInferenceMs: null,
      monitorStartedAt: null,
      recentScores: [],
    },
    voiceMode: true,
    speaking: false,
    interactionMode: 'local_core',
    lastTurnOutcome: null,
    turnOutcomeKind: null,
    blockedReason: null,
    speechInterrupt: {
      buttonStop: false,
      spokenBargeIn: false,
      spokenBargeInBlocker: '',
    },
    hostTelemetry: null,
    everydayTools: {
      timezone: 'UTC',
      alertsWhileClosed: true,
      alertsWhileClosedDetail: 'Desktop alerts fire while Jarvis is running (window visible or hidden in the tray). Alerts do not fire after Quit, while the computer is asleep, or while the computer is off.',
      catalog: [],
      notes: [],
      reminders: [],
      dueReminders: [],
    },
    commandQueue: {
      active: null,
      confirming: null,
      waiting: [],
      recentTerminal: [],
    },
    gmail: { connected: false, accountEmail: null, lastError: null, lastRefreshedAt: null, configBlocker: null, capabilityBlocker: null },
    selectedConversationId: null,
    activeConversationId: null,
  };
}

describe('OpenRouter host credential store', () => {
  it('encrypts the key on disk and never returns ciphertext as plaintext', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kd-or-cred-'));
    const secret = 'or-test-secret-value-not-for-logs';
    storeOpenRouterApiKey(dir, secret, memoryBox());
    const onDisk = fs.readFileSync(openRouterApiKeyPath(dir));
    expect(onDisk.toString('utf8')).not.toContain(secret);
    expect(loadOpenRouterApiKey(dir, memoryBox())).toBe(secret);
    expect(openRouterApiKeyPresent(dir)).toBe(true);
    clearOpenRouterApiKey(dir);
    expect(loadOpenRouterApiKey(dir, memoryBox())).toBeNull();
    expect(openRouterApiKeyPresent(dir)).toBe(false);
  });

  it('refuses persistence when OS-backed encryption is unavailable', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kd-or-noenc-'));
    expect(() => storeOpenRouterApiKey(dir, 'sk-test', memoryBox(false)))
      .toThrow(OpenRouterCredentialError);
    expect(openRouterApiKeyPresent(dir)).toBe(false);
  });

  it('redacts the key from env dumps and renderer-visible snapshot keys', () => {
    const secret = 'sk-or-redact-me-please';
    const redacted = redactSensitiveEnv({
      KARKEDIKHA_CORE_TOKEN: 'core-token-value',
      [OPENROUTER_API_KEY_ENV]: secret,
      KARKEDIKHA_OPENROUTER_MODEL: 'openai/gpt-5.6-sol',
    });
    expect(JSON.stringify(redacted)).not.toContain(secret);
    expect(JSON.stringify(redacted)).not.toContain('core-token-value');
    expect(redacted[OPENROUTER_API_KEY_ENV]).toBe('[redacted]');
    expect(redacted.KARKEDIKHA_OPENROUTER_MODEL).toBe('openai/gpt-5.6-sol');

    expect(DESKTOP_CHANNELS.setOpenRouterApiKey).toBe('desktop:setOpenRouterApiKey');
    expect(DESKTOP_CHANNELS.clearOpenRouterApiKey).toBe('desktop:clearOpenRouterApiKey');
    expect(RENDERER_VISIBLE_KEYS).toContain('openRouter');
    expect(RENDERER_VISIBLE_KEYS).not.toContain('token');
    expect(RENDERER_VISIBLE_KEYS.join(',')).not.toMatch(/secret|token|authorization|apiKey|api-key/i);

    const snapshot = emptyOpenRouterSnapshot({
      keyConfigured: true,
      model: 'openai/gpt-5.6-sol',
      maxUsd: 1.5,
    });
    const serialized = JSON.stringify(snapshot);
    expect(serialized).not.toContain(secret);
    expect(serialized).not.toMatch(/Bearer /i);
    expect(serialized).toContain('"keyConfigured":true');
    expect(snapshot.openRouter.apiBase).toBe(OPENROUTER_OFFICIAL_API_BASE);
  });
});

describe('OpenRouter non-secret settings', () => {
  it('uses the fixed official API base and ignores cloud-fallback settings', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kd-or-cfg-'));
    const product = path.join(root, 'product');
    fs.mkdirSync(path.join(product, '.vscode'), { recursive: true });
    fs.writeFileSync(path.join(product, '.vscode', 'settings.json'), JSON.stringify({
      'ollama-agent.cloudFallbackModel': 'should-not-win',
      'ollama-agent.cloudFallbackApiBase': 'https://api.orcarouter.ai/v1',
      'ollama-agent.openRouterModel': 'openai/gpt-5.6-sol',
      'ollama-agent.openRouterMaxUsd': 2.5,
      'ollama-agent.openRouterApiBase': 'https://evil.example/v1',
    }));

    const resolved = resolveOpenRouterConfig({
      productRoot: product,
      homedir: root,
      appdata: path.join(root, 'appdata'),
      env: {},
    });
    expect(resolved.apiBase).toBe(OPENROUTER_OFFICIAL_API_BASE);
    expect(resolved.model).toBe('openai/gpt-5.6-sol');
    expect(resolved.maxUsd).toBe(2.5);
    expect(resolved.model).not.toBe('should-not-win');
  });

  it('fails closed for missing key, model, or non-positive cap', () => {
    const base = {
      apiBase: OPENROUTER_OFFICIAL_API_BASE,
      model: 'openai/gpt-5.6-sol',
      maxUsd: 1,
      source: 'test',
    } as const;
    expect(() => requireOpenRouterSelection({ ...base, model: null }, true)).toThrow(/model is required/);
    expect(() => requireOpenRouterSelection({ ...base, maxUsd: 0 }, true)).toThrow(/positive finite/);
    expect(() => requireOpenRouterSelection({ ...base, maxUsd: null }, true)).toThrow(/positive finite/);
    expect(() => requireOpenRouterSelection(base, false)).toThrow(/API key is not stored/);
    expect(requireOpenRouterSelection(base, true)).toEqual({
      apiBase: OPENROUTER_OFFICIAL_API_BASE,
      model: 'openai/gpt-5.6-sol',
      maxUsd: 1,
    });
  });

  it('health-checks GET /models with an injected fake client and never generates', async () => {
    let called = '';
    await probeOpenRouterModels('test-key', async (input, init) => {
      called = String(input);
      expect((init?.headers as Record<string, string>).Authorization).toBe('Bearer test-key');
      expect(called).toBe(openRouterModelsUrl());
      expect(called).not.toContain('chat/completions');
      return new Response(JSON.stringify({ data: [{ id: 'openai/gpt-5.6-sol' }] }), { status: 200 });
    });
    expect(called).toBe('https://openrouter.ai/api/v1/models');
  });
});
