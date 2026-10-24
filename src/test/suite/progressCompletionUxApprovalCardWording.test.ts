import { describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { TextDecoder, TextEncoder } from 'util';
import { JSDOM } from 'jsdom';

/**
 * Progress & Completion UX V1 — Step 3 closure pass (generic tool approval
 * card). `addApprovalCard` (media/chat.js) is the live approval surface for
 * any tool needing approval — including Saath Kar's `propose_file_change` —
 * and previously showed only a generic '⚡ Approval Required' title plus the
 * raw tool name, risk level, and full argument JSON always visible on the
 * primary surface. This proves: a known mutating tool now gets a plain-
 * language "why" line and, when the tool call names one, an explicit
 * "Affects: <path>" scope line; the raw tool/JSON evidence is preserved
 * (never deleted) but moved behind a details disclosure; approve/reject
 * dataset wiring — the actual approval semantics — is unchanged.
 */

const root = path.join(__dirname, '..', '..', '..');
const read = (relativePath: string) => fs.readFileSync(path.join(root, relativePath), 'utf8');

function setupWebview() {
  const dom = new JSDOM(read('media/chat.html'), {
    runScripts: 'outside-only',
    pretendToBeVisual: true,
    url: 'https://karkedikha.test/',
  });
  const { window } = dom;
  const posted: Array<Record<string, unknown>> = [];
  const vscodeApi = { postMessage(message: Record<string, unknown>) { posted.push(message); }, getState: () => ({}), setState() {} };
  Object.defineProperty(window, '__ollamaAgentVsCodeApi', { value: vscodeApi });
  Object.defineProperty(window, 'acquireVsCodeApi', { value: () => vscodeApi });
  Object.defineProperty(window, '__pandaBaseUri', { value: '' });
  Object.defineProperty(window, 'TextEncoder', { value: TextEncoder });
  Object.defineProperty(window, 'TextDecoder', { value: TextDecoder });
  Object.defineProperty(window, 'matchMedia', {
    value: () => ({ matches: true, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} }),
  });
  window.HTMLElement.prototype.scrollIntoView = function scrollIntoView() {};
  window.eval(read('media/chat.js'));
  return { dom, window, posted };
}

describe('Progress & Completion UX V1 — generic tool approval card wording', () => {
  it('gives a known mutating tool a plain-language why line and an explicit scope line', () => {
    const { dom, window } = setupWebview();
    try {
      window.dispatchEvent(new window.MessageEvent('message', {
        data: {
          type: 'approvalRequest',
          id: 'apr_1',
          toolName: 'propose_file_change',
          args: { path: 'src/users.js', content: 'module.exports = {};' },
          reason: 'This tool requires approval under the current permission profile.',
          riskLevel: 'medium',
        },
      }));
      const card = window.document.getElementById('approval-apr_1')!;
      expect(card.querySelector('.everyday-approval-why')?.textContent).toBe('This will change a file.');
      expect(card.querySelector('.everyday-approval-scope')?.textContent).toBe('Affects: src/users.js');
    } finally {
      dom.window.close();
    }
  });

  it('keeps the raw tool name and full argument JSON available, but only behind a details disclosure, not on the primary surface', () => {
    const { dom, window } = setupWebview();
    try {
      window.dispatchEvent(new window.MessageEvent('message', {
        data: {
          type: 'approvalRequest',
          id: 'apr_2',
          toolName: 'propose_file_change',
          args: { path: 'src/users.js', content: 'a very long proposed file body' },
          reason: 'Approval required.',
          riskLevel: 'medium',
        },
      }));
      const card = window.document.getElementById('approval-apr_2')!;
      const details = card.querySelector('details.everyday-details') as HTMLDetailsElement;
      expect(details).not.toBeNull();
      expect(details.open).toBe(false);
      expect(details.querySelector('summary')?.textContent).toBe('Details');
      const rawBlock = details.querySelector('.approval-tool');
      expect(rawBlock?.textContent).toContain('propose_file_change');
      expect(rawBlock?.textContent).toContain('a very long proposed file body');
      // Not duplicated outside the disclosure.
      expect(card.querySelectorAll('.approval-tool')).toHaveLength(1);
    } finally {
      dom.window.close();
    }
  });

  it('falls back to the generic title and adds no invented why/scope line for an unlisted tool', () => {
    const { dom, window } = setupWebview();
    try {
      window.dispatchEvent(new window.MessageEvent('message', {
        data: {
          type: 'approvalRequest',
          id: 'apr_3',
          toolName: 'some_future_tool',
          args: {},
          reason: 'Approval required.',
          riskLevel: 'low',
        },
      }));
      const card = window.document.getElementById('approval-apr_3')!;
      expect(card.querySelector('.approval-title')?.textContent).toBe('⚡ Approval Required');
      expect(card.querySelector('.everyday-approval-why')).toBeNull();
      expect(card.querySelector('.everyday-approval-scope')).toBeNull();
    } finally {
      dom.window.close();
    }
  });

  it('leaves the approve/reject dataset wiring exactly as before', () => {
    const { dom, window, posted } = setupWebview();
    try {
      window.dispatchEvent(new window.MessageEvent('message', {
        data: {
          type: 'approvalRequest',
          id: 'apr_4',
          toolName: 'run_command',
          args: { command: 'npm test' },
          reason: 'Approval required.',
          riskLevel: 'high',
        },
      }));
      const card = window.document.getElementById('approval-apr_4')!;
      const approve = card.querySelector('button.btn-primary') as HTMLButtonElement;
      expect(approve.dataset.approvalId).toBe('apr_4');
      expect(approve.dataset.approvalResponse).toBe('approved');
      approve.click();
      expect(posted).toContainEqual({ type: 'approvalResponse', id: 'apr_4', response: 'approved' });
    } finally {
      dom.window.close();
    }
  });
});
