import recorded from './fixtures/att-8e2b1136-activity.json';
import type { DesktopActivityEvent, DesktopSnapshot } from '../src/ipc';
import { projectMissionCockpit, type CockpitProjectionInput } from '../src/host/missionCockpit';
import { WORKER_OPTIONS } from '../../../core/runtime/localCoreQuestion';

export const RECORDED_REQUEST = recorded.requestId;
export const RECORDED_ATTEMPT = recorded.attemptId;
export const RECORDED_START = recorded.startedAt;
export const RECORDED_TERMINAL_AT = recorded.terminalAt;
export const RECORDED_RESULT = recorded.result;

const FILES = ['src/app.js', 'index.html', 'src/books.js', 'styles.css', 'package.json', 'tests/books.test.js'];

/** Regression fixture matching the reported defect exactly: a long Python
 * to-do application plus explanatory prose, returned as a plain-text chat
 * reply (no file actually written). Used to prove the full response lands
 * only in the conversation pane, never the bounded event stream. */
export const LONG_PYTHON_TODO_RESPONSE = `Here's a simple command-line to-do app in Python:

\`\`\`python
import json
import os

TODO_FILE = "todos.json"


def load_todos():
    if not os.path.exists(TODO_FILE):
        return []
    with open(TODO_FILE, "r") as f:
        return json.load(f)


def save_todos(todos):
    with open(TODO_FILE, "w") as f:
        json.dump(todos, f, indent=2)


def add_todo(todos, text):
    todos.append({"text": text, "done": False})
    save_todos(todos)


def complete_todo(todos, index):
    if 0 <= index < len(todos):
        todos[index]["done"] = True
        save_todos(todos)


def list_todos(todos):
    for i, todo in enumerate(todos):
        mark = "x" if todo["done"] else " "
        print(f"[{mark}] {i}: {todo['text']}")


def main():
    todos = load_todos()
    while True:
        command = input("todo> ").strip()
        if command == "quit":
            break
        elif command == "list":
            list_todos(todos)
        elif command.startswith("add "):
            add_todo(todos, command[4:])
        elif command.startswith("done "):
            complete_todo(todos, int(command[5:]))


if __name__ == "__main__":
    main()
\`\`\`

This stores todos in a local \`todos.json\` file. Run it with \`python todo.py\`, then use \`add <text>\`, \`done <index>\`, \`list\`, and \`quit\`. I did not create this file for you — copy it into a \`.py\` file yourself if you'd like to use it, or ask me to create it in a selected repository.`;

export function eventFromSummary(
  summary: string,
  at: string,
  extra: Partial<DesktopActivityEvent> = {},
): DesktopActivityEvent {
  const started = summary.match(/^tool start: ([^\s{]+)/);
  const finished = summary.match(/^tool (succeeded|failed|cancelled): ([^\s]+)/);
  const eventType = summary.includes('model_invocation_started')
    ? 'model_invocation_started'
    : summary.includes('model_invocation_completed')
      ? 'model_invocation_completed'
      : summary.includes('attempt_transitioned')
        ? 'attempt_transitioned'
        : summary.includes('attempt_failed')
          ? 'attempt_failed'
          : started
            ? 'tool_invocation_started'
            : finished
              ? 'tool_invocation_completed'
              : extra.eventType;
  const kind: DesktopActivityEvent['kind'] = summary.startsWith('Waiting for')
    ? 'approval'
    : summary === RECORDED_RESULT || summary.startsWith('exceeded ')
      ? 'error'
      : extra.kind ?? 'activity';
  return {
    ...extra,
    kind,
    at,
    attemptId: extra.attemptId ?? RECORDED_ATTEMPT,
    requestId: extra.requestId ?? RECORDED_REQUEST,
    eventType: extra.eventType ?? eventType,
    toolName: extra.toolName ?? started?.[1] ?? (finished?.[2] !== 'unknown_tool' ? finished?.[2] : undefined),
    summary,
  };
}

export function eventsFromSummaries(summaries: readonly string[], startIso: string, endIso: string): DesktopActivityEvent[] {
  const start = Date.parse(startIso);
  const end = Date.parse(endIso);
  const last = Math.max(1, summaries.length - 1);
  return summaries.map((summary, index) => {
    const at = new Date(start + Math.round(((end - start) * index) / last)).toISOString();
    return eventFromSummary(summary, at);
  });
}

/** Recorded att_8e2b1136 UI stream, padded to 120 events with the same pairing pattern. */
export function recorded120(): DesktopActivityEvent[] {
  const recordedEvents = eventsFromSummaries(recorded.summaries, RECORDED_START, RECORDED_TERMINAL_AT);
  const validationAt = recordedEvents.findIndex((event) => event.summary.includes('workspace_validation'));
  const head = validationAt >= 0 ? recordedEvents.slice(0, validationAt) : recordedEvents.slice(0, -2);
  const tail = validationAt >= 0 ? recordedEvents.slice(validationAt) : recordedEvents.slice(-2);
  const pad: DesktopActivityEvent[] = [];
  let cursor = Date.parse(head[head.length - 1]?.at ?? RECORDED_START);
  let i = 0;
  const needed = Math.max(0, 120 - head.length - tail.length);
  while (pad.length < needed) {
    const file = FILES[i % FILES.length];
    const cached = i > 4 && i % 3 === 0;
    const cycle: DesktopActivityEvent[] = [
      eventFromSummary('model_invocation:model_invocation_started', new Date(cursor += 1_200).toISOString(), {
        eventType: 'model_invocation_started',
        promptTokens: 800,
      }),
      eventFromSummary('model_invocation:model_invocation_completed', new Date(cursor += 1_800).toISOString(), {
        eventType: 'model_invocation_completed',
        promptTokens: 800,
        completionTokens: 120,
      }),
      eventFromSummary(
        `tool start: read_file ${JSON.stringify({ path: file, cached })}`,
        new Date(cursor += 200).toISOString(),
        { eventType: 'tool_invocation_started', toolName: 'read_file' },
      ),
      eventFromSummary(
        `tool succeeded: read_file ${file}`,
        new Date(cursor += 150).toISOString(),
        { eventType: 'tool_invocation_completed', toolName: 'read_file' },
      ),
    ];
    pad.push(...cycle.slice(0, needed - pad.length));
    i += 1;
  }
  const merged = [...head, ...pad, ...tail];
  return eventsFromSummaries(merged.map((event) => event.summary), RECORDED_START, RECORDED_TERMINAL_AT).map((event, index) => ({
    ...merged[index],
    at: event.at,
  }));
}

export const APPROVED_CARD = {
  approvalId: 'appr_1',
  gate: 'mutation',
  toolName: 'authorize_mission',
  scope: 'Authorize autonomous mission',
  paths: [] as string[],
  detail: 'Repository: reading-list\nDenied: push, network',
};

export function cockpitInput(overrides: Partial<CockpitProjectionInput> = {}): CockpitProjectionInput {
  return {
    requestId: RECORDED_REQUEST,
    attemptId: RECORDED_ATTEMPT,
    running: true,
    terminal: false,
    pendingApproval: null,
    approvedApproval: APPROVED_CARD,
    startedAt: RECORDED_START,
    nowMs: Date.parse(RECORDED_START) + 10 * 60_000,
    ...overrides,
  };
}

export function desktopSnapshotFromEvents(
  events: readonly DesktopActivityEvent[],
  input: CockpitProjectionInput,
  extra: Partial<DesktopSnapshot> = {},
): DesktopSnapshot {
  const cockpit = projectMissionCockpit(events, input);
  return {
    coreState: 'connected',
    folder: 'C:\\Projects\\ollama-agent\\.tmp\\desktop-reading-list-journey-5',
    model: 'qwen3.8:27b-mtp-q4_K_M',
    modelIsAuto: false,
    modelAvailable: true,
    selectedInferenceProvider: 'ollama',
    provider: 'ollama',
    routingPolicy: 'local-only',
    apiBase: 'http://127.0.0.1:11434',
    attemptId: input.attemptId,
    requestId: input.requestId,
    task: 'Add All, Unread, and Read filters to the reading list.',
    running: input.running,
    awaitingApproval: Boolean(input.pendingApproval),
    pendingApproval: input.pendingApproval,
    taskScope: {
      repository: 'reading-list',
      permittedActions: ['read_file', 'search'],
      deliveryDestination: 'local git commit',
      pushAuthorized: false,
      authorized: true,
    },
    workers: WORKER_OPTIONS.map((option) => ({ ...option })),
    selectedWorker: 'autonomous-mission',
    activeWorker: 'autonomous-mission',
    openRouter: {
      keyConfigured: false,
      apiBase: 'https://openrouter.ai/api/v1',
      model: null,
      maxUsd: null,
      submissionReady: false,
      statusDetail: 'OpenRouter cloud submission is not ready; use Ollama (local-only).',
    },
    localSpeech: {
      capability: 'available',
      engine: 'whisper-base.en (@xenova/transformers, quantized ONNX, local, WASM)',
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
    installedModels: ['qwen3.8:27b-mtp-q4_K_M'],
    cockpit,
    gmail: { connected: false, accountEmail: null, lastError: null, lastRefreshedAt: null, configBlocker: null, capabilityBlocker: null },
    selectedConversationId: null,
    activeConversationId: null,
    ...extra,
  };
}
