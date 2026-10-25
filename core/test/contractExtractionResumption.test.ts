import { describe, it, expect, beforeEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import { NON_WORKSPACE_MARKERS } from '../domain/taskToolSurface';
import { summarizeGmailMessage, type GmailApiMessage } from '../runtime/connectors/gmailMime';
import { createGwsGmailExecutor, type GwsGmailAdapterConfig } from '../runtime/connectors/gwsGmailAdapter';
import type { CapabilityExecutionContext } from '../runtime/connectors/connectorCapability';

describe('Gmail Contract Extraction & Resumption Regression Suite', () => {
  const needsTools = (prompt: string) => NON_WORKSPACE_MARKERS.some(([, pattern]) => pattern.test(prompt));

  it('detects contract extraction and continuation prompts as needing full tools', () => {
    expect(needsTools('extract contracts from my gmail')).toBe(true);
    expect(needsTools('extract contracts')).toBe(true);
    expect(needsTools('continue extracting my contracts.')).toBe(true);
    expect(needsTools('continue')).toBe(true);
    expect(needsTools('resume contract extraction')).toBe(true);
    expect(needsTools('what happened to extracting contracts from my email.')).toBe(true);
    expect(needsTools('updates?')).toBe(true);
    expect(needsTools('inventory all our agreements and leases')).toBe(true);
    expect(needsTools('check which models are available')).toBe(true);
  });

  it('summarizes Gmail message with full attachment provenance and metadata', () => {
    const rawMessage: GmailApiMessage = {
      id: 'msg-rental-1',
      threadId: 'thread-rental-1',
      snippet: 'Here is your Enterprise Rent-A-Car agreement',
      internalDate: String(Date.UTC(2026, 9, 20, 10, 0, 0)),
      payload: {
        headers: [
          { name: 'Subject', value: 'Your Enterprise Rental Agreement #12345' },
          { name: 'From', value: 'enterprise@rentacar.example' },
          { name: 'To', value: 'user@example.com' },
          { name: 'Date', value: 'Tue, 20 Oct 2026 10:00:00 +0000' },
        ],
        mimeType: 'multipart/mixed',
        parts: [
          {
            mimeType: 'text/plain',
            body: { data: Buffer.from('Please find your contract attached.', 'utf8').toString('base64url') },
          },
          {
            mimeType: 'application/pdf',
            filename: 'Rental_Agreement_12345.pdf',
            body: {
              attachmentId: 'att-pdf-enterprise-99',
              size: 245000,
            },
          },
        ],
      },
    };

    const summary = summarizeGmailMessage(rawMessage, 'UTC');
    expect(summary.hasAttachments).toBe(true);
    expect(summary.attachments).toHaveLength(1);
    expect(summary.attachments[0]).toEqual({
      id: 'att-pdf-enterprise-99',
      filename: 'Rental_Agreement_12345.pdf',
      mimeType: 'application/pdf',
      size: 245000,
    });
    expect(summary.bodyText).toBe('Please find your contract attached.');
    expect(summary.subject).toBe('Your Enterprise Rental Agreement #12345');
  });

  it('executes gmail_read_attachment locally and extracts text without data loss', async () => {
    const contractText = 'ENTERPRISE RENT-A-CAR RENTAL AGREEMENT\nVehicle: Tesla Model 3\nDates: 2026-10-20 to 2026-10-25\nTotal: $350.00';
    const b64Data = Buffer.from(contractText, 'utf8').toString('base64url');

    let capturedCommand: string[] = [];
    const fakeRunGws = async (input: { args: string[] }) => {
      capturedCommand = input.args;
      return {
        exitCode: 0,
        stdout: JSON.stringify({ size: contractText.length, data: b64Data }),
        stderr: '',
        timedOut: false,
        aborted: false,
      };
    };

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'contract-test-'));
    const binaryPath = path.join(dir, 'gws.exe');
    fs.writeFileSync(binaryPath, 'mock-binary');
    const digest = crypto.createHash('sha256').update('mock-binary').digest('hex');

    const config: GwsGmailAdapterConfig = {
      getAccessToken: () => 'valid-access-token',
      getAccountEmail: () => 'user@example.com',
      configDir: path.join(dir, 'config'),
      binaryPath,
      expectedSha256: digest,
      bindings: { record: () => ({} as any), get: () => undefined },
      runGwsFn: fakeRunGws as any,
    };

    const executor = createGwsGmailExecutor(config);
    const ctx: CapabilityExecutionContext = { signal: new AbortController().signal };

    const result = await executor('gmail_read_attachment', {
      messageId: 'msg-rental-1',
      attachmentId: 'att-pdf-enterprise-99',
      filename: 'contract.txt',
      mimeType: 'text/plain',
    }, ctx);

    expect(result.status).toBe('succeeded');
    expect(capturedCommand).toEqual([
      'gmail', 'users', 'messages', 'attachments', 'get',
      '--params', JSON.stringify({ userId: 'me', messageId: 'msg-rental-1', id: 'att-pdf-enterprise-99' }),
    ]);

    const parsedOutput = JSON.parse(result.output);
    expect(parsedOutput.status).toBe('extracted');
    expect(parsedOutput.extractedText).toBe(contractText);
    expect(parsedOutput.size).toBe(contractText.length);
    expect(parsedOutput.messageId).toBe('msg-rental-1');
  });
});
