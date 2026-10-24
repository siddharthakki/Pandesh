// M31 Global Board UI automation, layered on top of scripts/acceptance/uiDriver.mjs
// and the same CDP-over-`--remote-debugging-port` technique the packaged
// acceptance harness already uses (see uiDriver.mjs header comment). This
// module adds two things uiDriver.mjs doesn't need for its single-window
// autonomous-task scenarios:
//   1. multi-window target discovery (find the second VS Code window's own
//      `page` CDP target, and each window's own Global Board webview
//      `iframe` target) — required because M31's shared-profile requirement
//      means both windows live under one `--remote-debugging-port`.
//   2. helpers for the Global Board's own webview DOM (data-testid
//      attributes added to src/ui/LocalBoardPanel.ts) and for the native
//      `showInputBox` quick-input widget the Board's create/comment actions
//      use (distinct from the QuickPick widget uiDriver.mjs already drives).

import CDP from 'chrome-remote-interface';
import * as fs from 'fs';
import * as path from 'path';

async function evaluateExpr(client, expression) {
  const { result, exceptionDetails } = await client.Runtime.evaluate({ expression, returnByValue: true, awaitPromise: true });
  if (exceptionDetails) {
    throw new Error(`CDP Runtime.evaluate threw: ${exceptionDetails.text}`);
  }
  return result.value;
}

/** List every live top-level CDP target (both `page` workbench windows and `iframe` webview hosts). */
export async function listTargets(port) {
  return CDP.List({ port });
}

/** Connect to a specific target id (not just "the first page target", unlike uiDriver.connect). */
export async function connectToTarget(port, targetId) {
  const client = await CDP({ port, target: targetId });
  await client.Runtime.enable();
  await client.DOM.enable();
  await client.Page.enable();
  return client;
}

/**
 * Poll until a new `page` (workbench window) target appears that was not in
 * `excludeIds` — used to find Window B's own page target after opening it
 * under the same shared profile as Window A.
 */
export async function waitForNewWindowTarget(port, excludeIds, { timeoutMs = 30000, intervalMs = 400 } = {}) {
  const deadline = Date.now() + timeoutMs;
  const excluded = new Set(excludeIds);
  while (Date.now() < deadline) {
    const targets = await CDP.List({ port });
    const candidate = targets.find((t) => t.type === 'page' && !excluded.has(t.id));
    if (candidate) return candidate;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(`timed out after ${timeoutMs}ms waiting for a new window (page) target beyond ${[...excluded].join(',')}`);
}

/**
 * Bring a specific window's page target to the OS foreground. VS Code
 * self-dismisses focus-losing widgets (QuickPick, non-modal dialogs) when
 * the underlying window isn't OS-focused, so scenarios that alternate
 * between two windows must explicitly refocus before driving either one.
 */
export async function focusWindow(port, pageTargetId) {
  const client = await connectToTarget(port, pageTargetId);
  try {
    await client.Page.bringToFront();
  } finally {
    await client.close();
  }
}

async function evalInDoc(client, docExpression) {
  const wrapped = `(() => {
    const inner = window.document.getElementById('active-frame');
    if (!inner) throw new Error('no #active-frame iframe found in the webview host document');
    const document = inner.contentDocument;
    if (!document) throw new Error('active-frame contentDocument is not accessible (not same-origin, or not yet navigated)');
    return (${docExpression});
  })()`;
  const { result, exceptionDetails } = await client.Runtime.evaluate({ expression: wrapped, returnByValue: true, awaitPromise: false });
  if (exceptionDetails) {
    throw new Error(`webview DOM Runtime.evaluate threw: ${exceptionDetails.text}`);
  }
  return result.value;
}

/** True if the given iframe-type target's content is the Global Board webview (has the `board` element id unique to LocalBoardPanel's HTML). */
async function isBoardWebviewTarget(port, targetId) {
  let client;
  try {
    client = await connectToTarget(port, targetId);
    const hasBoardRoot = await evalInDoc(client, `!!document.getElementById('board') && !!document.querySelector('[data-testid="connection-state"]')`);
    return Boolean(hasBoardRoot);
  } catch {
    return false;
  } finally {
    if (client) await client.close().catch(() => {});
  }
}

/**
 * Poll for a NEW Global Board webview `iframe` target (one not already in
 * `excludeIds`), confirming by DOM content (not URL, whose shape isn't
 * guaranteed stable across VS Code versions) that it really is the Board and
 * not some other webview (e.g. the KarkeDikha chat sidebar). Returns a
 * connected, ready client.
 */
export async function waitForBoardWebview(port, excludeIds, { timeoutMs = 30000, intervalMs = 500 } = {}) {
  const deadline = Date.now() + timeoutMs;
  const excluded = new Set(excludeIds);
  while (Date.now() < deadline) {
    const targets = await CDP.List({ port });
    const candidates = targets.filter(
      (t) => t.type === 'iframe' && typeof t.url === 'string' && t.url.startsWith('vscode-webview://') && t.url.includes('/index.html') && !excluded.has(t.id),
    );
    for (const candidate of candidates) {
      if (await isBoardWebviewTarget(port, candidate.id)) {
        const client = await connectToTarget(port, candidate.id);
        return { client, targetId: candidate.id };
      }
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(`timed out after ${timeoutMs}ms waiting for a new Global Board webview target beyond ${[...excluded].join(',')}`);
}

/** Snapshot every current iframe-type webview target id, for use as an `excludeIds` baseline before opening a Board panel. */
export async function currentWebviewTargetIds(port) {
  const targets = await CDP.List({ port });
  return targets.filter((t) => t.type === 'iframe' && typeof t.url === 'string' && t.url.startsWith('vscode-webview://')).map((t) => t.id);
}

/** Close a window (page target) or webview via the CDP `/json/close/:id` endpoint — the same boundary DevTools itself uses to tear down a target; for a `page` target this is equivalent to the user closing that VS Code window. */
export async function closeTarget(port, targetId) {
  await CDP.Close({ port, id: targetId });
}

// --- Global Board webview DOM helpers (operate on a client returned by waitForBoardWebview) ---

export async function readBoardState(client) {
  return evalInDoc(
    client,
    `({
      connectionState: document.getElementById('connectionState')?.dataset.state ?? null,
      connectionLabel: document.getElementById('connectionState')?.textContent ?? null,
      meta: document.getElementById('meta')?.textContent ?? null,
      warning: document.getElementById('warning')?.textContent ?? null,
      githubSyncNote: document.getElementById('githubSyncNote')?.textContent ?? null,
      syncDisabled: document.getElementById('sync')?.disabled ?? null,
      syncTitle: document.getElementById('sync')?.title ?? null,
      projectOptions: Array.from(document.getElementById('projectFilter')?.options ?? []).map(o => ({ value: o.value, label: o.textContent })),
      cards: Array.from(document.querySelectorAll('[data-testid="board-card"]')).map(el => ({
        storyId: el.dataset.storyId,
        status: el.dataset.status,
        source: el.dataset.source,
        title: el.querySelector('[data-testid="board-card-title"]')?.textContent ?? null,
      })),
    })`,
  );
}

/**
 * Stamps a random sentinel onto the live webview document's `<body>` and
 * returns it. LocalBoardPanel.refresh() fully reassigns `panel.webview.html`
 * on every mutation, replacing the entire document (including `<body>`), so
 * once the extension host's fire-and-forget handleMessage() -> refresh()
 * round trip actually lands, `document.body` is a brand-new node and the
 * sentinel is gone. This is the only reliable way to detect "the round trip
 * completed", since polling a value WE ourselves just set directly on the
 * (still-old) DOM before dispatching the triggering event is always
 * trivially "correct" and proves nothing about the extension host's state.
 */
export async function markRerenderSentinel(client) {
  const token = Math.random().toString(36).slice(2);
  await evalInDoc(client, `(document.body.dataset.m31Sentinel = ${JSON.stringify(token)}, true)`);
  return token;
}

export async function waitForRerenderPast(client, token, { timeoutMs = 15000, intervalMs = 200 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const current = await evalInDoc(client, `document.body?.dataset?.m31Sentinel ?? null`).catch(() => null);
    if (current !== token) return;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(`timed out after ${timeoutMs}ms waiting for the webview to re-render past sentinel "${token}"`);
}

export async function clickBoardButton(client, testid) {
  const clicked = await evalInDoc(
    client,
    `(() => {
      const btn = document.querySelector('[data-testid="${testid}"]');
      if (!btn) return false;
      btn.click();
      return true;
    })()`,
  );
  if (!clicked) throw new Error(`board button with data-testid="${testid}" not found`);
}

export async function clickCardButton(client, storyId, testid) {
  const clicked = await evalInDoc(
    client,
    `(() => {
      const btn = document.querySelector('[data-testid="${testid}"][data-story-id="${storyId}"]');
      if (!btn) return false;
      btn.click();
      return true;
    })()`,
  );
  if (!clicked) throw new Error(`card button data-testid="${testid}" for story ${storyId} not found`);
}

/**
 * Sets the project filter AND waits for the resulting extension-host round
 * trip (postMessage -> handleMessage -> refresh() -> full webview.html
 * reassignment) to actually complete, by polling the re-rendered select's own
 * value. Message handling in LocalBoardPanel.handleMessage is fire-and-forget
 * per message (`void this.handleMessage(message)`), so a caller that clicks a
 * button immediately after dispatching this `change` event can otherwise race
 * ahead of the extension host's own state update.
 */
export async function setProjectFilter(client, projectId, { timeoutMs = 15000 } = {}) {
  const sentinel = await markRerenderSentinel(client);
  await evalInDoc(
    client,
    `(() => {
      const select = document.getElementById('projectFilter');
      if (!select) throw new Error('projectFilter select not found');
      select.value = ${JSON.stringify(projectId)};
      select.dispatchEvent(new Event('change'));
      return true;
    })()`,
  );
  await waitForRerenderPast(client, sentinel, { timeoutMs });
}

/** Same fire-and-forget-race concern as setProjectFilter() above — waits for the re-rendered select's own value to settle before returning. */
export async function setActiveFilter(client, filter, { timeoutMs = 15000 } = {}) {
  const sentinel = await markRerenderSentinel(client);
  await evalInDoc(
    client,
    `(() => {
      const select = document.getElementById('activeFilter');
      if (!select) throw new Error('activeFilter select not found');
      select.value = ${JSON.stringify(filter)};
      select.dispatchEvent(new Event('change'));
      return true;
    })()`,
  );
  await waitForRerenderPast(client, sentinel, { timeoutMs });
}

export async function setStoryTransition(client, storyId, toStatus) {
  await evalInDoc(
    client,
    `(() => {
      const select = document.querySelector('[data-testid="transition-select"][data-story-id="${storyId}"]');
      if (!select) throw new Error('transition-select for story ${storyId} not found');
      select.value = ${JSON.stringify(toStatus)};
      select.dispatchEvent(new Event('change'));
      return true;
    })()`,
  );
}

export async function findCardByTitle(client, title) {
  const state = await readBoardState(client);
  return state.cards.find((c) => c.title === title);
}

// --- Native quick-input widget helpers (vscode.window.showInputBox / showQuickPick), rendered in the OUTER page (workbench), not inside the webview. ---

async function pageEvaluate(pageClient, expression) {
  const { result, exceptionDetails } = await pageClient.Runtime.evaluate({ expression, returnByValue: true });
  if (exceptionDetails) throw new Error(`CDP Runtime.evaluate threw: ${exceptionDetails.text}`);
  return result.value;
}

/** Poll for the native input-box quick-input widget (showInputBox) to be visible, keyed on its title/placeholder text. */
export async function waitForQuickInputBox(pageClient, textSubstring, { timeoutMs = 15000, intervalMs = 250 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const found = await pageEvaluate(
      pageClient,
      `(() => {
        const widget = Array.from(document.querySelectorAll('.quick-input-widget')).find(w => w.offsetParent !== null);
        if (!widget) return false;
        const input = widget.querySelector('input');
        if (!input) return false;
        const label = (widget.querySelector('.quick-input-title')?.textContent || '') + ' ' + (input.getAttribute('aria-label') || '') + ' ' + (input.placeholder || '');
        return label.includes(${JSON.stringify(textSubstring)}) || ${JSON.stringify(textSubstring)} === '';
      })()`,
    );
    if (found) return true;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(`timed out after ${timeoutMs}ms waiting for a native input box matching "${textSubstring}"`);
}

/**
 * Type into a native input box that VS Code pre-fills asynchronously (e.g.
 * `showInputBox({ value: currentTitle })` for an "Edit" flow): the `<input>`
 * element can exist in the DOM slightly before its `.value` is populated, so
 * clearing+typing too early races the pre-fill and gets silently overwritten
 * back to the original value once it lands. Waits for the input to actually
 * contain the expected pre-filled text before clearing and typing over it.
 */
export async function typeIntoPrefilledQuickInputBox(pageClient, expectedPrefill, text, { timeoutMs = 10000, intervalMs = 200 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const current = await pageEvaluate(pageClient, `Array.from(document.querySelectorAll('.quick-input-widget')).find(w => w.offsetParent !== null)?.querySelector('input')?.value ?? null`);
    if (current === expectedPrefill) {
      await typeIntoQuickInputBox(pageClient, text);
      return;
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(`timed out after ${timeoutMs}ms waiting for the native input box to be pre-filled with "${expectedPrefill}"`);
}

/** Type into the currently-visible native input-box quick-input widget and press Enter to accept. */
export async function typeIntoQuickInputBox(pageClient, text) {
  // CDP Input.dispatchKeyEvent injects into the page's real input pipeline (unlike a DOM `.click()`
  // call), which requires the renderer to actually hold OS-level input focus — that can drift
  // between actions in an automated multi-window session, so re-assert it immediately before typing.
  await pageClient.Page.bringToFront();
  // Focus via a genuine mouse click (not a scripted `.focus()` call) at the input's real screen
  // coordinates — Monaco's input handling is wired for pointer-originated focus, and CDP-dispatched
  // physical mouse input is the same mechanism the rest of this driver already uses successfully
  // for buttons (see clickModalButton in uiDriver.mjs).
  const rect = await pageEvaluate(
    pageClient,
    `(() => {
      const input = Array.from(document.querySelectorAll('.quick-input-widget')).find(w => w.offsetParent !== null)?.querySelector('input');
      if (!input) return null;
      const r = input.getBoundingClientRect();
      return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
    })()`,
  );
  if (!rect) throw new Error('no native input box found to focus');
  await pageClient.Input.dispatchMouseEvent({ type: 'mousePressed', x: rect.x, y: rect.y, button: 'left', clickCount: 1 });
  await pageClient.Input.dispatchMouseEvent({ type: 'mouseReleased', x: rect.x, y: rect.y, button: 'left', clickCount: 1 });
  // Clear any pre-filled value (e.g. showInputBox({value: ...}) for an "Edit" flow) via REAL
  // keyboard input (Ctrl+A, Backspace) rather than a raw DOM `.value = ''` assignment — Monaco's
  // input widget mirrors its internal model off real key/composition events, and a bare `Event('input')`
  // does not reliably keep that model in sync, which was observed to silently corrupt subsequent typing.
  await pageClient.Input.dispatchKeyEvent({ type: 'keyDown', modifiers: 2, windowsVirtualKeyCode: 65, key: 'a', code: 'KeyA' });
  await pageClient.Input.dispatchKeyEvent({ type: 'keyUp', modifiers: 2, windowsVirtualKeyCode: 65, key: 'a', code: 'KeyA' });
  await pageClient.Input.dispatchKeyEvent({ type: 'keyDown', windowsVirtualKeyCode: 8, key: 'Backspace', code: 'Backspace' });
  await pageClient.Input.dispatchKeyEvent({ type: 'keyUp', windowsVirtualKeyCode: 8, key: 'Backspace', code: 'Backspace' });
  // Type character-by-character via 'char' events rather than Input.insertText(): insertText can
  // leave Chromium in a pending-IME-composition state, which was observed to silently swallow the
  // very next dispatched keydown (the submitting Enter) as a composition-confirm instead of
  // delivering it to the app.
  for (const ch of text) {
    await pageClient.Input.dispatchKeyEvent({ type: 'char', text: ch, unmodifiedText: ch });
  }
  // Confirm the text actually landed before submitting: a keypress dispatched in the same tick the
  // widget mounted can arrive before Monaco's input model has caught up, silently no-op-ing.
  const deadlineTyped = Date.now() + 5000;
  let typedOk = false;
  while (Date.now() < deadlineTyped) {
    const currentValue = await pageEvaluate(pageClient, `Array.from(document.querySelectorAll('.quick-input-widget')).find(w => w.offsetParent !== null)?.querySelector('input')?.value ?? null`);
    if (currentValue === text) {
      typedOk = true;
      break;
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  if (!typedOk) throw new Error(`native input box value did not settle on "${text}" before submitting`);

  // Submit, then verify the box actually accepted — VS Code wires the Enter/accept handler
  // slightly after the DOM node mounts, so a keypress issued too early can be silently swallowed,
  // leaving the box open with no error and no mutation. Retry Enter until the current input no
  // longer shows the submitted text (either the widget closed entirely, or a DIFFERENT quick input
  // — e.g. a follow-up QuickPick with its own, empty filter box — has replaced it).
  const deadlineSubmit = Date.now() + 8000;
  while (Date.now() < deadlineSubmit) {
    await pageClient.Input.dispatchKeyEvent({ type: 'rawKeyDown', windowsVirtualKeyCode: 13, key: 'Enter', code: 'Enter' });
    await pageClient.Input.dispatchKeyEvent({ type: 'keyUp', windowsVirtualKeyCode: 13, key: 'Enter', code: 'Enter' });
    await new Promise((r) => setTimeout(r, 250));
    const currentValue = await pageEvaluate(pageClient, `Array.from(document.querySelectorAll('.quick-input-widget')).find(w => w.offsetParent !== null)?.querySelector('input')?.value ?? null`);
    if (currentValue !== text) return;
  }
  throw new Error(`native input box for "${text}" did not accept after repeated Enter submissions`);
}

/** Accept the currently-highlighted row of a visible QuickPick via Enter (same technique as uiDriver.acceptQuickPickFirstItem, duplicated here to avoid a cross-file coupling on an internal helper). */
export async function acceptQuickPick(pageClient) {
  await pageClient.Page.bringToFront();
  await pageClient.Input.dispatchKeyEvent({ type: 'keyDown', windowsVirtualKeyCode: 13, key: 'Enter', code: 'Enter' });
  await pageClient.Input.dispatchKeyEvent({ type: 'keyUp', windowsVirtualKeyCode: 13, key: 'Enter', code: 'Enter' });
}

/** Poll for a visible QuickPick with at least one selectable row — used for showQuickPick() calls whose distinguishing text is a `placeHolder` (shown inside the input, not `.quick-input-title`) rather than a `title`. */
export async function waitForQuickPickWithRows(pageClient, { timeoutMs = 15000, intervalMs = 250 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const hasRows = await pageEvaluate(pageClient, `(Array.from(document.querySelectorAll('.quick-input-widget')).find(w => w.offsetParent !== null)?.querySelectorAll('.monaco-list-row') ?? []).length > 0`);
    if (hasRows) return true;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(`timed out after ${timeoutMs}ms waiting for a QuickPick with at least one row`);
}

export async function waitForQuickPickTitled(pageClient, titleSubstring, { timeoutMs = 15000, intervalMs = 250 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const title = await pageEvaluate(
      pageClient,
      `(() => Array.from(document.querySelectorAll('.quick-input-widget')).find(w => w.offsetParent !== null)?.querySelector('.quick-input-title')?.textContent ?? null)()`,
    );
    if (title && title.includes(titleSubstring)) return title;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(`timed out after ${timeoutMs}ms waiting for a QuickPick titled like "${titleSubstring}"`);
}

/**
 * Click a board button and wait for the resulting native input box to
 * appear, retrying the click a few times. LocalBoardPanel fully re-navigates
 * the webview's iframe (`panel.webview.html = ...`) on every refresh(), and
 * handleMessage() is fire-and-forget (`void this.handleMessage(message)`), so
 * a click issued during that narrow re-navigation window can be lost —
 * retrying the click (idempotent: it only opens a not-yet-submitted native
 * input box, never a duplicate mutation) is more robust than a single
 * best-effort click plus a long wait.
 */
export async function clickAndAwaitInputBox(pageClient, boardClient, testid, storyId, { attempts = 4, perAttemptTimeoutMs = 6000 } = {}) {
  let lastError;
  for (let i = 0; i < attempts; i += 1) {
    try {
      if (storyId) await clickCardButton(boardClient, storyId, testid);
      else await clickBoardButton(boardClient, testid);
      await waitForQuickInputBox(pageClient, '', { timeoutMs: perAttemptTimeoutMs });
      return;
    } catch (error) {
      lastError = error;
    }
  }
  throw new Error(`clickAndAwaitInputBox("${testid}") did not produce a native input box after ${attempts} attempts: ${lastError?.message}`);
}

/** Poll until the workbench DOM (not just the CDP page target) has actually rendered — a fresh window can have a live `page` target well before Monaco has mounted. */
export async function waitForWorkbenchDomReady(pageClient, { timeoutMs = 30000, intervalMs = 300 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const ready = await pageEvaluate(pageClient, `!!document.querySelector('.monaco-workbench')`);
    if (ready) return true;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(`timed out after ${timeoutMs}ms waiting for .monaco-workbench to mount`);
}

/** Open the Command Palette via Ctrl+Shift+P — the real, production way a user with no dedicated toolbar button reaches a contributed command. (F1 is equivalent by default keybinding, but Ctrl+Shift+P is used here since it does not collide with any browser/OS-reserved F-key handling.) */
export async function openCommandPalette(pageClient) {
  await waitForWorkbenchDomReady(pageClient);
  await new Promise((r) => setTimeout(r, 500)); // let OS/window focus settle after the workbench mounts
  const modifiers = 2 | 8; // Ctrl (2) + Shift (8), per CDP Input.dispatchKeyEvent's bitmask
  await pageClient.Input.dispatchKeyEvent({ type: 'keyDown', modifiers, windowsVirtualKeyCode: 17, key: 'Control', code: 'ControlLeft' });
  await pageClient.Input.dispatchKeyEvent({ type: 'keyDown', modifiers, windowsVirtualKeyCode: 16, key: 'Shift', code: 'ShiftLeft' });
  await pageClient.Input.dispatchKeyEvent({ type: 'keyDown', modifiers, windowsVirtualKeyCode: 80, key: 'p', code: 'KeyP' });
  await pageClient.Input.dispatchKeyEvent({ type: 'keyUp', modifiers, windowsVirtualKeyCode: 80, key: 'p', code: 'KeyP' });
  await pageClient.Input.dispatchKeyEvent({ type: 'keyUp', modifiers: 2, windowsVirtualKeyCode: 16, key: 'Shift', code: 'ShiftLeft' });
  await pageClient.Input.dispatchKeyEvent({ type: 'keyUp', modifiers: 0, windowsVirtualKeyCode: 17, key: 'Control', code: 'ControlLeft' });
  await waitForQuickInputBox(pageClient, '', { timeoutMs: 8000 });
}

/** Run a contributed command by its palette title via real keyboard input: F1, type the title, wait for the matching row, Enter. */
export async function runCommandViaPalette(pageClient, commandTitle, { settleMs = 500 } = {}) {
  await openCommandPalette(pageClient);
  await pageClient.Input.insertText({ text: commandTitle });
  await new Promise((r) => setTimeout(r, settleMs));
  await acceptQuickPick(pageClient);
}

export async function captureScreenshot(client, evidenceDir, label) {
  fs.mkdirSync(evidenceDir, { recursive: true });
  const { data } = await client.Page.captureScreenshot({ format: 'png' });
  const file = path.join(evidenceDir, `${label}.png`);
  fs.writeFileSync(file, Buffer.from(data, 'base64'));
  return file;
}
