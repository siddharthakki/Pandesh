import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import { NON_WORKSPACE_MARKERS } from '../domain/taskToolSurface';
import { summarizeGmailMessage, type GmailApiMessage } from '../runtime/connectors/gmailMime';
import { createGwsGmailExecutor, type GwsGmailAdapterConfig } from '../runtime/connectors/gwsGmailAdapter';
import { classifyContract, synthesizeContractInventory } from '../domain/contractInventory';
import { evaluateConnectorTruth, formatConnectorTruthPrompt } from '../domain/connectorTruth';
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

  it('preserves historical conversation messages and supplies current connector tool availability', () => {
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

    // Verify connector truth state distinguishes tool availability from verified access
    const tools = [
      { name: 'gmail_search' },
      { name: 'gmail_read_thread' },
      { name: 'gmail_read_attachment' },
    ];
    const connectorState = evaluateConnectorTruth(tools);
    expect(connectorState.hasTools).toBe(true);

    const systemPrompt = 'Base prompt' + formatConnectorTruthPrompt(connectorState);
    expect(systemPrompt).toContain('Tool Availability: Available (gmail_search, gmail_read_thread, gmail_read_attachment)');
    expect(systemPrompt).toContain('Authentication Status: untested');
    expect(systemPrompt).toContain('All historical messages above are preserved verbatim');
    expect(systemPrompt).toContain('note that Gmail tools are currently available in your tool list');
    expect(systemPrompt).not.toContain('CONNECTED AND ACTIVE');
  });

  it('Regression 1: Contract confirmation requires contract-specific evidence and distinguishes contract documents from executed agreements', () => {
    // 1. Generic words ("vehicle", "total") in extracted attachment text MUST NOT confirm a contract
    const genericReceipt = classifyContract(
      'Receipt for Service',
      'Here is your receipt',
      'Service Center <service@auto.example>',
      [],
      {
        inspected: true,
        attachmentExtracted: true,
        extractedText: 'VEHICLE SERVICE RECEIPT\nVehicle: Tesla Model 3\nService: Tire Rotation\nTotal: $350.00\nPayment Method: Visa',
        attachmentFilename: 'receipt.pdf',
      }
    );
    expect(genericReceipt.status).not.toContain('Confirmed');
    expect(genericReceipt.status).toBe('Candidate (Extracted text contains no contract terms)');

    // 2. Metadata from subject MUST NOT establish confirmation when body text lacks contract terms
    const subjectMetadataOnly = classifyContract(
      'Confirmed Executed Lease Agreement #998877',
      'Agreement notice',
      'Landlord <landlord@rental.example>',
      [],
      {
        inspected: true,
        bodyText: 'Hi, here are the parking instructions and directions for your visit.',
      }
    );
    expect(subjectMetadataOnly.status).not.toContain('Confirmed');
    expect(subjectMetadataOnly.status).toBe('Candidate (Body inspected - no contract terms)');

    // 3. Contract document with contract terms but lacking signature/execution MUST NOT be marked confirmed contract
    const unexecutedNda = classifyContract(
      'Mutual Non-Disclosure Agreement',
      'Please find NDA draft attached',
      'Partner <partner@collab.example>',
      [],
      {
        inspected: true,
        attachmentExtracted: true,
        extractedText: 'MUTUAL NON-DISCLOSURE AGREEMENT\nThis Agreement is made by and between the parties. The parties agree to hold proprietary information in confidence. Governing Law: State of New York.',
        attachmentFilename: 'NDA_Draft.pdf',
      }
    );
    expect(unexecutedNda.status).not.toContain('Confirmed');
    expect(unexecutedNda.status).toBe('Contract document (Unexecuted / terms extracted)');
    expect(unexecutedNda.type).toBe('Non-Disclosure Agreement (NDA)');

    // 4. Agreement with contract terms AND verified signature/execution evidence IS confirmed
    const executedAgreement = classifyContract(
      'Enterprise Rental Agreement',
      'Rental Agreement summary',
      'Enterprise Rent-A-Car <DoNotReply@enterprise.com>',
      [],
      {
        inspected: true,
        attachmentExtracted: true,
        extractedText: 'ENTERPRISE RENT-A-CAR RENTAL AGREEMENT RA # 4W742D Vehicle Tesla Model 3 Total $350.00 Renter Signature: Verified',
        attachmentFilename: 'Rental_Agreement_4W742D.pdf',
      }
    );
    expect(executedAgreement.status).toContain('Confirmed contract (Verified executed agreement)');
  });

  it('Regression 2: Coverage tracks searches separately, distinguishes thread inspection states, and never reports zero remaining unless exhaustive', () => {
    // Two separate searches with different queries and candidate threads
    const searchCalls = [
      {
        tool: 'gmail_search',
        args: { q: 'rental agreement' },
        status: 'completed',
        result: {
          content: [{
            type: 'text',
            text: JSON.stringify({
              counts: { matched: 3, matchedIsExact: true, listed: 3, shown: 3, failedLookups: 0 },
              truncated: false,
              results: [
                { id: 'm1', threadId: 't1', subject: 'Rental Agreement 1', from: 'rent1@example.com', date: '2026-10-01', snippet: 'Agreement 1' },
                { id: 'm2', threadId: 't2', subject: 'Rental Agreement 2', from: 'rent2@example.com', date: '2026-10-02', snippet: 'Agreement 2' },
                { id: 'm3', threadId: 't3', subject: 'Rental Agreement 3', from: 'rent3@example.com', date: '2026-10-03', snippet: 'Agreement 3' },
              ],
            }),
          }],
        },
      },
      {
        tool: 'gmail_search',
        args: { q: 'employment contract' },
        status: 'completed',
        result: {
          content: [{
            type: 'text',
            text: JSON.stringify({
              counts: { matched: 2, matchedIsExact: true, listed: 2, shown: 2, failedLookups: 0 },
              truncated: false,
              results: [
                { id: 'm4', threadId: 't4', subject: 'Offer Letter', from: 'hr@example.com', date: '2026-10-04', snippet: 'Offer' },
                { id: 'm5', threadId: 't5', subject: 'Consulting Contract', from: 'hr@example.com', date: '2026-10-05', snippet: 'Consulting' },
              ],
            }),
          }],
        },
      },
      // Only thread t1 and t2 are inspected. Threads t3, t4, t5 remain UNINSPECTED!
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
                subject: 'Rental Agreement 1',
                from: 'rent1@example.com',
                bodyText: 'ENTERPRISE RENT-A-CAR RENTAL AGREEMENT RA # 112233',
                attachments: [],
              }],
            }),
          }],
        },
      },
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
                subject: 'Rental Agreement 2',
                from: 'rent2@example.com',
                bodyText: 'Discussion regarding schedule',
                attachments: [],
              }],
            }),
          }],
        },
      },
    ];

    const partialInventory = synthesizeContractInventory(searchCalls);
    expect(partialInventory).not.toBeNull();

    // 1. Searches tracked separately
    expect(partialInventory).toContain('- **Searches tracked:** 2 search(es)');
    expect(partialInventory).toContain('"rental agreement": 3/3 listed');
    expect(partialInventory).toContain('"employment contract": 2/2 listed');

    // 2. Thread inspection breakdown: 2 inspected, 3 uninspected (5 total identified)
    expect(partialInventory).toContain('- **Thread inspection breakdown:** 2 inspected, 3 uninspected (5 total identified)');

    // 3. Must NEVER report 0 remaining when coverage is not exhaustive!
    expect(partialInventory).toContain('- **Remaining unsearched coverage:** UNKNOWN (3 identified candidate thread(s) remain uninspected)');
    expect(partialInventory).not.toContain('Remaining unsearched coverage:** 0');

    // 4. When all remaining threads are inspected, coverage becomes exhaustive and reports 0
    const exhaustiveCalls = [
      ...searchCalls,
      {
        tool: 'gmail_read_thread',
        args: { threadId: 't3' },
        status: 'completed',
        result: { content: [{ type: 'text', text: JSON.stringify({ threadId: 't3', messages: [{ id: 'm3', bodyText: 'Just an invoice', attachments: [] }] }) }] },
      },
      {
        tool: 'gmail_read_thread',
        args: { threadId: 't4' },
        status: 'completed',
        result: { content: [{ type: 'text', text: JSON.stringify({ threadId: 't4', messages: [{ id: 'm4', bodyText: 'Offer letter details', attachments: [] }] }) }] },
      },
      {
        tool: 'gmail_read_thread',
        args: { threadId: 't5' },
        status: 'completed',
        result: { content: [{ type: 'text', text: JSON.stringify({ threadId: 't5', messages: [{ id: 'm5', bodyText: 'Consulting agreement details', attachments: [] }] }) }] },
      },
    ];

    const fullInventory = synthesizeContractInventory(exhaustiveCalls);
    expect(fullInventory).not.toBeNull();
    expect(fullInventory).toContain('- **Thread inspection breakdown:** 5 inspected, 0 uninspected (5 total identified)');
    expect(fullInventory).toContain('- **Remaining unsearched coverage:** 0 matching messages remaining');
  });

  it('Regression 3: Connector truth distinguishes tool availability from successful authentication and completed execution', () => {
    const tools = [
      { name: 'gmail_search' },
      { name: 'gmail_read_thread' },
      { name: 'gmail_read_attachment' },
    ];

    // 1. Tool availability alone MUST NOT claim "verified access" or "CONNECTED AND ACTIVE"
    const uninvokedState = evaluateConnectorTruth(tools);
    expect(uninvokedState.hasTools).toBe(true);
    expect(uninvokedState.toolAvailability).toBe('available');
    expect(uninvokedState.authenticationStatus).toBe('untested');
    expect(uninvokedState.executionStatus).toBe('not_invoked');
    expect(uninvokedState.completedExecutions).toBe(0);

    const promptUninvoked = formatConnectorTruthPrompt(uninvokedState);
    expect(promptUninvoked).not.toContain('CONNECTED AND ACTIVE');
    expect(promptUninvoked).not.toContain('verified access');
    expect(promptUninvoked).toContain('Tool Availability: Available (gmail_search, gmail_read_thread, gmail_read_attachment)');
    expect(promptUninvoked).toContain('Authentication Status: untested');
    expect(promptUninvoked).toContain('Execution Status: not invoked in this turn/session');

    // 2. Distinguishes failed/unauthenticated execution
    const failedState = evaluateConnectorTruth(tools, {
      toolCalls: [{ tool: 'gmail_search', status: 'failed' }],
    });
    expect(failedState.authenticationStatus).toBe('unauthenticated');
    expect(failedState.executionStatus).toBe('failed');
    const promptFailed = formatConnectorTruthPrompt(failedState);
    expect(promptFailed).toContain('Authentication Status: unauthenticated or failed');
    expect(promptFailed).toContain('Execution Status: failed (1 failed invocation(s))');

    // 3. Successful authentication and completed execution verified ONLY when tools succeed
    const completedState = evaluateConnectorTruth(tools, {
      toolCalls: [
        { tool: 'gmail_search', status: 'completed' },
        { tool: 'gmail_read_thread', status: 'completed' },
      ],
    });
    expect(completedState.authenticationStatus).toBe('verified');
    expect(completedState.executionStatus).toBe('completed');
    expect(completedState.completedExecutions).toBe(2);
    const promptCompleted = formatConnectorTruthPrompt(completedState);
    expect(promptCompleted).toContain('Authentication Status: verified (2 completed execution(s))');
    expect(promptCompleted).toContain('Execution Status: completed (2 successful invocation(s))');
  });
});

