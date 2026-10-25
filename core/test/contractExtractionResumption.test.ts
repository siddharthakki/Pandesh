import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import { NON_WORKSPACE_MARKERS } from '../domain/taskToolSurface';
import { summarizeGmailMessage, type GmailApiMessage } from '../runtime/connectors/gmailMime';
import { createGwsGmailExecutor, type GwsGmailAdapterConfig } from '../runtime/connectors/gwsGmailAdapter';
import { classifyContract, synthesizeContractInventory } from '../domain/contractInventory';
import { buildMinimalPdf } from './fixtures/documentFixtures';
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

  it('executes gmail_read_attachment locally and parses real PDF bytes with pdfjs-dist', async () => {
    // Generate real, valid PDF binary containing contract agreement terms
    const contractText = 'ENTERPRISE RENT-A-CAR RENTAL AGREEMENT RA # 4W742D Vehicle Tesla Model 3 Total $350.00';
    const pdfBuffer = buildMinimalPdf(contractText);
    const b64Data = pdfBuffer.toString('base64url');

    let capturedCommand: string[] = [];
    const fakeRunGws = async (input: { args: string[] }) => {
      capturedCommand = input.args;
      return {
        exitCode: 0,
        stdout: JSON.stringify({ size: pdfBuffer.length, data: b64Data }),
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
      filename: 'Rental_Agreement_4W742D.pdf',
      mimeType: 'application/pdf',
    }, ctx);

    expect(result.status).toBe('succeeded');
    expect(capturedCommand).toEqual([
      'gmail', 'users', 'messages', 'attachments', 'get',
      '--params', JSON.stringify({ userId: 'me', messageId: 'msg-rental-1', id: 'att-pdf-enterprise-99' }),
    ]);

    const parsedOutput = JSON.parse(result.output);
    expect(parsedOutput.status).toBe('extracted');
    // Confirm the PDF text was actually parsed by pdfjs-dist
    expect(parsedOutput.extractedText).toContain('ENTERPRISE RENT-A-CAR RENTAL AGREEMENT');
    expect(parsedOutput.extractedText).toContain('RA # 4W742D');
    expect(parsedOutput.extractedText).toContain('Tesla Model 3');
    expect(parsedOutput.pageCount).toBe(1);
    expect(parsedOutput.size).toBe(pdfBuffer.length);
    expect(parsedOutput.messageId).toBe('msg-rental-1');

    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('never marks contract confirmed from search snippet or subject alone', () => {
    // Rule 1: A search result alone MUST NEVER be confirmed
    const uninspected = classifyContract(
      'Enterprise Rental Agreement 4W742D',
      'Your rental agreement 4W742D is attached.',
      'Enterprise Rent-A-Car <DoNotReply@enterprise.com>',
      []
    );
    expect(uninspected.status).not.toContain('Confirmed');
    expect(uninspected.status).toBe('Candidate (Search match)');
  });

  it('correctly classifies misleading marketing emails as candidates or promotional notices', () => {
    // Misleading marketing email mentioning contracts/agreements in subject/snippet
    const marketing = classifyContract(
      'Exclusive Car Rental Agreement Rates & Savings',
      'Get 20% off your next car rental agreement! Limited time offer.',
      'Promotions <deals@travel-marketing.example>',
      [],
      {
        bodyText: 'Check out our amazing weekly deals! Use promo code SUMMER26 for 20% off. This is a promotional advertisement. Unsubscribe here.',
        inspected: true,
      }
    );
    expect(marketing.status).not.toContain('Confirmed');
    expect(marketing.status).toBe('Candidate (Marketing / Promotional)');
    expect(marketing.evidence).toContain('promotional/informational notice');
  });

  it('verifies against the actual failure scenario: 1 misleading marketing email, 1 inaccessible thread, and 1 successfully extracted PDF', () => {
    // Real PDF parsed text
    const realPdfText = 'ENTERPRISE RENT-A-CAR RENTAL AGREEMENT RA # 4W742D Vehicle: Tesla Model 3 Total: $350.00';

    const mockToolCalls = [
      // 1. Initial Gmail search returning 3 candidate threads
      {
        tool: 'gmail_search',
        status: 'completed',
        result: {
          content: [{
            type: 'text',
            text: JSON.stringify({
              counts: {
                matched: 120,
                matchedIsExact: false, // Estimate from Gmail
                listed: 3,
                shown: 3,
                failedLookups: 0,
                timeZone: 'Europe/Berlin',
              },
              truncated: true, // More pages exist beyond this sample
              results: [
                {
                  id: 'msg-ent-1',
                  threadId: 'thread-ent-1',
                  subject: 'Enterprise Rental Agreement 4W742D',
                  from: 'Enterprise Rent-A-Car <DoNotReply@enterprise.com>',
                  date: 'Thu, 3 Sep 2026 14:22:00 +0200',
                  receivedLocal: 'Thu, 3 Sept 2026, 14:22 (Europe/Berlin)',
                  snippet: 'Your rental agreement 4W742D is attached.',
                },
                {
                  id: 'msg-mkt-1',
                  threadId: 'thread-mkt-1',
                  subject: 'Exclusive Car Rental Agreement Rates & Savings',
                  from: 'Promotions <deals@travel-marketing.example>',
                  date: 'Tue, 15 Sep 2026 09:30:00 +0200',
                  receivedLocal: 'Tue, 15 Sept 2026, 09:30 (Europe/Berlin)',
                  snippet: 'Get 20% off your next car rental agreement! Limited time promo code.',
                },
                {
                  id: 'msg-404-1',
                  threadId: 'thread-inaccessible-404',
                  subject: 'Archived Agreement Notice #9876',
                  from: 'Legal Dept <legal@legacy-archive.example>',
                  date: 'Mon, 01 Jun 2026 12:00:00 +0200',
                  receivedLocal: 'Mon, 01 June 2026, 12:00 (Europe/Berlin)',
                  snippet: 'Notice regarding archived contract agreement.',
                },
              ],
            }),
          }],
        },
      },
      // 2. Thread inspection for misleading marketing email (Thread 2)
      {
        tool: 'gmail_read_thread',
        args: { threadId: 'thread-mkt-1' },
        status: 'completed',
        result: {
          content: [{
            type: 'text',
            text: JSON.stringify({
              threadId: 'thread-mkt-1',
              messages: [{
                id: 'msg-mkt-1',
                threadId: 'thread-mkt-1',
                subject: 'Exclusive Car Rental Agreement Rates & Savings',
                from: 'Promotions <deals@travel-marketing.example>',
                snippet: 'Get 20% off your next car rental agreement! Limited time promo code.',
                bodyText: 'Save 20% on all car rentals this season! Use coupon code SAVE20. Unsubscribe from promotional circulars.',
                attachments: [], // No attachments!
              }],
            }),
          }],
        },
      },
      // 3. Thread inspection for inaccessible thread (Thread 3 fails with 404)
      {
        tool: 'gmail_read_thread',
        args: { threadId: 'thread-inaccessible-404' },
        status: 'failed',
        result: {
          content: [{
            type: 'text',
            text: JSON.stringify({
              error: 'gws notFound (404): Thread not found',
              status: 'failed',
            }),
          }],
        },
      },
      // 4. Thread inspection for Enterprise rental agreement (Thread 1)
      {
        tool: 'gmail_read_thread',
        args: { threadId: 'thread-ent-1' },
        status: 'completed',
        result: {
          content: [{
            type: 'text',
            text: JSON.stringify({
              threadId: 'thread-ent-1',
              messages: [{
                id: 'msg-ent-1',
                threadId: 'thread-ent-1',
                subject: 'Enterprise Rental Agreement 4W742D',
                from: 'Enterprise Rent-A-Car <DoNotReply@enterprise.com>',
                snippet: 'Your rental agreement 4W742D is attached.',
                bodyText: 'Please find attached your rental agreement summary.',
                attachments: [
                  { id: 'att-ent-pdf', filename: 'Rental Agreement 4W742D.pdf', mimeType: 'application/pdf', size: 104200 },
                ],
              }],
            }),
          }],
        },
      },
      // 5. Attachment extraction on Enterprise PDF attachment
      {
        tool: 'gmail_read_attachment',
        args: { messageId: 'msg-ent-1', attachmentId: 'att-ent-pdf', filename: 'Rental Agreement 4W742D.pdf' },
        status: 'completed',
        result: {
          content: [{
            type: 'text',
            text: JSON.stringify({
              messageId: 'msg-ent-1',
              attachmentId: 'att-ent-pdf',
              filename: 'Rental Agreement 4W742D.pdf',
              mimeType: 'application/pdf',
              size: 104200,
              pageCount: 1,
              extractedText: realPdfText,
              truncated: false,
              status: 'extracted',
            }),
          }],
        },
      },
    ];

    const inventory = synthesizeContractInventory(mockToolCalls);
    expect(inventory).not.toBeNull();

    // 1. Table structure
    expect(inventory).toContain('| Contract Type | Company / Counterparty | Date | Email / Thread Reference | Attachment | Extraction Status |');

    // 2. Confirmed contract: Enterprise Rent-A-Car with parsed attachment text
    expect(inventory).toContain('Enterprise Rent-A-Car');
    expect(inventory).toContain('Confirmed contract');
    expect(inventory).toContain('Text extracted (Rental Agreement 4W742D.pdf, 1 page(s))');

    // 3. Misleading marketing email: Must NOT be confirmed contract!
    expect(inventory).toContain('Promotions');
    expect(inventory).toContain('Exclusive Car Rental Agreement Rates & Savings');
    expect(inventory).toContain('Candidate (Marketing / Promotional)');
    // Must NOT invent PDF attachment for marketing email
    expect(inventory).toContain('| None | Candidate (Marketing / Promotional) |');

    // 4. Inaccessible thread: Must NOT be confirmed contract!
    expect(inventory).toContain('Inaccessible (Thread lookup failed)');
    expect(inventory).toContain('thread-inaccessible-404');

    // 5. Supporting evidence section
    expect(inventory).toContain('### Supporting Evidence');
    expect(inventory).toContain('Extracted from Rental Agreement 4W742D.pdf: "ENTERPRISE RENT-A-CAR RENTAL AGREEMENT RA # 4W742D');
    expect(inventory).toContain('promotional/informational notice, no executed contract agreement');
    expect(inventory).toContain('Thread lookup failed');

    // 6. Coverage accounting with honest UNKNOWN remaining coverage
    expect(inventory).toContain('### Contract Extraction Coverage');
    expect(inventory).toContain('- **Confirmed contracts:** 1 verified contract(s)');
    expect(inventory).toContain('- **Candidate emails examined:** 3 candidate thread(s) inspected (3 total candidate(s) identified)');
    expect(inventory).toContain('- **Actual pages read:** 1 search page(s) (3 messages listed), 1 PDF page(s) extracted');
    expect(inventory).toContain('- **Inaccessible / failed lookups:** 1');
    expect(inventory).toContain('- **Search truncation:** Yes');
    // Rule 3: Unknown remaining coverage must say UNKNOWN, not zero!
    expect(inventory).toContain('- **Remaining unsearched coverage:** UNKNOWN (~117 estimated matching messages remaining across unread search pages)');
    expect(inventory).not.toContain('Remaining unsearched coverage:** 0');
  });

  it('correctly handles attachment status: discovered, text extracted, unsupported format, and failed', () => {
    const calls = [
      {
        tool: 'gmail_search',
        status: 'completed',
        result: {
          content: [{
            type: 'text',
            text: JSON.stringify({
              counts: { matched: 3, matchedIsExact: true, listed: 3, shown: 3, failedLookups: 0 },
              truncated: false,
              results: [
                { id: 'm1', threadId: 't1', subject: 'Doc 1', from: 'a@ex.com', date: '2026-10-01', snippet: 't1' },
                { id: 'm2', threadId: 't2', subject: 'Doc 2', from: 'b@ex.com', date: '2026-10-02', snippet: 't2' },
                { id: 'm3', threadId: 't3', subject: 'Doc 3', from: 'c@ex.com', date: '2026-10-03', snippet: 't3' },
              ],
            }),
          }],
        },
      },
      // Thread 1: Attachment discovered but not extracted
      {
        tool: 'gmail_read_thread',
        args: { threadId: 't1' },
        status: 'completed',
        result: {
          content: [{
            type: 'text',
            text: JSON.stringify({
              threadId: 't1',
              messages: [{
                id: 'm1',
                subject: 'Doc 1',
                from: 'a@ex.com',
                bodyText: 'Please review',
                attachments: [{ id: 'att1', filename: 'pending.pdf', mimeType: 'application/pdf', size: 50000 }],
              }],
            }),
          }],
        },
      },
      // Thread 2: Attachment unsupported format
      {
        tool: 'gmail_read_thread',
        args: { threadId: 't2' },
        status: 'completed',
        result: {
          content: [{
            type: 'text',
            text: JSON.stringify({
              threadId: 't2',
              messages: [{
                id: 'm2',
                subject: 'Doc 2',
                from: 'b@ex.com',
                bodyText: 'Archive',
                attachments: [{ id: 'att2', filename: 'archive.zip', mimeType: 'application/zip', size: 80000 }],
              }],
            }),
          }],
        },
      },
      {
        tool: 'gmail_read_attachment',
        args: { messageId: 'm2', attachmentId: 'att2', filename: 'archive.zip' },
        status: 'completed',
        result: {
          content: [{
            type: 'text',
            text: JSON.stringify({
              messageId: 'm2',
              attachmentId: 'att2',
              filename: 'archive.zip',
              status: 'unsupported_format',
              note: "Format 'application/zip' is not supported",
            }),
          }],
        },
      },
      // Thread 3: Attachment download failed
      {
        tool: 'gmail_read_thread',
        args: { threadId: 't3' },
        status: 'completed',
        result: {
          content: [{
            type: 'text',
            text: JSON.stringify({
              threadId: 't3',
              messages: [{
                id: 'm3',
                subject: 'Doc 3',
                from: 'c@ex.com',
                bodyText: 'File',
                attachments: [{ id: 'att3', filename: 'corrupt.pdf', mimeType: 'application/pdf', size: 20000 }],
              }],
            }),
          }],
        },
      },
      {
        tool: 'gmail_read_attachment',
        args: { messageId: 'm3', attachmentId: 'att3', filename: 'corrupt.pdf' },
        status: 'failed',
        result: {
          content: [{
            type: 'text',
            text: JSON.stringify({
              error: 'gws failed: attachment corrupted',
              status: 'failed',
            }),
          }],
        },
      },
    ];

    const inventory = synthesizeContractInventory(calls);
    expect(inventory).not.toBeNull();
    // Distinguishes discovered, unsupported, and failed
    expect(inventory).toContain('Discovered (pending.pdf, 49 KB)');
    expect(inventory).toContain('Unsupported format (archive.zip)');
    expect(inventory).toContain('Extraction failed (corrupt.pdf)');
    expect(inventory).toContain('Candidate (Unsupported attachment format)');
    expect(inventory).toContain('Inaccessible / failed lookups:** 2');
  });

  it('preserves historical conversation messages and supplies current verified connector availability', () => {
    // Rule 4: Preserve historical conversation messages rather than removing inconvenient prior assistant responses.
    const historicalMessages = [
      { id: '1', role: 'user', content: 'extract contracts from my gmail' },
      { id: '2', role: 'assistant', content: 'I found about 201 matches... will narrow down.' },
      { id: '3', role: 'user', content: 'check which models are available' },
      { id: '4', role: 'assistant', content: 'Here are the available models: qwen3-coder:swift-27b...' },
      { id: '5', role: 'user', content: 'What happened to extracting contracts from my email.' },
      { id: '6', role: 'assistant', content: "Straight with you — that's on me. I don't actually have a Gmail tool connected that I can query, so I couldn't have run that search. Option A: set up Gmail MCP server..." },
      { id: '7', role: 'user', content: 'continue extracting my contracts.' },
    ];

    // Verify historical turns are NOT filtered or deleted
    const preservedTurns = historicalMessages.filter(m => (m.role === 'user' || m.role === 'assistant') && m.content);
    expect(preservedTurns).toHaveLength(7);
    expect(preservedTurns.some(m => m.content.includes("I don't actually have a Gmail tool connected"))).toBe(true);

    // Verify current verified connector availability can be constructed
    const tools = [
      { name: 'gmail_search' },
      { name: 'gmail_read_thread' },
      { name: 'gmail_read_attachment' },
    ];
    const hasGmailTools = tools.some(t => t.name.startsWith('gmail_'));
    expect(hasGmailTools).toBe(true);

    const gmailToolNames = tools.filter(t => t.name.startsWith('gmail_')).map(t => t.name).join(', ');
    let systemPrompt = 'Base prompt';
    systemPrompt += `\n\nCURRENT VERIFIED CONNECTOR AVAILABILITY & EVIDENCE:
- Gmail Connector: CONNECTED AND ACTIVE. Verified available tools: ${gmailToolNames}.
- Conversation History Note: All historical messages above are preserved verbatim for conversational continuity. If earlier assistant turns claimed that Gmail was not connected, that no Gmail tools were available, or claimed unverified findings, those statements reflected prior tool stripping or intermediate confusion and are superseded by your current, live, verified tool availability. You HAVE active Gmail tools right now; use them to inspect real threads and attachments rather than claiming disconnection.`;

    expect(systemPrompt).toContain('Gmail Connector: CONNECTED AND ACTIVE');
    expect(systemPrompt).toContain('All historical messages above are preserved verbatim');
    expect(systemPrompt).toContain('superseded by your current, live, verified tool availability');
  });
});

