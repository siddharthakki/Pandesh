import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { openCoreDatabase } from '../../../core/db/openCore';
import { createConversation, appendMessage, listMessages } from '../../../core/domain/conversations';
import { startModelInvocation, completeModelInvocation } from '../../../core/domain/modelInvocations';
import { createRequest } from '../../../core/domain/requests';
import { createAttempt } from '../../../core/domain/attempts';

describe('Lightweight Persistent Conversation Provenance & Diagnostics', () => {
  it('records and returns model provenance and request diagnostics per assistant turn', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kkd-prov-test-'));
    const { db } = openCoreDatabase(path.join(dir, 'core.db'));

    const conversation = createConversation(db, {
      mode: 'baat_kar',
      title: 'Provenance test',
      actor: 'test',
    });

    const request = createRequest(db, {
      clientId: 'client-test',
      currentMessage: 'What is this project?',
      requestedMode: 'baat_kar',
      resolvedMode: 'baat_kar',
      routeReason: 'test',
      correlationId: 'corr-1',
      contextPolicy: {},
      conversationId: conversation.id,
      actor: 'test',
    });

    const attempt = createAttempt(db, {
      requestId: request.id,
      kind: 'baat_kar',
      actor: 'test',
    });

    // 1. User turn
    appendMessage(db, conversation.id, {
      role: 'user',
      content: 'What is this project?',
      actor: 'test',
    });

    // 2. Start model invocation with Qwen
    const minv = startModelInvocation(db, {
      attemptId: attempt.id,
      requestedProvider: 'ollama',
      requestedModel: 'qwen3.8:27b-mtp-q4_K_M',
      policyModel: 'qwen3.8:27b-mtp-q4_K_M',
      actor: 'test',
    });

    // 3. Complete assistant turn
    const assistantMsg = appendMessage(db, conversation.id, {
      role: 'assistant',
      content: 'This is the DevRadar project.',
      modelInvocationId: minv.id,
      actor: 'test',
    });

    const diagnostics = {
      conversationId: conversation.id,
      requestId: request.id,
      attemptId: attempt.id,
      model: 'qwen3.8:27b-mtp-q4_K_M',
      provider: 'ollama',
      currentUserMessage: 'What is this project?',
      selectedWorkspace: 'C:\\Projects\\devradar',
      messageHistoryCount: 1,
      contextTruncation: {
        truncated: false,
        omittedCount: 0,
      },
      toolInvocationIds: ['tinv_1'],
      outputAssociation: {
        assistantMessageId: assistantMsg.id,
        modelInvocationId: minv.id,
        finalOutcome: 'This is the DevRadar project.',
      },
    };

    completeModelInvocation(db, minv.id, {
      status: 'succeeded',
      actualProvider: 'ollama',
      actualModel: 'qwen3.8:27b-mtp-q4_K_M',
      usageMetadata: diagnostics as any,
      actor: 'test',
    });

    // 4. Model switch event (Qwen -> Tev)
    appendMessage(db, conversation.id, {
      role: 'system',
      content: JSON.stringify({
        type: 'model_switch',
        fromModel: 'qwen3.8:27b-mtp-q4_K_M',
        toModel: 'tev-27b:q4_k_m',
        timestamp: '2026-10-16T12:00:00.000Z',
      }),
      actor: 'core:desktop',
    });

    // 5. Next user turn with Tev
    appendMessage(db, conversation.id, {
      role: 'user',
      content: 'How do I run it?',
      actor: 'test',
    });

    const request2 = createRequest(db, {
      clientId: 'client-test',
      currentMessage: 'How do I run it?',
      requestedMode: 'baat_kar',
      resolvedMode: 'baat_kar',
      routeReason: 'test',
      correlationId: 'corr-2',
      contextPolicy: {},
      conversationId: conversation.id,
      actor: 'test',
    });

    const attempt2 = createAttempt(db, {
      requestId: request2.id,
      kind: 'baat_kar',
      actor: 'test',
    });

    const minv2 = startModelInvocation(db, {
      attemptId: attempt2.id,
      requestedProvider: 'ollama',
      requestedModel: 'tev-27b:q4_k_m',
      policyModel: 'tev-27b:q4_k_m',
      actor: 'test',
    });

    const assistantMsg2 = appendMessage(db, conversation.id, {
      role: 'assistant',
      content: 'Run make run to start.',
      modelInvocationId: minv2.id,
      actor: 'test',
    });

    completeModelInvocation(db, minv2.id, {
      status: 'succeeded',
      actualProvider: 'ollama',
      actualModel: 'tev-27b:q4_k_m',
      usageMetadata: {
        conversationId: conversation.id,
        requestId: request2.id,
        attemptId: attempt2.id,
        model: 'tev-27b:q4_k_m',
        provider: 'ollama',
        currentUserMessage: 'How do I run it?',
        selectedWorkspace: 'C:\\Projects\\devradar',
        messageHistoryCount: 2,
        contextTruncation: { truncated: false, omittedCount: 0 },
        toolInvocationIds: [],
        outputAssociation: {
          assistantMessageId: assistantMsg2.id,
          modelInvocationId: minv2.id,
        },
      } as any,
      actor: 'test',
    });

    // Verify listMessages returns proper provenance for all messages
    const msgs = listMessages(db, conversation.id);
    expect(msgs.length).toBe(5);

    // Turn 1 User
    expect(msgs[0].role).toBe('user');
    expect(msgs[0].content).toBe('What is this project?');

    // Turn 1 Assistant (Qwen)
    expect(msgs[1].role).toBe('assistant');
    expect(msgs[1].model).toBe('qwen3.8:27b-mtp-q4_K_M');
    expect(msgs[1].provider).toBe('ollama');
    expect(msgs[1].diagnostics?.requestId).toBe(request.id);
    expect(msgs[1].diagnostics?.toolInvocationIds).toEqual(['tinv_1']);

    // Model switch event
    expect(msgs[2].role).toBe('system');
    const switchPayload = JSON.parse(msgs[2].content);
    expect(switchPayload.type).toBe('model_switch');
    expect(switchPayload.fromModel).toBe('qwen3.8:27b-mtp-q4_K_M');
    expect(switchPayload.toModel).toBe('tev-27b:q4_k_m');

    // Turn 2 User
    expect(msgs[3].role).toBe('user');

    // Turn 2 Assistant (Tev)
    expect(msgs[4].role).toBe('assistant');
    expect(msgs[4].model).toBe('tev-27b:q4_k_m');
    expect(msgs[4].diagnostics?.model).toBe('tev-27b:q4_k_m');
    expect(msgs[4].diagnostics?.requestId).toBe(request2.id);

    // Verify that model-switch events are NOT treated as user or assistant turns
    const conversationalTurns = msgs.filter((m) => m.role === 'user' || m.role === 'assistant');
    expect(conversationalTurns.length).toBe(4);
    expect(conversationalTurns.some((m) => m.content.includes('model_switch'))).toBe(false);
  });
});
