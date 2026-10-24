// External UI automation for the packaged-VSIX acceptance harness.
//
// This runs as a plain Node process OUTSIDE the Extension Development Host
// and operates the real, rendered production UI over the Chrome DevTools
// Protocol (CDP) — the native debugging protocol already built into the
// exact Electron/Chromium build VS Code ships, reached via
// `--remote-debugging-port`. This avoids vscode-extension-tester's
// chromedriver/VS-Code-version matching risk entirely: there is no separate
// driver binary to version-match, because CDP talks directly to the same
// renderer process under test.
//
// It never calls vscode.window.* APIs and never patches production code.
// It only:
//   - polls the real DOM for the production QuickPick / modal dialog widget
//     VS Code itself renders (`.quick-input-widget`, `.monaco-dialog-box`);
//   - dispatches real keyboard/mouse input via the CDP Input domain to
//     interact with what's on screen (Escape to dismiss/reject a QuickPick,
//     or a click on a named button in a modal).

import CDP from 'chrome-remote-interface';
import * as fs from 'fs';
import * as path from 'path';

export async function connect(port, { attempts = 30, delayMs = 500 } = {}) {
  let lastError;
  for (let i = 0; i < attempts; i += 1) {
    try {
      const targets = await CDP.List({ port });
      const pageTarget = targets.find(t => t.type === 'page');
      if (!pageTarget) throw new Error('no page target yet');
      const client = await CDP({ port, target: pageTarget.id });
      await client.Runtime.enable();
      await client.DOM.enable();
      await client.Page.enable();
      // VS Code's non-ignoreFocusOut QuickPicks and modal dialogs
      // self-dismiss when the window is not OS-focused. A window launched
      // headlessly under test-electron and merely attached to over CDP may
      // never receive real OS focus, so explicitly bring it to the
      // foreground before driving any UI that depends on focus retention.
      await client.Page.bringToFront();
      return client;
    } catch (error) {
      lastError = error;
      await new Promise(r => setTimeout(r, delayMs));
    }
  }
  throw new Error(`could not attach CDP client on port ${port} after ${attempts} attempts: ${lastError?.message}`);
}

async function evaluateExpr(client, expression) {
  const { result, exceptionDetails } = await client.Runtime.evaluate({ expression, returnByValue: true });
  if (exceptionDetails) {
    throw new Error(`CDP Runtime.evaluate threw: ${exceptionDetails.text}`);
  }
  return result.value;
}

/**
 * Poll the real rendered DOM until a QuickPick with the given title substring
 * appears, or the timeout elapses. Uses bounded condition polling, not a
 * fixed sleep.
 */
export async function waitForQuickPick(client, titleSubstring, { timeoutMs = 30000, intervalMs = 300 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const title = await evaluateExpr(
      client,
      `(() => {
        const el = document.querySelector('.quick-input-widget .quick-input-title');
        return el ? el.textContent : null;
      })()`,
    );
    if (title && title.includes(titleSubstring)) {
      return title;
    }
    await new Promise(r => setTimeout(r, intervalMs));
  }
  throw new Error(`timed out after ${timeoutMs}ms waiting for QuickPick titled like "${titleSubstring}"`);
}

/**
 * Poll for a real rendered modal dialog (vscode.window.showWarningMessage
 * with {modal:true}) containing the given message substring.
 */
export async function waitForModalDialog(client, messageSubstring, { timeoutMs = 30000, intervalMs = 300 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const text = await evaluateExpr(
      client,
      `(() => {
        const el = document.querySelector('.monaco-dialog-box .dialog-message-text, .monaco-dialog-box .dialog-message-detail');
        return el ? el.textContent : null;
      })()`,
    );
    if (text && text.includes(messageSubstring)) {
      return text;
    }
    await new Promise(r => setTimeout(r, intervalMs));
  }
  throw new Error(`timed out after ${timeoutMs}ms waiting for modal dialog containing "${messageSubstring}"`);
}

async function dispatchKey(client, { keyCode, key, code }) {
  await client.Input.dispatchKeyEvent({ type: 'keyDown', windowsVirtualKeyCode: keyCode, key, code });
  await client.Input.dispatchKeyEvent({ type: 'keyUp', windowsVirtualKeyCode: keyCode, key, code });
}

/** Dismiss the currently-visible QuickPick with Escape (production reject path: `reviewProposal` resolves falsy). */
export async function pressEscapeToRejectQuickPick(client) {
  await dispatchKey(client, { keyCode: 27, key: 'Escape', code: 'Escape' });
}

/**
 * Accept the currently-visible QuickPick via Enter (production approve path:
 * `reviewProposal` resolves truthy). Uses the keyboard rather than a
 * coordinate-based click: the QuickPick's default-focused row is accepted,
 * and there is no risk of a stray click coordinate landing on whatever
 * widget (e.g. the very next execution-approval modal) happens to render at
 * the same screen position immediately after the QuickPick closes.
 */
export async function acceptQuickPickFirstItem(client) {
  const hasRows = await evaluateExpr(
    client,
    `document.querySelectorAll('.quick-input-widget .monaco-list-row').length > 0`,
  );
  if (!hasRows) {
    throw new Error('no QuickPick item rows found to accept');
  }
  await dispatchKey(client, { keyCode: 13, key: 'Enter', code: 'Enter' });
}

/** Click a named button in the currently-visible modal dialog (e.g. "Approve Execution"). */
export async function clickModalButton(client, buttonLabel) {
  const clicked = await evaluateExpr(
    client,
    `(() => {
      const buttons = Array.from(document.querySelectorAll('.monaco-dialog-box .dialog-buttons a.monaco-button, .monaco-dialog-box .dialog-buttons button'));
      const target = buttons.find(b => (b.textContent || '').trim() === ${JSON.stringify(buttonLabel)});
      if (!target) return false;
      const rect = target.getBoundingClientRect();
      window.__oaAcceptanceClickRect = { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
      return true;
    })()`,
  );
  if (!clicked) {
    throw new Error(`modal button "${buttonLabel}" not found in the rendered dialog`);
  }
  const point = await evaluateExpr(client, 'window.__oaAcceptanceClickRect');
  await client.Input.dispatchMouseEvent({ type: 'mousePressed', x: point.x, y: point.y, button: 'left', clickCount: 1 });
  await new Promise(r => setTimeout(r, 50));
  await client.Input.dispatchMouseEvent({ type: 'mouseReleased', x: point.x, y: point.y, button: 'left', clickCount: 1 });
}

/** Escape/dismiss any currently-visible QuickPick without asserting its title (used for cleanup on failure paths). */
export async function dismissAnyQuickPick(client) {
  await dispatchKey(client, { keyCode: 27, key: 'Escape', code: 'Escape' });
}

/**
 * Connect directly to the real KarkeDikha WebviewView's own CDP target.
 *
 * VS Code renders each WebviewView as its own top-level `iframe`-type CDP
 * target (url `vscode-webview://<uuid>/index.html?...`), separate from the
 * main workbench `page` target — confirmed empirically via `CDP.List`. That
 * outer document is VS Code's generic webview host chrome; the real
 * extension-authored content (media/chat.html + every media/*.js file) is
 * loaded into a same-origin nested `<iframe id="active-frame">` inside it
 * (same `vscode-webview://<uuid>` origin, different path), so its
 * `contentDocument` is directly reachable via plain same-origin DOM access
 * from the outer target's default execution context — no second CDP target,
 * session, or execution-context juggling required.
 */
export async function connectToWebviewHostTarget(
  port,
  { attempts = 60, delayMs = 500, targetId = null, excludeIds = [] } = {},
) {
  let lastError;
  const excluded = new Set(excludeIds);
  for (let i = 0; i < attempts; i += 1) {
    try {
      const targets = await CDP.List({ port });
      const webviewTarget = targets.find(
        t => t.type === 'iframe'
          && t.url.startsWith('vscode-webview://')
          && t.url.includes('/index.html')
          && (targetId ? t.id === targetId : !excluded.has(t.id)),
      );
      if (webviewTarget) {
        const client = await CDP({ port, target: webviewTarget.id });
        await client.Runtime.enable();
        return { client, targetId: webviewTarget.id };
      }
    } catch (error) {
      lastError = error;
    }
    await new Promise(r => setTimeout(r, delayMs));
  }
  throw new Error(
    `could not find the KarkeDikha webview iframe CDP target on port ${port} after ${attempts} attempts`
      + ` (targetId=${targetId ?? 'new'}, excluded=${[...excluded].join(',') || 'none'}): ${lastError?.message}`,
  );
}

export async function connectToWebviewHost(port, options = {}) {
  return (await connectToWebviewHostTarget(port, options)).client;
}

/**
 * Evaluate `docExpression` with `doc` bound to the real chat.html document
 * (media/chat.html + every media/*.js file chat.html loads, exactly as
 * rendered in production) inside the nested `#active-frame` iframe.
 */
export async function evalInWebviewDoc(client, docExpression) {
  // Shadows the outer host document's `document` binding with the real
  // chat.html document so callers can write expressions using the ordinary
  // `document.getElementById(...)` idiom unchanged.
  const wrapped = `(() => {
    // "document" below refers to the outer host document via window.document
    // (not the lexical identifier) so that shadowing it with the inner
    // active-frame document one line later does not trip a temporal-dead-zone
    // ReferenceError on this very lookup.
    const inner = window.document.getElementById('active-frame');
    if (!inner) throw new Error('no #active-frame iframe found in the webview host document');
    const document = inner.contentDocument;
    if (!document) throw new Error('active-frame contentDocument is not accessible (not same-origin, or not yet navigated)');
    return (${docExpression});
  })()`;
  const { result, exceptionDetails } = await client.Runtime.evaluate({ expression: wrapped, returnByValue: true, awaitPromise: false });
  if (exceptionDetails) {
    const detail = exceptionDetails.exception?.description
      || exceptionDetails.exception?.value
      || JSON.stringify(exceptionDetails);
    throw new Error(`webview DOM Runtime.evaluate threw: ${exceptionDetails.text} — ${detail}`);
  }
  return result.value;
}

/**
 * Poll until the real chat.html document has mounted inside #active-frame.
 * Default readiness element is `#proposal-approve-btn` (present once
 * chat-autonomous.js, one of the later files in chat.html's sequential
 * media/*.js loader, has run) — the right signal for scenarios that drive
 * the autonomous/Karke Dikha UI. A scenario that never touches that UI (e.g.
 * a workspaceless Baat Kar session) can pass `readyElementId` to wait on a
 * composer element instead — `#attach-btn`/`#send-btn` are part of chat.html's
 * static markup and are interactive well before every later script in that
 * chain finishes loading.
 */
export async function waitForWebviewContentMounted(client, { timeoutMs = 30000, intervalMs = 300, readyElementId = 'proposal-approve-btn' } = {}) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  let lastValue;
  while (Date.now() < deadline) {
    try {
      lastValue = await evalInWebviewDoc(client, `({ hasBtn: !!document.getElementById(${JSON.stringify(readyElementId)}), title: document.title })`);
      if (lastValue?.hasBtn && lastValue?.title === 'KarkeDikha') return true;
    } catch (error) {
      lastError = error;
      // #active-frame not attached/navigated yet — keep polling.
    }
    await new Promise(r => setTimeout(r, intervalMs));
  }
  throw new Error(
    `timed out after ${timeoutMs}ms waiting for the real KarkeDikha webview content (chat.html + media scripts) to mount (readyElementId=${readyElementId}); ` +
    `lastValue=${JSON.stringify(lastValue)}; lastError=${lastError?.message ?? 'none'}`,
  );
}

/**
 * Snapshot every DOM signal the approval-cycle acceptance test cares about,
 * read directly from the real, unmodified production DOM.
 */
export async function readApprovalCycleDom(client) {
  return evalInWebviewDoc(
    client,
    `({
      proposalApproveDisabled: document.getElementById('proposal-approve-btn')?.disabled,
      proposalReviseDisabled: document.getElementById('proposal-revise-btn')?.disabled,
      proposalRejectDisabled: document.getElementById('proposal-reject-btn')?.disabled,
      proposalRevisionTextDisabled: document.getElementById('proposal-revision-text')?.disabled,
      proposalCardHidden: document.getElementById('proposal-approval-card')?.hidden,
      mutationApproveDisabled: document.getElementById('mutation-approve-btn')?.disabled,
      mutationDenyDisabled: document.getElementById('mutation-deny-btn')?.disabled,
      mutationCardHidden: document.getElementById('mutation-approval-card')?.hidden,
      deliveryReviewDisabled: document.getElementById('delivery-review-btn')?.disabled,
      deliveryApproveDisabled: document.getElementById('delivery-approve-btn')?.disabled,
      deliveryRejectDisabled: document.getElementById('delivery-reject-btn')?.disabled,
      deliveryCardHidden: document.getElementById('delivery-approval-card')?.hidden,
      autonomousStatusHidden: document.getElementById('autonomous-status')?.hidden,
      pandaLabelText: document.getElementById('autonomous-panda-label')?.textContent ?? null,
    })`,
  );
}

/** Real DOM click (via CDP Runtime.evaluate against the real webview document — the same technique clickAutonomousModeButton below already uses) on the restored proposal-approve button, exercising the exact production button-click -> vscode.postMessage -> approveProposal command path. */
export async function clickProposalApproveButton(client) {
  await evalInWebviewDoc(
    client,
    `(() => {
      const btn = document.getElementById('proposal-approve-btn');
      if (!btn) throw new Error('proposal-approve-btn not found');
      if (btn.disabled) throw new Error('proposal-approve-btn is disabled — gate was not restored as actionable');
      btn.click();
      return true;
    })()`,
  );
}

/** Real DOM click on the restored mutation-approve button. */
export async function clickMutationApproveButton(client) {
  await evalInWebviewDoc(
    client,
    `(() => {
      const btn = document.getElementById('mutation-approve-btn');
      if (!btn) throw new Error('mutation-approve-btn not found');
      if (btn.disabled) throw new Error('mutation-approve-btn is disabled — gate was not restored as actionable');
      btn.click();
      return true;
    })()`,
  );
}

/** Real DOM click on the delivery-approve button (final Karke Dikha gate). */
export async function clickDeliveryApproveButton(client) {
  await evalInWebviewDoc(
    client,
    `(() => {
      const btn = document.getElementById('delivery-approve-btn');
      if (!btn) throw new Error('delivery-approve-btn not found');
      if (btn.disabled) throw new Error('delivery-approve-btn is disabled — gate was not restored as actionable');
      btn.click();
      return true;
    })()`,
  );
}

/** Click the real production mode-switch button, then read task/attempt id + panda-label state for Karke Dikha correlation with Core evidence. */
export async function readAutonomousStatusDom(client) {
  return evalInWebviewDoc(
    client,
    `({
      statusHidden: document.getElementById('autonomous-status')?.hidden,
      taskId: document.getElementById('autonomous-task-id')?.textContent ?? null,
      attemptId: document.getElementById('autonomous-attempt-id')?.textContent ?? null,
      pandaLabelText: document.getElementById('autonomous-panda-label')?.textContent ?? null,
    })`,
  );
}

/** Click a chat-mode button (`.mode-button.mode-<mode>`) — used to force the real webviewModeChanged -> reconnectAutonomousTask() round trip a second time within one session (Scenario C task-switch trigger). */
export async function clickModeButton(client, mode) {
  await evalInWebviewDoc(
    client,
    `(() => {
      const btn = document.querySelector('.mode-button.mode-${mode}');
      if (!btn) throw new Error('mode-${mode} button not found');
      btn.click();
      return true;
    })()`,
  );
}

/**
 * Records every message the real webview content posts toward the extension
 * host into `window.__oaPostedMessages` on the OUTER webview-host window.
 *
 * The acquireVsCodeApi object itself cannot be wrapped: VS Code's injected
 * bootstrap returns it via `Object.freeze({ postMessage, ... })`, so a
 * property assignment silently no-ops (sloppy mode) while real clicks keep
 * working — a recorder attached there observes nothing and makes every
 * "zero outbound messages" assertion vacuous. The frozen `postMessage` also
 * holds a reference to the outer window's `__vscode_post_message__` captured
 * (`.bind`) at inner-frame bootstrap, so replacing that outer property
 * post-boot is equally blind.
 *
 * The one dynamic, observable hop in the chain is the last one: the outer
 * host page's HostMessaging relays every extension-bound message via
 * `this.channel.port1.postMessage({ channel: 'onmessage', data: { message } })`
 * — a method looked up on `MessagePort.prototype` at every call. Patching
 * that prototype method (record + forward unmodified) in the outer host
 * context therefore observes the REAL production transport of every message,
 * however the sender captured its API reference. Nothing in the production
 * bundle changes.
 *
 * Self-validation: after installing the hook, a harmless probe message
 * (a `type` no extension handler matches — AgentPanel's switch has no default
 * and ignores it) is posted through the real frozen inner-frame API; if the
 * hook does not capture it the function throws, so a broken recorder can
 * never silently turn "zero outbound messages" assertions vacuous. The probe
 * is stripped from the recorded stream before returning.
 */
export async function instrumentWebviewPostMessage(client) {
  const installed = await evaluateExpr(
    client,
    `(() => {
      if (!window.__oaPostedMessages) {
        window.__oaPostedMessages = [];
        window.__oaPortMessages = [];
        const original = MessagePort.prototype.postMessage;
        MessagePort.prototype.postMessage = function (payload, ...rest) {
          try { window.__oaPortMessages.push(JSON.parse(JSON.stringify(payload))); } catch { window.__oaPortMessages.push({ unserializable: true }); }
          if (payload && payload.channel === 'onmessage' && payload.data && 'message' in payload.data) {
            const message = payload.data.message;
            try { window.__oaPostedMessages.push(JSON.parse(JSON.stringify(message))); } catch { window.__oaPostedMessages.push({ type: String(message && message.type) }); }
          }
          return original.call(this, payload, ...rest);
        };
      }
      const inner = window.document.getElementById('active-frame');
      if (!inner || !inner.contentWindow) throw new Error('no #active-frame iframe found for instrumentation self-validation');
      if (!inner.contentWindow.__oaInboundMessages) {
        inner.contentWindow.__oaInboundMessages = [];
        inner.contentWindow.addEventListener('message', event => {
          try { inner.contentWindow.__oaInboundMessages.push(JSON.parse(JSON.stringify(event.data))); } catch { inner.contentWindow.__oaInboundMessages.push({ unserializable: true }); }
        }, true);
      }
      const api = inner.contentWindow.__ollamaAgentVsCodeApi;
      if (!api || typeof api.postMessage !== 'function') throw new Error('webview vscode API object not found for instrumentation self-validation');
      api.postMessage({ type: '__oaInstrumentationProbe' });
      const captured = window.__oaPostedMessages.some(m => m && m.type === '__oaInstrumentationProbe');
      window.__oaPostedMessages = window.__oaPostedMessages.filter(m => !(m && m.type === '__oaInstrumentationProbe'));
      if (!captured) throw new Error('postMessage instrumentation did not capture its own probe — recorder is blind, zero-outbound assertions would be vacuous');
      return true;
    })()`,
  );
  if (installed !== true) {
    throw new Error(`instrumentWebviewPostMessage did not confirm installation (got ${JSON.stringify(installed)})`);
  }
}

/** Messages recorded by instrumentWebviewPostMessage since instrumentation (null if never instrumented). */
export async function readInstrumentedPostedMessages(client) {
  return evaluateExpr(client, `window.__oaPostedMessages ?? null`);
}

/** Raw bidirectional MessagePort payloads captured at the outer webview host boundary. */
export async function readInstrumentedPortMessages(client) {
  return evaluateExpr(client, `window.__oaPortMessages ?? null`);
}

/** Extension-to-webview messages observed by a capture listener in the real inner frame. */
export async function readInstrumentedInboundMessages(client) {
  return evalInWebviewDoc(client, `document.defaultView.__oaInboundMessages ?? null`);
}

/**
 * Fires a real programmatic click at a button by element id regardless of its
 * current disabled/hidden state (a disabled button swallows the click exactly
 * as it would for a real user; a hidden-but-enabled one still runs its
 * handler, which is precisely the guard chain under test). Returns the
 * observed { found, disabled, hiddenCard } so callers can record evidence.
 */
export async function probeClickButton(client, buttonId) {
  return evalInWebviewDoc(
    client,
    `(() => {
      const btn = document.getElementById(${JSON.stringify(buttonId)});
      if (!btn) return { found: false };
      const card = btn.closest('section');
      const snapshot = { found: true, disabled: btn.disabled, hiddenCard: card ? card.hidden : null };
      btn.click();
      return snapshot;
    })()`,
  );
}

/** Snapshot of which taskId each approval card is currently bound to and whether it's actionable — used by the cross-task stale-card isolation scenario. */
export async function readCardOwnership(client) {
  return evalInWebviewDoc(
    client,
    `({
      proposalCardTaskId: document.getElementById('proposal-approval-card')?.dataset.taskId ?? null,
      proposalCardHidden: document.getElementById('proposal-approval-card')?.hidden,
      proposalApproveDisabled: document.getElementById('proposal-approve-btn')?.disabled,
      mutationCardTaskId: document.getElementById('mutation-approval-card')?.dataset.taskId ?? null,
      mutationCardHidden: document.getElementById('mutation-approval-card')?.hidden,
      mutationApproveDisabled: document.getElementById('mutation-approve-btn')?.disabled,
      deliveryCardTaskId: document.getElementById('delivery-approval-card')?.dataset.taskId ?? null,
      deliveryCardHidden: document.getElementById('delivery-approval-card')?.hidden,
      deliveryApproveDisabled: document.getElementById('delivery-approve-btn')?.disabled,
      deliveryReviewDisabled: document.getElementById('delivery-review-btn')?.disabled,
      deliveryRejectDisabled: document.getElementById('delivery-reject-btn')?.disabled,
    })`,
  );
}

/**
 * Waits for the real `#model-select` dropdown (media/chat.html) to be
 * populated from the real `modelsLoaded` webview message (posted after the
 * extension host's real Ollama tags query resolves), then selects the given
 * model by value via a real DOM `<select>` interaction — setting `.value`
 * and dispatching a real `change` event, the same shape a user's own click +
 * option pick produces and the same technique chat-runtime-fixes.js's own
 * `modelSelect.addEventListener('change', ...)` listener expects — so the
 * production explicit-override persistence path
 * (chat-runtime-fixes.js:302-303) genuinely runs. This is harness-only DOM
 * automation; it does not touch or stub any product code or capability data.
 */
export async function waitForModelOptionAndSelect(client, modelValue, { timeoutMs = 30000, intervalMs = 500 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let lastOptions;
  while (Date.now() < deadline) {
    lastOptions = await evalInWebviewDoc(
      client,
      `Array.from(document.getElementById('model-select')?.options ?? []).map(o => o.value)`,
    );
    if (Array.isArray(lastOptions) && lastOptions.includes(modelValue)) {
      const observedValue = await evalInWebviewDoc(
        client,
        `(() => {
          const select = document.getElementById('model-select');
          if (!select) throw new Error('model-select not found');
          select.value = ${JSON.stringify(modelValue)};
          select.dispatchEvent(new Event('change', { bubbles: true }));
          return select.value;
        })()`,
      );
      if (observedValue !== modelValue) {
        throw new Error(`model-select did not accept "${modelValue}" (observed "${observedValue}")`);
      }
      return true;
    }
    await new Promise(r => setTimeout(r, intervalMs));
  }
  throw new Error(`timed out after ${timeoutMs}ms waiting for #model-select to offer "${modelValue}"; last observed options=${JSON.stringify(lastOptions)}`);
}

/** Click the real production mode-switch button (`.mode-autonomous`) so the composer/status DOM is not left `hidden` behind the chat/agent mode view. */
export async function clickAutonomousModeButton(client) {
  await evalInWebviewDoc(
    client,
    `(() => {
      const btn = document.querySelector('.mode-button.mode-autonomous');
      if (!btn) throw new Error('mode-autonomous button not found');
      btn.click();
      return true;
    })()`,
  );
}

/**
 * Drives VS Code's in-application Simple File Dialog (`files.simpleDialog.enable`)
 * — rendered as a Quick Input surface exactly like a QuickPick, not a native OS
 * dialog — to select an exact absolute path. Sets the quick-input box's value
 * directly (the native `<input>` value setter + a real 'input' event, the same
 * technique `sendChatMessage` already uses for the plain composer textarea)
 * rather than simulating individual keystrokes, then accepts with Enter.
 * VS Code's SimpleFileDialog resolves the typed value against the filesystem
 * on accept: if it names an existing file matching the dialog's filters, the
 * dialog closes immediately; if it named a directory, the widget re-renders in
 * place (navigated deeper) and stays open — a bounded number of Enter presses
 * handles both without special-casing which one happened.
 */
export async function waitForSimpleFileDialog(client, { timeoutMs = 20000, intervalMs = 300 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const present = await evaluateExpr(client, `(() => { const w = document.querySelector('.quick-input-widget'); return !!(w && w.style.display !== 'none' && w.querySelector('.quick-input-box input')); })()`);
    if (present) return true;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(`timed out after ${timeoutMs}ms waiting for the Simple File Dialog quick-input box to appear`);
}

async function dispatchKeyWithModifiers(client, { keyCode, key, code, modifiers = 0 }) {
  await client.Input.dispatchKeyEvent({ type: 'keyDown', windowsVirtualKeyCode: keyCode, key, code, modifiers });
  await client.Input.dispatchKeyEvent({ type: 'keyUp', windowsVirtualKeyCode: keyCode, key, code, modifiers });
}

export async function driveSimpleFileDialogSelectPath(client, absolutePath, { timeoutMs = 20000, maxAcceptPresses = 4 } = {}) {
  await waitForSimpleFileDialog(client, { timeoutMs });
  const rect = await evaluateExpr(
    client,
    `(() => {
      const input = document.querySelector('.quick-input-widget .quick-input-box input');
      if (!input) return null;
      const r = input.getBoundingClientRect();
      return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
    })()`,
  );
  if (!rect) throw new Error('Simple File Dialog input box not found to set the fixture path into');

  // A real mouse click (not a JS .focus() call) so the OS/renderer input
  // routing genuinely targets this box for the CDP keyboard events below —
  // the same requirement every other click-driven helper in this file
  // already relies on for real button clicks.
  await client.Input.dispatchMouseEvent({ type: 'mousePressed', x: rect.x, y: rect.y, button: 'left', clickCount: 1 });
  await client.Input.dispatchMouseEvent({ type: 'mouseReleased', x: rect.x, y: rect.y, button: 'left', clickCount: 1 });

  // Select-all + delete any pre-filled default path, then insert the real
  // absolute fixture path via CDP's Input.insertText — a real text-insertion
  // event (as a paste or IME commit would produce), which every editable
  // widget's real 'input'/'beforeinput' listeners observe uniformly, unlike
  // a bare programmatic `.value =` assignment that monaco's InputBox does
  // not treat as genuine user input.
  await dispatchKeyWithModifiers(client, { keyCode: 65, key: 'a', code: 'KeyA', modifiers: 2 /* Ctrl */ });
  await dispatchKeyWithModifiers(client, { keyCode: 46, key: 'Delete', code: 'Delete' });
  await client.Input.insertText({ text: absolutePath });
  await new Promise((r) => setTimeout(r, 300));

  const observedValue = await evaluateExpr(client, `document.querySelector('.quick-input-widget .quick-input-box input')?.value ?? null`);
  if (observedValue !== absolutePath) {
    throw new Error(`Simple File Dialog input box did not accept the fixture path: expected "${absolutePath}", observed "${observedValue}"`);
  }

  for (let attempt = 0; attempt < maxAcceptPresses; attempt += 1) {
    await dispatchKey(client, { keyCode: 13, key: 'Enter', code: 'Enter' });
    await new Promise((r) => setTimeout(r, 500));
    const stillOpen = await evaluateExpr(client, `(() => { const w = document.querySelector('.quick-input-widget'); return !!(w && w.style.display !== 'none' && w.querySelector('.quick-input-box input')); })()`);
    if (!stillOpen) return;
  }
  const debugHtml = await evaluateExpr(client, `document.querySelector('.quick-input-widget')?.outerHTML?.slice(0, 4000) ?? null`);
  throw new Error(`Simple File Dialog did not close after ${maxAcceptPresses} Enter presses for path "${absolutePath}"; widget=${debugHtml}`);
}

/** Click the real production attachment button (`#attach-btn`), triggering the real `pickAttachment` -> `vscode.window.showOpenDialog` path. */
export async function clickAttachButton(client) {
  await evalInWebviewDoc(
    client,
    `(() => {
      const btn = document.getElementById('attach-btn');
      if (!btn) throw new Error('attach-btn not found');
      if (btn.disabled) throw new Error('attach-btn is disabled');
      btn.click();
      return true;
    })()`,
  );
}

/** Snapshot of the composer's in-flight attachment chips (before send). */
export async function readComposerAttachmentChips(client) {
  return evalInWebviewDoc(
    client,
    `Array.from(document.querySelectorAll('#attachments-row .attachment-chip')).map((chip) => ({
      status: chip.dataset.status ?? null,
      attachmentId: chip.dataset.attachmentId ?? null,
      name: chip.querySelector('.att-name')?.textContent ?? null,
    }))`,
  );
}

/** Snapshot of the attachment chips rendered inside a sent user bubble (live send or restored transcript). */
export async function readSentAttachmentChips(client) {
  return evalInWebviewDoc(
    client,
    `Array.from(document.querySelectorAll('.bubble.user .attachment-chip.sent')).map((chip) => ({
      status: chip.dataset.status ?? null,
      attachmentId: chip.dataset.attachmentId ?? null,
      text: chip.textContent ?? null,
    }))`,
  );
}

/** Count of rendered user/assistant bubbles in the transcript. */
export async function countBubbles(client) {
  return evalInWebviewDoc(
    client,
    `({
      user: document.querySelectorAll('.bubble.user').length,
      assistant: document.querySelectorAll('.bubble.assistant').length,
    })`,
  );
}

export async function captureFailureDiagnostics(client, evidenceDir, label) {
  fs.mkdirSync(evidenceDir, { recursive: true });
  try {
    const { data } = await client.Page.captureScreenshot({ format: 'png' });
    fs.writeFileSync(path.join(evidenceDir, `${label}.png`), Buffer.from(data, 'base64'));
  } catch (error) {
    fs.writeFileSync(path.join(evidenceDir, `${label}-screenshot-error.txt`), String(error));
  }
  try {
    const domSummary = await evaluateExpr(
      client,
      `(() => ({
        title: document.title,
        quickInputTitle: document.querySelector('.quick-input-widget .quick-input-title')?.textContent ?? null,
        dialogText: document.querySelector('.monaco-dialog-box .dialog-message-text')?.textContent ?? null,
        visibleNotifications: Array.from(document.querySelectorAll('.notification-list-item-message')).map(n => n.textContent),
      }))()`,
    );
    fs.writeFileSync(path.join(evidenceDir, `${label}-dom-summary.json`), JSON.stringify(domSummary, null, 2));
  } catch (error) {
    fs.writeFileSync(path.join(evidenceDir, `${label}-dom-summary-error.txt`), String(error));
  }
}
