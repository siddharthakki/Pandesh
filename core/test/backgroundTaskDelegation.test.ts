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
  routeBackgroundTaskIntent,
  resumeBackgroundTask,
  cancelBackgroundTaskWorker,
  isGmailContractExtractionRequest,
  isTaskStatusRequest,
  isShowResultsRequest,
  isCancelTaskRequest,
  isContinueTaskRequest,
} from '../runtime/backgroundWorker';
import { getTaskOutcome } from '../domain/taskOutcomes';
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
import { buildRouter } from '../api/routes';
import { setConnectorPermission } from '../domain/connectors';

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

    // 1. Check extraction status when no task exists
    let req = makeRequest(conv.id, "What's the extraction status?");
    let att = createAttempt(db, { requestId: req.id, kind: 'baat_kar', actor: 'client:desktop' });
    let fence = acquireFence(db, att.id, { owner: 'test', actor: 'test' });
    let res = await piAgentEngine.executeAssistantTurn({
      db, broadcaster, attemptId: att.id, requestId: req.id, conversationId: conv.id,
      prompt: "What's the extraction status?", fenceToken: fence.token,
    });
    expect(res.reply).toContain('no background extraction tasks');

    // 2. Start a background task with controlled execution
    let taskRunning = true;
    const { task } = startGmailContractExtractionTask(
      db,
      broadcaster,
      { conversationId: conv.id },
      {
        toolExecutor: async (toolName) => {
          while (taskRunning) {
            await new Promise((r) => setTimeout(r, 50));
          }
          return { status: 'succeeded', output: JSON.stringify({ results: [] }) };
        },
      },
    );

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

  it('regression 1: failed or unauthorized Gmail search fails truthfully without false success, and partial coverage is explicitly declared', async () => {
    const conv = createConversation(db, { mode: 'baat_kar', actor: 'user', title: 'Search Failure & Truthfulness' });

    // A: Test failed/unauthorized Gmail search
    const { task: taskFail } = startGmailContractExtractionTask(
      db,
      broadcaster,
      {
        conversationId: conv.id,
        objective: 'Extract contracts',
      },
      { autoStart: false },
    );

    const failExecutor = {
      toolExecutor: async (toolName: string) => {
        if (toolName === 'gmail_search') {
          return {
            status: 'failed',
            output: JSON.stringify({ error: 'Gmail connector is disconnected or unauthorized' }),
          };
        }
        return { status: 'succeeded', output: JSON.stringify({}) };
      },
    };

    await runBackgroundTask(db, broadcaster, taskFail.id, failExecutor);

    const failedTask = getBackgroundTask(db, taskFail.id)!;
    expect(failedTask.status).toBe('failed');
    expect(failedTask.error).toContain('Gmail connector is disconnected or unauthorized');
    expect(failedTask.resultSummary).toContain('Gmail search failed');

    // Attempt must also be failed
    const failedAttempt = getAttempt(db, taskFail.attemptId);
    expect(failedAttempt.status).toBe('failed');
    expect(failedAttempt.failureReason).toContain('Gmail connector is disconnected or unauthorized');

    // Task outcome must be unverified and blocked
    const outcome = getTaskOutcome(db, taskFail.attemptId);
    expect(outcome?.status).toBe('blocked');

    // Message delivered must report the blocker/failure, NEVER "no contracts found" or completed inventory
    const messages = listMessages(db, conv.id);
    const failureMsg = messages.find(
      (m) => m.role === 'assistant' && m.content.includes('Gmail contract extraction because the search failed'),
    );
    expect(failureMsg).toBeDefined();
    expect(failureMsg?.content).toContain('Gmail connector is disconnected or unauthorized');
    expect(failureMsg?.content).not.toContain('No contract documents were found');
    expect(failureMsg?.content).not.toContain('finished your Gmail contract extraction');

    // B: Test partial search coverage is not presented as a complete Gmail inventory
    const convPartial = createConversation(db, { mode: 'baat_kar', actor: 'user', title: 'Partial Coverage' });
    const { task: taskPartial } = startGmailContractExtractionTask(
      db,
      broadcaster,
      {
        conversationId: convPartial.id,
        objective: 'Extract contracts',
      },
      { autoStart: false },
    );

    const pdfBytes = buildMinimalPdf('OFFICE LEASE AGREEMENT RA # 9999');
    const pdfBase64 = pdfBytes.toString('base64url');

    const partialExecutor = {
      toolExecutor: async (toolName: string) => {
        if (toolName === 'gmail_search') {
          return {
            status: 'succeeded',
            output: JSON.stringify({
              messages: [{ id: 'msg-p1', threadId: 'thread-p1', subject: 'Lease Agreement' }],
              counts: { matched: 50, returned: 1, moreAvailable: true },
            }),
          };
        }
        if (toolName === 'gmail_read_thread') {
          return {
            status: 'succeeded',
            output: JSON.stringify({
              id: 'thread-p1',
              messages: [
                {
                  id: 'msg-p1',
                  subject: 'Lease Agreement',
                  from: 'landlord@example.com',
                  date: 'Tue, 20 Oct 2026 12:00:00 +0000',
                  bodyText: 'Attached is the lease agreement.',
                  hasAttachments: true,
                  attachments: [{ id: 'att-1', filename: 'Lease.pdf', mimeType: 'application/pdf', size: pdfBytes.length }],
                },
              ],
            }),
          };
        }
        if (toolName === 'gmail_read_attachment') {
          return {
            status: 'succeeded',
            output: JSON.stringify({
              filename: 'Lease.pdf',
              mimeType: 'application/pdf',
              data: pdfBase64,
              size: pdfBytes.length,
            }),
          };
        }
        return { status: 'succeeded', output: JSON.stringify({}) };
      },
    };

    await runBackgroundTask(db, broadcaster, taskPartial.id, partialExecutor);

    const partialTask = getBackgroundTask(db, taskPartial.id)!;
    expect(partialTask.status).toBe('completed');
    expect(partialTask.resultSummary).toContain('partial coverage');

    const partialMessages = listMessages(db, convPartial.id);
    const partialDelivery = partialMessages.find(
      (m) => m.role === 'assistant' && m.content.includes('partial inventory'),
    );
    expect(partialDelivery).toBeDefined();
    expect(partialDelivery?.content).toContain('additional matching messages or candidates exist in your mailbox');
    expect(partialDelivery?.content).not.toContain("I've finished your Gmail contract extraction.\n\n");
  });

  it('regression 2: generic prompts do not hijack unrelated conversations without active tasks', async () => {
    // Conversation A: Has an active extraction task
    const convA = createConversation(db, { mode: 'baat_kar', actor: 'user', title: 'Active Extraction Chat' });
    const { task: taskA } = startGmailContractExtractionTask(
      db,
      broadcaster,
      {
        conversationId: convA.id,
        objective: 'Extract contracts',
      },
      { autoStart: false },
    );

    // Conversation B: Completely unrelated conversation (e.g. creative writing, travel, coding)
    const convB = createConversation(db, { mode: 'baat_kar', actor: 'user', title: 'Unrelated Chat' });

    // In unrelated conversation B, generic prompts must NOT route to background task handler
    const unrelatedPrompts = [
      "What's the status?",
      'Continue',
      'Cancel',
      'Show my results',
      'continue writing the story',
      'cancel my flight reservation',
      'what is the status of PR 12?',
    ];

    for (const prompt of unrelatedPrompts) {
      const routingB = routeBackgroundTaskIntent(db, convB.id, prompt);
      expect(routingB.shouldRoute).toBe(false);
    }

    // However, if the user explicitly asks about extraction in convB, it SHOULD route (and report no task)
    const explicitStatusB = routeBackgroundTaskIntent(db, convB.id, "What's the extraction status?");
    expect(explicitStatusB.shouldRoute).toBe(true);
    expect(explicitStatusB.intent).toBe('status');

    // In conversation A with the active task, generic prompts DO route
    const statusA = routeBackgroundTaskIntent(db, convA.id, "What's the status?");
    expect(statusA.shouldRoute).toBe(true);
    expect(statusA.intent).toBe('status');
    expect(statusA.activeTask?.id).toBe(taskA.id);

    const cancelA = routeBackgroundTaskIntent(db, convA.id, 'Cancel');
    expect(cancelA.shouldRoute).toBe(true);
    expect(cancelA.intent).toBe('cancel');
  });

  it('regression 3: cancel followed by continue allocates a valid new attempt and syncs ledger and task', async () => {
    const conv = createConversation(db, { mode: 'baat_kar', actor: 'user', title: 'Cancel-Continue Ledger Sync' });

    // 1. Start extraction task
    const { task } = startGmailContractExtractionTask(
      db,
      broadcaster,
      {
        conversationId: conv.id,
        objective: 'Extract contracts',
      },
      { autoStart: false },
    );

    const attempt1Id = task.attemptId;
    transitionAttempt(db, attempt1Id, { toStatus: 'running', actor: 'core:background_worker' });
    const attempt1 = getAttempt(db, attempt1Id);
    expect(attempt1.status).toBe('running');

    // 2. Cancel the background task
    cancelBackgroundTaskWorker(db, broadcaster, task.id, 'User requested cancel');

    const cancelledTask = getBackgroundTask(db, task.id)!;
    expect(cancelledTask.status).toBe('cancelled');

    const cancelledAttempt1 = getAttempt(db, attempt1Id);
    expect(cancelledAttempt1.status).toBe('cancelled');

    // 3. Continue the task via resumeBackgroundTask
    const options = {
      toolExecutor: async (toolName: string) => {
        if (toolName === 'gmail_search') {
          return {
            status: 'succeeded',
            output: JSON.stringify({ messages: [] }),
          };
        }
        return { status: 'succeeded', output: JSON.stringify({}) };
      },
    };

    const { task: resumedTask } = resumeBackgroundTask(db, broadcaster, task.id, options);
    expect(resumedTask).toBeDefined();

    // 4. Verify attempt ledger and background task agreement
    const newAttemptId = resumedTask.attemptId;
    expect(newAttemptId).not.toBe(attempt1Id);

    // Old attempt remains cancelled in immutable ledger
    const checkAttempt1 = getAttempt(db, attempt1Id);
    expect(checkAttempt1.status).toBe('cancelled');

    // New attempt is running / active
    const newAttempt = getAttempt(db, newAttemptId);
    expect(['running', 'completed']).toContain(newAttempt.status);

    // Wait for the background worker to finish
    let currentTask = getBackgroundTask(db, task.id)!;
    const deadline = Date.now() + 5000;
    while (currentTask.status === 'in_progress' && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 100));
      currentTask = getBackgroundTask(db, task.id)!;
    }

    // Both final task and new attempt agree on completed status
    expect(currentTask.status).toBe('completed');
    expect(currentTask.attemptId).toBe(newAttemptId);
    expect(getAttempt(db, newAttemptId).status).toBe('completed');
    expect(getAttempt(db, attempt1Id).status).toBe('cancelled');
  });

  it('Continue API route (/v1/background-tasks/:id/continue) allocates a new attempt when the previous attempt is terminal and uses configured connector registry', async () => {
    const conv = createConversation(db, { mode: 'baat_kar', actor: 'user', title: 'Continue API Test' });

    // 1. Start extraction task
    const { task } = startGmailContractExtractionTask(
      db,
      broadcaster,
      { conversationId: conv.id, objective: 'Extract contracts' },
      { autoStart: false },
    );
    const attempt1Id = task.attemptId;
    transitionAttempt(db, attempt1Id, { toStatus: 'running', actor: 'core:background_worker' });

    // 2. Cancel the task
    cancelBackgroundTaskWorker(db, broadcaster, task.id, 'Cancelled');
    expect(getBackgroundTask(db, task.id)!.status).toBe('cancelled');
    expect(getAttempt(db, attempt1Id).status).toBe('cancelled');

    // 3. Build a router with mock connectorRegistry
    let connectorSearchCalled = false;
    const fakeGmailAdapter = {
      id: 'gmail' as const,
      connectorId: 'gmail' as const,
      definitions: () => [],
      tier: () => 'read' as const,
      classify: () => 'read_only' as const,
      isConfigured: () => true,
      health: () => ({ state: 'available' as const, checkedAt: new Date().toISOString() }),
      probeHealth: async () => ({ state: 'available' as const, checkedAt: new Date().toISOString() }),
      redactArguments: (_n: string, a: any) => a,
      run: async (call: any) => {
        if (call.name === 'gmail_search') {
          connectorSearchCalled = true;
          return { status: 'succeeded' as const, exitCode: 0, output: JSON.stringify({ results: [] }) };
        }
        return { status: 'succeeded' as const, exitCode: 0, output: JSON.stringify({}) };
      },
    };
    const mockConnectorRegistry = new Map<any, any>([['gmail', fakeGmailAdapter]]);
    setConnectorPermission(db, { connectorId: 'gmail', tier: 'read', granted: true, actor: 'test' });

    const router = buildRouter(
      broadcaster,
      () => ({ version: '1.0.0', apiVersion: 'v1' } as any),
      () => {},
      undefined,
      undefined,
      undefined,
      mockConnectorRegistry,
    );

    const route = router.match('POST', `/v1/background-tasks/${task.id}/continue`);
    expect(route).not.toBeNull();

    const apiCtx = {
      db,
      body: {},
      query: new URLSearchParams(),
      actor: 'user',
      clientId: 'desktop',
      idempotencyKey: 'idem_continue_test_1',
    };

    const res = await route!.handler(apiCtx as any, route!.match);
    expect(res.status).toBe(200);
    const body = res.body as any;
    expect(body.id).toBe(task.id);
    expect(body.attemptId).not.toBe(attempt1Id);

    // Old attempt remains cancelled
    expect(getAttempt(db, attempt1Id).status).toBe('cancelled');

    // Wait for worker to run with connectorRegistry
    const deadline = Date.now() + 4000;
    while (Date.now() < deadline) {
      if (connectorSearchCalled) break;
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(connectorSearchCalled).toBe(true);
  });
});

