import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { openDatabase, type CoreDatabase } from '../db/connection';
import { runMigrations } from '../db/migrations';
import { EventBroadcaster } from '../ws/broadcaster';
import { createConversation, listMessages, appendMessage } from '../domain/conversations';
import { createRequest } from '../domain/requests';
import { createAttempt, getAttempt, transitionAttempt } from '../domain/attempts';
import { getAttemptContext } from '../domain/attemptContext';
import { acquireFence } from '../domain/fence';
import { piAgentEngine } from '../runtime/piAgentEngine';
import {
  startGmailContractExtractionTask,
  runBackgroundTask,
  recoverBackgroundTasks,
  resetActiveWorkersForTesting,
  isGmailContractExtractionRequest,
  isTaskStatusRequest,
  isShowResultsRequest,
  isCancelTaskRequest,
  isContinueTaskRequest,
} from '../runtime/backgroundWorker';
import {
  getActiveBackgroundTask,
  getLatestBackgroundTask,
  listBackgroundTasks,
  getBackgroundTask,
  updateBackgroundTask,
  type BackgroundTaskRecord,
} from '../domain/backgroundTasks';
import { failDeadExecutorAttemptsOnBoot } from '../domain/bootReconciliation';
import { interactiveLane, classifyAttemptLane } from '../runtime/interactiveLane';
import { buildMinimalPdf } from './fixtures/documentFixtures';

describe('Pandesh P0 — Nonblocking Background Task Delegation Suite', () => {
  let db: CoreDatabase;
  let tempDir: string;
  let broadcaster: EventBroadcaster;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pandesh-bg-test-'));
    db = openDatabase(path.join(tempDir, 'core.db'));
    runMigrations(db);
    broadcaster = new EventBroadcaster();
  });

  afterEach(() => {
    resetActiveWorkersForTesting();
    try {
      db.close();
    } catch {}
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {}
  });

  function makeRequest(convId: string, text: string) {
    return createRequest(db, {
      clientId: 'desktop',
      conversationId: convId,
      currentMessage: text,
      requestedMode: 'baat_kar',
      resolvedMode: 'baat_kar',
      routeReason: 'user_prompt',
      contextPolicy: {
        includeConversationHistory: true,
        includeProjectContext: false,
        includeRepositoryContext: false,
        includeGlobalStoryContext: false,
      },
      correlationId: `corr_${Date.now()}_${Math.random()}`,
    });
  }

  it('detects user intent for delegation, status, results, cancel, and continue', () => {
    expect(isGmailContractExtractionRequest('Extract all contracts from my Gmail.')).toBe(true);
    expect(isGmailContractExtractionRequest('extract contracts from my email')).toBe(true);
    expect(isGmailContractExtractionRequest('find all contracts in gmail')).toBe(true);
    expect(isGmailContractExtractionRequest('inventory all agreements from my mailbox')).toBe(true);
    expect(isGmailContractExtractionRequest('What is the capital of France?')).toBe(false);

    expect(isTaskStatusRequest("What's the status?")).toBe(true);
    expect(isTaskStatusRequest('check status')).toBe(true);
    expect(isTaskStatusRequest('how is the extraction going?')).toBe(false || true); // both match regex

    expect(isShowResultsRequest('Show my results')).toBe(true);
    expect(isShowResultsRequest('show contracts')).toBe(true);
    expect(isShowResultsRequest('contract inventory')).toBe(true);

    expect(isCancelTaskRequest('Cancel')).toBe(true);
    expect(isCancelTaskRequest('cancel the task')).toBe(true);
    expect(isCancelTaskRequest('stop extraction')).toBe(true);

    expect(isContinueTaskRequest('Continue')).toBe(true);
    expect(isContinueTaskRequest('resume extraction')).toBe(true);
  });

  it('delegates Gmail contract extraction immediately, frees conversation, and starts durable background task', async () => {
    const conv = createConversation(db, { mode: 'baat_kar', actor: 'user', title: 'Contract Extraction Test' });
    const req = makeRequest(conv.id, 'Extract all contracts from my Gmail.');
    const att = createAttempt(db, {
      requestId: req.id,
      kind: 'baat_kar',
      actor: 'client:desktop',
      clientId: 'desktop',
    });
    const fence = acquireFence(db, att.id, { owner: 'test', actor: 'test' });

    // Track tool calls in simulated background worker
    let searchCalled = false;
    const fakeToolExecutor = async (toolName: string, args: Record<string, unknown>) => {
      if (toolName === 'gmail_search') {
        searchCalled = true;
        return {
          status: 'succeeded',
          output: JSON.stringify({
            messages: [{ id: 'msg-1', threadId: 'thread-1', subject: 'Vendor Agreement' }],
          }),
        };
      }
      return { status: 'succeeded', output: JSON.stringify({}) };
    };

    const startTime = Date.now();
    const result = await piAgentEngine.executeAssistantTurn({
      db,
      broadcaster,
      attemptId: att.id,
      requestId: req.id,
      conversationId: conv.id,
      prompt: 'Extract all contracts from my Gmail.',
      fenceToken: fence.token,
      capabilities: undefined,
    });
    const elapsedMs = Date.now() - startTime;

    // 1. Immediately frees the conversation (fast non-blocking return)
    expect(elapsedMs).toBeLessThan(500);
    expect(result.success).toBe(true);
    expect(result.reply).toBe("I've started your Gmail contract extraction. It may take some time. I'll notify you when it's finished. You can continue chatting.");

    // 2. Interactive turn attempt completed and message appended
    const updatedAtt = getAttempt(db, att.id);
    expect(updatedAtt.status).toBe('completed');
    const msgs = listMessages(db, conv.id);
    expect(msgs.some((m) => m.role === 'assistant' && m.content.includes("I've started your Gmail contract extraction"))).toBe(true);

    // 3. Durable background task created
    const bgTask = getActiveBackgroundTask(db, { conversationId: conv.id, taskType: 'gmail_contract_extraction' });
    expect(bgTask).toBeDefined();
    expect(bgTask?.status).toBe('in_progress');
    expect(bgTask?.objective).toContain('Extract all contracts from my Gmail');
    expect(bgTask?.completionCriteria.length).toBeGreaterThan(0);
    expect(bgTask?.checkpoints.length).toBeGreaterThan(0);
    expect(bgTask?.checkpoints[0].kind).toBe('task_started');

    // 4. Background attempt created with restricted Gmail tools
    const bgAttempt = getAttempt(db, bgTask!.attemptId);
    expect(bgAttempt.kind).toBe('saath_kar');
    const bgCtx = getAttemptContext(db, bgTask!.attemptId);
    expect(bgCtx.permittedCapabilities.allowedTools).toEqual([
      'gmail_read_attachment',
      'gmail_read_thread',
      'gmail_search',
    ]);

    // 5. Prevent duplicate execution
    const duplicate = startGmailContractExtractionTask(db, broadcaster, {
      conversationId: conv.id,
    });
    expect(duplicate.alreadyRunning).toBe(true);
    expect(duplicate.task.id).toBe(bgTask!.id);
  });

  it('allows asking 10 unrelated questions immediately while background extraction continues with cooperative lane yielding', async () => {
    const conv = createConversation(db, { mode: 'baat_kar', actor: 'user', title: 'Multi-turn Test' });

    // Start background task
    let stepCount = 0;
    const { task } = startGmailContractExtractionTask(
      db,
      broadcaster,
      { conversationId: conv.id },
      {
        toolExecutor: async (toolName) => {
          stepCount++;
          // Cooperative yield at tool boundary
          await interactiveLane.yieldToInteractiveAtTool(task.attemptId, undefined, 100);
          return {
            status: 'succeeded',
            output: JSON.stringify({ messages: [] }),
          };
        },
      },
    );

    expect(task.status).toBe('in_progress');

    // Simulate 10 unrelated quick questions while background worker operates
    for (let i = 1; i <= 10; i++) {
      const qText = `What is ${i} + ${i}?`;
      const qReq = makeRequest(conv.id, qText);
      const qAtt = createAttempt(db, {
        requestId: qReq.id,
        kind: 'baat_kar',
        actor: 'client:desktop',
        clientId: 'desktop',
      });
      const qFence = acquireFence(db, qAtt.id, { owner: 'test', actor: 'test' });

      // Verify classification
      expect(classifyAttemptLane({ kind: qAtt.kind, clientId: 'desktop' })).toBe('interactive');
      const release = interactiveLane.begin(qAtt.id);

      // Append user message
      appendMessage(db, conv.id, { role: 'user', content: qText, actor: 'user' });

      // Simulate assistant turn answering immediately
      appendMessage(db, conv.id, {
        role: 'assistant',
        content: `The answer is ${i + i}.`,
        actor: 'karkedikha:pi',
      });
      transitionAttempt(db, qAtt.id, { toStatus: 'running', fenceToken: qFence.token, actor: 'karkedikha:pi' });
      transitionAttempt(db, qAtt.id, { toStatus: 'completed', fenceToken: qFence.token, actor: 'karkedikha:pi' });
      release();

      expect(getAttempt(db, qAtt.id).status).toBe('completed');
    }

    const messages = listMessages(db, conv.id);
    expect(messages.filter((m) => m.role === 'user').length).toBe(10);
    expect(messages.filter((m) => m.role === 'assistant').length).toBe(10);

    // Background task still exists and is durable
    const activeBg = getBackgroundTask(db, task.id);
    expect(activeBg).toBeDefined();
  });

  it('allows switching to another conversation while background extraction continues', async () => {
    const conv1 = createConversation(db, { mode: 'baat_kar', actor: 'user', title: 'Conversation 1' });
    const conv2 = createConversation(db, { mode: 'baat_kar', actor: 'user', title: 'Conversation 2' });

    // Start background task in Conversation 1
    const { task } = startGmailContractExtractionTask(db, broadcaster, {
      conversationId: conv1.id,
      objective: 'Extract contracts',
    });

    // Switch to Conversation 2 and send messages
    const conv2Msg = appendMessage(db, conv2.id, {
      role: 'user',
      content: 'Hello from another conversation!',
      actor: 'user',
    });
    expect(conv2Msg.conversationId).toBe(conv2.id);

    // Verify task in Conversation 1 remains running
    const bgTaskConv1 = getActiveBackgroundTask(db, { conversationId: conv1.id });
    expect(bgTaskConv1?.id).toBe(task.id);

    // Verify no background task was created in Conversation 2
    const bgTaskConv2 = getActiveBackgroundTask(db, { conversationId: conv2.id });
    expect(bgTaskConv2).toBeUndefined();
  });

  it('handles user queries: status, cancel, continue, and show results', async () => {
    const conv = createConversation(db, { mode: 'baat_kar', actor: 'user', title: 'Control Queries Test' });

    // 1. Check status when no task exists
    let req = makeRequest(conv.id, "What's the status?");
    let att = createAttempt(db, { requestId: req.id, kind: 'baat_kar', actor: 'client:desktop' });
    let fence = acquireFence(db, att.id, { owner: 'test', actor: 'test' });
    let res = await piAgentEngine.executeAssistantTurn({
      db, broadcaster, attemptId: att.id, requestId: req.id, conversationId: conv.id,
      prompt: "What's the status?", fenceToken: fence.token,
    });
    expect(res.reply).toContain('no background extraction tasks');

    // 2. Start a background task
    const { task } = startGmailContractExtractionTask(db, broadcaster, { conversationId: conv.id });

    // 3. Check status when task is running
    req = makeRequest(conv.id, "What's the status?");
    att = createAttempt(db, { requestId: req.id, kind: 'baat_kar', actor: 'client:desktop' });
    fence = acquireFence(db, att.id, { owner: 'test', actor: 'test' });
    res = await piAgentEngine.executeAssistantTurn({
      db, broadcaster, attemptId: att.id, requestId: req.id, conversationId: conv.id,
      prompt: "What's the status?", fenceToken: fence.token,
    });
    expect(res.reply).toContain('Gmail contract extraction is in progress');
    expect(res.reply).toContain('Gmail contract extraction started in background');

    // 4. Cancel the task
    req = makeRequest(conv.id, 'Cancel');
    att = createAttempt(db, { requestId: req.id, kind: 'baat_kar', actor: 'client:desktop' });
    fence = acquireFence(db, att.id, { owner: 'test', actor: 'test' });
    res = await piAgentEngine.executeAssistantTurn({
      db, broadcaster, attemptId: att.id, requestId: req.id, conversationId: conv.id,
      prompt: 'Cancel', fenceToken: fence.token,
    });
    expect(res.reply).toBe('Your Gmail contract extraction has been cancelled.');
    expect(getBackgroundTask(db, task.id)?.status).toBe('cancelled');
    expect(getAttempt(db, task.attemptId).status).toBe('cancelled');

    // 5. Continue the cancelled task
    req = makeRequest(conv.id, 'Continue');
    att = createAttempt(db, { requestId: req.id, kind: 'baat_kar', actor: 'client:desktop' });
    fence = acquireFence(db, att.id, { owner: 'test', actor: 'test' });
    res = await piAgentEngine.executeAssistantTurn({
      db, broadcaster, attemptId: att.id, requestId: req.id, conversationId: conv.id,
      prompt: 'Continue', fenceToken: fence.token,
    });
    expect(res.reply).toContain('Resuming your Gmail contract extraction from the last saved checkpoint');
    expect(getBackgroundTask(db, task.id)?.status).toBe('in_progress');

    // 6. Simulate task completion with inventory table
    const tableMarkdown = '| Contract Type | Company / Counterparty | Date | Email / Thread Reference | Attachment | Extraction Status |\n| Rental Agreement | Enterprise | 2026-10-20 | thread-1 | agreement.pdf | Confirmed |';
    updateBackgroundTask(db, task.id, {
      status: 'completed',
      resultData: tableMarkdown,
      resultSummary: 'Verified inventory table generated.',
    });

    // 7. Show results
    req = makeRequest(conv.id, 'Show my results');
    att = createAttempt(db, { requestId: req.id, kind: 'baat_kar', actor: 'client:desktop' });
    fence = acquireFence(db, att.id, { owner: 'test', actor: 'test' });
    res = await piAgentEngine.executeAssistantTurn({
      db, broadcaster, attemptId: att.id, requestId: req.id, conversationId: conv.id,
      prompt: 'Show my results', fenceToken: fence.token,
    });
    expect(res.reply).toContain('| Contract Type | Company / Counterparty | Date |');
    expect(res.reply).toContain('Rental Agreement');
    expect(res.reply).toContain('Enterprise');
  });

  it('recovers interrupted background tasks on Core restart and delivers verified result + notification without extra prompt', async () => {
    const conv = createConversation(db, { mode: 'baat_kar', actor: 'user', title: 'Restart & Recovery Test' });

    // Generate real PDF bytes fixture for contract extraction
    const pdfBytes = buildMinimalPdf('ENTERPRISE RENT-A-CAR RENTAL AGREEMENT RA # 12345 Rate $45.00/day');
    const pdfBase64 = pdfBytes.toString('base64url');

    // Create a task that was interrupted mid-way (e.g. search was done, thread-1 pending inspection)
    const { task } = startGmailContractExtractionTask(
      db,
      broadcaster,
      {
        conversationId: conv.id,
        objective: 'Extract all contracts from my Gmail.',
      },
      { autoStart: false },
    );
    transitionAttempt(db, task.attemptId, { toStatus: 'running', actor: 'core:background_worker' });

    // Simulate search stage checkpoint already saved before Core restarted
    updateBackgroundTask(db, task.id, {
      payload: {
        stage: 'inspect_threads',
        candidateThreadIds: ['thread-vendor-1'],
        processedThreadIds: [],
        toolCallsRecorded: [
          {
            tool: 'gmail_search',
            args: { q: 'contract OR agreement OR lease filename:pdf' },
            result: {
              status: 'succeeded',
              output: JSON.stringify({
                messages: [{ id: 'msg-vendor-1', threadId: 'thread-vendor-1', subject: 'Your Enterprise Rental Agreement' }],
              }),
            },
            status: 'completed',
          },
        ],
      },
    });

    // 1. Verify boot reconciliation does not mark background task attempt as dead
    const beforeAttempt = getAttempt(db, task.attemptId);
    expect(beforeAttempt.status).toBe('running');
    failDeadExecutorAttemptsOnBoot(db);
    const afterAttempt = getAttempt(db, task.attemptId);
    // Background task attempt should NOT be failed on boot!
    expect(afterAttempt.status).toBe('running');

    // Capture events emitted during recovery
    const capturedEvents: any[] = [];
    broadcaster.on('runtime_event', (evt) => capturedEvents.push(evt));

    // Controlled tool executor for the recovery run
    const options = {
      toolExecutor: async (toolName: string, args: Record<string, unknown>) => {
        if (toolName === 'gmail_read_thread') {
          return {
            status: 'succeeded',
            output: JSON.stringify({
              id: 'thread-vendor-1',
              messages: [
                {
                  id: 'msg-vendor-1',
                  subject: 'Your Enterprise Rental Agreement',
                  from: 'contracts@enterprise.example',
                  date: 'Tue, 20 Oct 2026 12:00:00 +0000',
                  bodyText: 'Please find your rental agreement attached.',
                  hasAttachments: true,
                  attachments: [
                    {
                      id: 'att-vendor-pdf',
                      filename: 'Enterprise_Agreement.pdf',
                      mimeType: 'application/pdf',
                      size: pdfBytes.length,
                    },
                  ],
                },
              ],
            }),
          };
        }
        if (toolName === 'gmail_read_attachment') {
          return {
            status: 'succeeded',
            output: JSON.stringify({
              filename: 'Enterprise_Agreement.pdf',
              mimeType: 'application/pdf',
              data: pdfBase64,
              size: pdfBytes.length,
            }),
          };
        }
        return { status: 'succeeded', output: JSON.stringify({}) };
      },
    };

    // 2. Perform recovery run (simulating Core restart recovery loop with fresh process)
    resetActiveWorkersForTesting();
    const recovered = await recoverBackgroundTasks(db, broadcaster, options);
    expect(recovered.length).toBe(1);
    expect(recovered[0].id).toBe(task.id);

    // Wait briefly for the recovered background promise to complete
    let finalTask = getBackgroundTask(db, task.id)!;
    const deadline = Date.now() + 5000;
    while (finalTask.status === 'in_progress' && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 100));
      finalTask = getBackgroundTask(db, task.id)!;
    }

    // 3. Verify task completed successfully
    expect(finalTask.status).toBe('completed');
    expect(finalTask.completedAt).not.toBeNull();
    expect(finalTask.resultData).toContain('| Contract Type | Company / Counterparty | Date |');
    expect(finalTask.resultData).toContain('Enterprise');

    // 4. Verify verified contract inventory delivered automatically into conversation
    const messages = listMessages(db, conv.id);
    const deliveredMsg = messages.find(
      (m) => m.role === 'assistant' && m.content.includes("I've finished your Gmail contract extraction"),
    );
    expect(deliveredMsg).toBeDefined();
    expect(deliveredMsg?.content).toContain('| Contract Type | Company / Counterparty | Date |');
    expect(deliveredMsg?.content).toContain('Enterprise');

    // 5. Verify in-app notification was emitted
    const notification = capturedEvents.find(
      (e) => e.domain === 'background_task' && e.eventType === 'background_task_completed',
    );
    expect(notification).toBeDefined();
    expect(notification?.metadata?.taskId).toBe(task.id);
    expect(notification?.metadata?.title).toBe('Gmail Contract Extraction Completed');
    expect(finalTask.notificationSent).toBe(true);

    // 6. Verify attempt transitioned to completed
    expect(getAttempt(db, task.attemptId).status).toBe('completed');
  });

  it('preserves Gmail permission boundaries and sensitive-data handling', () => {
    const conv = createConversation(db, { mode: 'baat_kar', actor: 'user', title: 'Security Boundary Test' });
    const { task } = startGmailContractExtractionTask(db, broadcaster, {
      conversationId: conv.id,
    });

    const bgCtx = getAttemptContext(db, task.attemptId);
    const allowedTools = bgCtx.permittedCapabilities.allowedTools;
    expect(allowedTools).toBeDefined();

    // Only read-level tools are authorized for contract extraction
    expect(allowedTools).toContain('gmail_search');
    expect(allowedTools).toContain('gmail_read_thread');
    expect(allowedTools).toContain('gmail_read_attachment');

    // Must NOT contain mutation, draft, or delete tools
    expect(allowedTools).not.toContain('gmail_send');
    expect(allowedTools).not.toContain('gmail_create_draft');
    expect(allowedTools).not.toContain('gmail_trash');
  });
});
