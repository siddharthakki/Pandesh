import { ActivityBar, By, VSBrowser, Workbench, until } from 'vscode-extension-tester';
import { Key } from 'selenium-webdriver';

const visible = async element => {
  try {
    return await element.isDisplayed();
  } catch {
    return false;
  }
};

export class KarkeDikhaView {
  constructor() {
    this.browser = VSBrowser.instance;
    this.driver = this.browser.driver;
  }

  async open() {
    await this.switchBack();
    const control = await new ActivityBar().getViewControl('KarkeDikha');
    if (!control) throw new Error('KarkeDikha Activity Bar control was not found in the installed product');
    await control.openView();
    await this.switchIntoView();
    await this.driver.wait(until.elementLocated(By.id('user-input')), 30_000);
  }

  async switchBack() {
    await this.driver.switchTo().defaultContent();
  }

  async switchIntoView() {
    await this.driver.switchTo().defaultContent();
    const deadline = Date.now() + 30_000;
    let lastError;
    while (Date.now() < deadline) {
      const frames = await this.driver.findElements(By.css('iframe'));
      for (const frame of frames) {
        try {
          await this.driver.switchTo().defaultContent();
          await this.driver.switchTo().frame(frame);
          const active = await this.driver.findElements(By.id('active-frame'));
          if (active.length) await this.driver.switchTo().frame(active[0]);
          const composer = await this.driver.findElements(By.id('user-input'));
          if (composer.length) return;
        } catch (error) {
          lastError = error;
        }
      }
      await new Promise(resolve => setTimeout(resolve, 250));
    }
    throw new Error(`KarkeDikha webview frame did not become available: ${lastError?.message ?? 'no matching iframe'}`);
  }

  async typeComposer(text) {
    const input = await this.driver.findElement(By.id('user-input'));
    await this.driver.wait(
      async () => (await visible(input)) && !(await input.getAttribute('disabled')),
      60_000,
      'visible unified composer did not become ready',
    );
    await input.clear();
    // A bare Enter submits the composer, so multi-line text is entered with Shift+Enter between lines.
    const lines = String(text).split(/\r?\n/);
    for (let index = 0; index < lines.length; index += 1) {
      if (index > 0) await input.sendKeys(Key.chord(Key.SHIFT, Key.ENTER));
      if (lines[index]) await input.sendKeys(lines[index]);
    }
  }

  async selectMode(mode) {
    const allowed = new Set(['auto', 'chat', 'agent', 'autonomous']);
    if (!allowed.has(mode)) throw new Error(`Unknown visible KarkeDikha mode: ${mode}`);
    // Legacy segmented controls (older builds) first.
    const legacy = await this.driver.findElements(By.css(`.mode-button[data-mode="${mode}"]`));
    for (const candidate of legacy) {
      if (await visible(candidate)) {
        await candidate.click();
        await this.driver.wait(async () => (await candidate.getAttribute('aria-pressed')) === 'true', 10_000, `Visible mode did not change to ${mode}`);
        return;
      }
    }
    // Current compact dropdown: open the popover, pick the option.
    const toggle = await this.driver.findElement(By.id('compact-mode-btn'));
    const popover = await this.driver.findElement(By.id('compact-mode-popover'));
    if (!(await visible(popover))) await toggle.click();
    await this.driver.wait(async () => visible(popover), 10_000, 'compact mode popover did not open');
    const option = await this.driver.findElement(By.css(`.compact-mode-option[data-mode="${mode}"]`));
    await option.click();
    await this.driver.wait(async () => /active/.test(await option.getAttribute('class')) || (await option.getAttribute('aria-selected')) === 'true', 10_000, `Visible mode did not change to ${mode}`);
    await this.driver.wait(async () => !(await visible(popover)), 10_000, 'compact mode popover did not close');
  }

  async clickPrimary() {
    const button = await this.driver.findElement(By.id('send-btn'));
    await this.driver.wait(async () => !(await button.getAttribute('disabled')), 10_000);
    await button.click();
  }

  async submit(text) {
    await this.typeComposer(text);
    const button = await this.driver.findElement(By.id('send-btn'));
    const label = (await button.getText()).trim();
    if (label !== 'Send') throw new Error(`Expected visible Send control before submission, got "${label}"`);
    await button.click();
  }

  async waitForOrdinaryResponse(previousAssistantCount = 0, timeout = 120_000) {
    await this.driver.wait(async () => {
      const snapshot = await this.snapshot();
      return snapshot.assistantCount > previousAssistantCount && snapshot.primaryAction === 'Send';
    }, timeout, 'ordinary visible response did not complete');
    return this.snapshot();
  }

  async clickToolApproval(decision, timeout = 120_000) {
    if (!['approved', 'rejected'].includes(decision)) throw new Error(`Unknown tool approval decision: ${decision}`);
    let button;
    await this.driver.wait(async () => {
      button = await this.actionableToolApproval(decision);
      return !!button;
    }, timeout, `visible Saath Kar ${decision} control did not become actionable`);
    await button.click();
  }

  async actionableToolApproval(decision) {
    const buttons = await this.driver.findElements(By.css(`[data-approval-response="${decision}"]`));
    for (const candidate of buttons.reverse()) {
      if ((await visible(candidate)) && !(await candidate.getAttribute('disabled'))) return candidate;
    }
    return null;
  }

  async submitInMode(mode, text) {
    await this.typeComposer(text);
    await this.selectMode(mode);
    const button = await this.driver.findElement(By.id('send-btn'));
    const label = (await button.getText()).trim();
    if (label !== 'Send') throw new Error(`Expected visible Send control before ${mode} submission, got "${label}"`);
    try {
      await button.click();
    } catch (error) {
      // VS Code notification toasts (e.g. "file was updated" after a delivery) can sit over the composer's Send
      // control. Dismiss them in the workbench like a user would, then press the same Send control again.
      if (error?.name !== 'ElementClickInterceptedError') throw error;
      await this.switchBack();
      await new Workbench().executeCommand('Notifications: Clear All Notifications');
      await this.switchIntoView();
      await this.driver.findElement(By.id('send-btn')).click();
    }
  }

  /** Bounded next-turn queue (Baat/Saath): type while work runs and press the
   * "Queue next" control. Never used for Karke Dikha steering. */
  async queueNext(text) {
    await this.typeComposer(text);
    const button = await this.driver.findElement(By.id('send-btn'));
    await this.driver.wait(async () => !(await button.getAttribute('disabled')), 10_000, 'Queue next control did not become enabled');
    const label = (await button.getText()).trim();
    if (label !== 'Queue next') throw new Error(`Expected visible "Queue next" control while work runs, got "${label}"`);
    await button.click();
    await this.driver.wait(async () => (await this.queueStripText()) !== null, 10_000, 'queued-next-turn strip did not appear');
    return this.queueStripText();
  }

  /** Visible text of the queued-next-turn strip, or null when hidden. */
  async queueStripText() {
    return this.driver.executeScript(`
      const strip = document.getElementById('next-turn-queue');
      return strip && !strip.hidden && strip.getClientRects().length > 0 ? strip.innerText : null;
    `);
  }

  async waitForAcknowledgement(timeout = 60_000) {
    await this.driver.wait(async () => {
      try {
        const snapshot = await this.snapshot();
        return snapshot.taskId && snapshot.taskId !== '—' && snapshot.primaryAction === 'Stop';
      } catch {
        return false;
      }
    }, timeout, 'durable acknowledgement was not projected into the visible composer');
    return this.snapshot();
  }

  async clickVisibleApproval(kind, timeout = 120_000) {
    return this.resolveVisibleApproval(kind, 'approved', timeout);
  }

  async resolveVisibleApproval(kind, decision = 'approved', timeout = 120_000) {
    const ids = {
      proposal: { approved: 'proposal-approve-btn', rejected: 'proposal-reject-btn' },
      // Product uses "Deny" (not "Reject") for the mutation approval card
      // specifically (media/chat.html's #mutation-approval-card renders
      // #mutation-deny-btn) — proposal/delivery both use "…-reject-btn".
      mutation: { approved: 'mutation-approve-btn', rejected: 'mutation-deny-btn' },
      delivery: { approved: 'delivery-approve-btn', rejected: 'delivery-reject-btn' },
    };
    const id = ids[kind]?.[decision];
    if (!id) throw new Error(`Unknown approval kind: ${kind}`);
    let button;
    await this.driver.wait(async () => {
      try {
        button = await this.driver.findElement(By.id(id));
        return (await visible(button)) && !(await button.getAttribute('disabled'));
      } catch {
        return false;
      }
    }, timeout, `visible ${kind} ${decision} control did not become actionable`);
    await button.click();
  }

  async waitForApproval(kind, timeout = 120_000) {
    const cards = {
      proposal: 'proposal-approval-card',
      mutation: 'mutation-approval-card',
      delivery: 'delivery-approval-card',
    };
    const cardId = cards[kind];
    if (!cardId) throw new Error(`Unknown approval kind: ${kind}`);
    await this.driver.wait(async () => {
      const identity = await this.approvalIdentity(kind);
      return identity?.actionable === true;
    }, timeout, `visible ${kind} approval did not become actionable`);
    return this.approvalIdentity(kind);
  }

  async approvalIdentity(kind) {
    return this.driver.executeScript(`
      const kind = arguments[0];
      const card = document.getElementById(kind + '-approval-card');
      const approve = document.getElementById(kind + '-approve-btn');
      const rendered = element => !!element && element.getClientRects().length > 0
        && getComputedStyle(element).visibility !== 'hidden';
      if (!rendered(card)) return null;
      return {
        kind,
        taskId: card.dataset.taskId || null,
        attemptId: card.dataset.attemptId || null,
        actionable: rendered(approve) && !approve.disabled,
        inlineState: card.dataset.inlineApprovalState || null,
        text: card.innerText,
      };
    `, kind);
  }

  async openHistory() {
    const toggle = await this.driver.findElement(By.id('history-toggle'));
    const drawer = await this.driver.findElement(By.id('history-drawer'));
    if ((await drawer.getAttribute('hidden')) !== null) await toggle.click();
    await this.driver.wait(async () => (await drawer.getAttribute('hidden')) === null, 10_000, 'History drawer did not open');
    await this.driver.wait(async () => {
      const text = await this.driver.findElement(By.id('everyday-history-status')).getText();
      return !/^Loading/i.test(text);
    }, 30_000, 'History did not finish loading');
  }

  async newChat() {
    const buttons = await this.driver.findElements(By.css('#new-conversation-toolbar-btn, #new-conversation-btn'));
    let button;
    for (const candidate of buttons) {
      if (await visible(candidate)) {
        button = candidate;
        break;
      }
    }
    if (!button) {
      // At sidebar width the toolbar button is hidden; the real user path is History -> New chat.
      await this.openHistory();
      button = await this.driver.findElement(By.id('new-conversation-btn'));
    }
    await button.click();
    await this.closeHistory().catch(() => undefined);
    await this.driver.wait(async () => {
      const snapshot = await this.snapshot();
      return snapshot.userCount === 0 && snapshot.assistantCount === 0 && snapshot.responseCount === 0;
    }, 30_000, 'New chat did not render an empty current conversation');
    return this.snapshot();
  }

  async selectConversation(conversationId) {
    await this.openHistory();
    const items = await this.driver.findElements(By.css('.conversation-item'));
    let selected;
    for (const item of items) {
      if ((await item.getAttribute('data-conv-id')) === conversationId) {
        selected = item;
        break;
      }
    }
    if (!selected) throw new Error(`Conversation ${conversationId} was not visible in History`);
    await selected.click();
    await this.driver.wait(async () => {
      const snapshot = await this.snapshot();
      return snapshot.conversationId === conversationId;
    }, 30_000, `Conversation ${conversationId} did not become current`);
    // The History drawer (and its #drawer-scrim) stay on top of the mode
    // controls/#conversations-list until explicitly closed — a caller that
    // immediately submits through a mode button right after restoring a
    // conversation (e.g. a Saath Kar resubmission) can have its click
    // intercepted by the still-open drawer. Dismiss it through its real
    // visible close control and wait until it no longer renders (not just
    // until the `hidden` attribute flips) before handing control back, so
    // every caller of selectConversation() can rely on the normal composer
    // controls being interactable immediately afterward.
    await this.closeHistory();
    return this.snapshot();
  }

  /** Closes the History drawer through its real visible close control and
   * waits until it no longer intercepts clicks (Selenium's own `isDisplayed`
   * check, not just the `hidden` attribute) rather than sleeping a fixed
   * delay. Safe to call when the drawer is already closed. */
  async closeHistory() {
    const drawer = await this.driver.findElement(By.id('history-drawer'));
    if (await visible(drawer)) {
      const closeButton = await this.driver.findElement(By.id('history-close-btn'));
      await closeButton.click();
    }
    await this.driver.wait(
      async () => !(await visible(drawer)),
      10_000,
      'History drawer did not close',
    );
  }

  async steer(text) {
    const before = await this.snapshot();
    await this.typeComposer(text);
    const afterTyping = await this.snapshot();
    if (!['Steer', 'Update task'].includes(afterTyping.primaryAction)) {
      throw new Error(`Visible composer did not enter Steer/Update task state: ${afterTyping.primaryAction}`);
    }
    if (!afterTyping.compactStopVisible) throw new Error('Compact inline Stop was not visible while steering text was present');
    await this.clickPrimary();
    return before.taskId;
  }

  async stop() {
    const snapshot = await this.snapshot();
    if (snapshot.primaryAction !== 'Stop') throw new Error(`Expected inline Stop, got ${snapshot.primaryAction}`);
    if (!snapshot.primaryTaskId || snapshot.primaryTaskId !== snapshot.taskId) {
      throw new Error(`Inline Stop task ID mismatch: control=${snapshot.primaryTaskId}, acknowledged=${snapshot.taskId}`);
    }
    await this.clickPrimary();
    return snapshot.taskId;
  }

  async reloadWindow() {
    await this.switchBack();
    // A marker on the live page is the authoritative reload signal: it is gone only once the renderer has loaded a
    // new document. Waiting for `.monaco-workbench` alone can match the OLD page that is about to be torn down.
    const marker = `kkd-reload-${Date.now()}`;
    await this.driver.executeScript('window.__kkdReloadMarker = arguments[0];', marker);
    const pageReloaded = async timeoutMs => {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        // Errors mean the document is mid-navigation, which is also evidence the reload started.
        const current = await this.driver.executeScript('return window.__kkdReloadMarker || null;').catch(() => null);
        if (current !== marker) return true;
        await new Promise(resolve => setTimeout(resolve, 250));
      }
      return false;
    };
    let reloaded = false;
    for (let attempt = 0; attempt < 3 && !reloaded; attempt += 1) {
      if (attempt > 0) {
        await this.driver.actions().sendKeys(Key.ESCAPE, Key.ESCAPE).perform().catch(() => undefined);
        await new Promise(resolve => setTimeout(resolve, 500));
      }
      // The reload can start before executeCommand returns, so its own "workbench element gone" error is not a failure.
      await new Workbench().executeCommand('Developer: Reload Window').catch(() => undefined);
      reloaded = await pageReloaded(30_000);
    }
    if (!reloaded) throw new Error('Developer: Reload Window did not reload the page (marker still present after 3 attempts)');
    await this.browser.waitForWorkbench(90_000);
    // The workbench element can exist before the Activity Bar is rendered; retry open() until it settles.
    const deadline = Date.now() + 60_000;
    for (;;) {
      try {
        await this.open();
        return;
      } catch (error) {
        if (Date.now() > deadline) throw error;
        await new Promise(resolve => setTimeout(resolve, 500));
      }
    }
  }

  async sourceControlText() {
    await this.switchBack();
    const control = await new ActivityBar().getViewControl('Source Control');
    if (!control) throw new Error('Source Control Activity Bar control was not found');
    await control.openView();
    const text = await this.driver.findElement(By.css('.monaco-workbench')).getText();
    return text;
  }

  async snapshot() {
    return this.driver.executeScript(`
      const isRendered = element => !!element && element.getClientRects().length > 0
        && getComputedStyle(element).visibility !== 'hidden';
      const request = document.getElementById('task-request-entry');
      const response = document.getElementById('autonomous-status');
      const panda = document.getElementById('autonomous-panda');
      const primary = document.getElementById('send-btn');
      const compactStop = document.getElementById('unified-task-stop-btn');
      const taskText = document.getElementById('autonomous-task-id')?.textContent || '';
      const attemptText = document.getElementById('autonomous-attempt-id')?.textContent || '';
      const exactId = value => String(value).replace(/^[^:]+:\\s*/, '').trim();
      return {
        title: document.title,
        bodyText: document.body.innerText,
        modeValues: Array.from(document.querySelectorAll('#mode-select option')).map(option => option.value),
        selectedMode: document.getElementById('mode-select')?.value || null,
        composerDisabled: !!document.getElementById('user-input')?.disabled,
        providerModelText: [
          document.getElementById('context-model')?.textContent || '',
          document.getElementById('permission-summary-description')?.textContent || '',
        ].join(' ').trim(),
        userCount: Array.from(document.querySelectorAll('#messages .bubble.user')).filter(isRendered).length,
        assistantCount: Array.from(document.querySelectorAll('#messages .bubble.assistant:not(.kd-task-message)')).filter(isRendered).length,
        responseCount: Array.from(document.querySelectorAll('#messages .kd-task-message')).filter(isRendered).length,
        actionableApprovals: Array.from(document.querySelectorAll(
          '#proposal-approve-btn, #mutation-approve-btn, #delivery-approve-btn, [data-approval-response]'
        )).filter(element => !element.disabled && isRendered(element)).length,
        conversationId: document.querySelector('.conversation-item.active')?.dataset?.convId || null,
        conversationItems: Array.from(document.querySelectorAll('.conversation-item')).map(element => ({
          id: element.dataset.convId || null,
          title: element.textContent?.trim() || '',
          active: element.classList.contains('active'),
        })),
        historyOpen: !document.getElementById('history-drawer')?.hidden,
        historyTaskCount: document.querySelectorAll('#everyday-history-list .everyday-history-item').length,
        userTexts: Array.from(document.querySelectorAll('#messages .bubble.user')).filter(isRendered).map(element => element.textContent || ''),
        assistantTexts: Array.from(document.querySelectorAll('#messages .bubble.assistant:not(.kd-task-message)')).filter(isRendered).map(element => element.textContent || ''),
        approvalCards: ['proposal', 'mutation', 'delivery'].map(kind => {
          const card = document.getElementById(kind + '-approval-card');
          const approve = document.getElementById(kind + '-approve-btn');
          return {
            kind,
            visible: isRendered(card),
            taskId: card?.dataset?.taskId || null,
            attemptId: card?.dataset?.attemptId || null,
            actionable: isRendered(approve) && !approve?.disabled,
            inlineState: card?.dataset?.inlineApprovalState || null,
          };
        }),
        toolApprovals: Array.from(document.querySelectorAll('[data-approval-id]')).filter(isRendered).map(card => ({
          approvalId: card.dataset.approvalId || null,
          text: card.textContent || '',
          actionable: Array.from(card.querySelectorAll('[data-approval-response]')).some(button => !button.disabled && isRendered(button)),
        })),
        requestBeforeResponse: !!(isRendered(request) && isRendered(response) && (request.compareDocumentPosition(response) & Node.DOCUMENT_POSITION_FOLLOWING)),
        requestText: request?.textContent || '',
        responseVisible: isRendered(response),
        responseIdentity: response?.dataset?.kdTaskMessage || null,
        detailsCount: response?.querySelectorAll('details#kd-task-details').length || 0,
        detailsOpen: !!response?.querySelector('details#kd-task-details')?.open,
        pandaVisible: !!panda && !panda.hidden && getComputedStyle(panda).display !== 'none',
        pandaWidth: panda ? getComputedStyle(panda).width : null,
        primaryAction: primary?.textContent?.trim() || null,
        primaryTaskId: primary?.dataset?.taskId || null,
        compactStopVisible: !!compactStop && !compactStop.hidden && getComputedStyle(compactStop).display !== 'none',
        taskId: exactId(taskText),
        attemptId: exactId(attemptText),
        taskState: response?.dataset?.state || null,
        workbenchControls: document.querySelectorAll('.message-workbench-actions, [aria-label="Branch"], [aria-label="Regenerate"], [aria-label="Answer"]').length,
      };
    `);
  }
}
