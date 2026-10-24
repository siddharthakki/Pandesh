#!/usr/bin/env node
// Real Extension Host check for the History drawer: installs the packaged VSIX into an isolated VS Code profile,
// opens a workspace whose Core data directory is a COPY of an existing data dir (so real prior conversations are
// listed), clicks a History "Recent chats" item over CDP and reports exactly which link of the chain moved.
//
//   node scripts/acceptance/run-history-click-real-host.mjs --vsix <path> --workspace <dir> --data-dir <core data copy>
//
// Exit 0 = the click produced a restored transcript and closed the drawer; 1 = the chain stopped (details printed).
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { resolveVSCode, installExtension, launchPlainHost, allocateDebugPort, terminatePlainHost, writeUserSettingsForCustomDialogs } from './plainVsCodeHost.mjs';
import * as board from './boardUiDriver.mjs';
import * as ui from './uiDriver.mjs';

const arg = (name) => { const i = process.argv.indexOf(`--${name}`); return i >= 0 ? process.argv[i + 1] : undefined; };
const vsixPath = path.resolve(arg('vsix') ?? '');
const workspace = path.resolve(arg('workspace') ?? '');
const dataDirSource = path.resolve(arg('data-dir') ?? '');
const clickIndex = Number(arg('index') ?? '1');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (m) => console.log(`[history-click] ${m}`);

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'oa-history-click-'));
const userDataDir = path.join(work, 'user-data');
const extensionsDir = path.join(work, 'extensions');
const dataDir = path.join(work, 'core-data');
fs.mkdirSync(dataDir, { recursive: true });
for (const name of ['core.db', 'core.db-wal', 'core.db-shm', 'attachments']) {
  const from = path.join(dataDirSource, name);
  if (fs.existsSync(from)) fs.cpSync(from, path.join(dataDir, name), { recursive: true });
}

let child;
try {
  const { vscodeExecutablePath, cliArgs } = await resolveVSCode();
  fs.mkdirSync(userDataDir, { recursive: true });
  writeUserSettingsForCustomDialogs(userDataDir);
  installExtension(cliArgs, { userDataDir, extensionsDir, vsixPath });
  const port = allocateDebugPort();
  const launched = launchPlainHost(vscodeExecutablePath, { userDataDir, extensionsDir, workspacePath: workspace, remoteDebuggingPort: port, env: { ...process.env, KARKEDIKHA_DATA_DIR: dataDir } });
  child = launched.child;

  let page;
  for (let i = 0; i < 90 && !page; i += 1) {
    page = (await board.listTargets(port).catch(() => [])).find((t) => t.type === 'page');
    if (!page) await sleep(500);
  }
  if (!page) throw new Error('no workbench page target');
  const pageClient = await board.connectToTarget(port, page.id);
  await pageClient.Page.bringToFront();
  await sleep(6000);
  await board.runCommandViaPalette(pageClient, 'KarkeDikha: Open');
  // The onboarding "KarkeDikha Setup" editor panel also hosts a webview; skip every target that is not the chat view.
  const excluded = [];
  let web;
  for (let attempt = 0; attempt < 8 && !web; attempt += 1) {
    const connected = await ui.connectToWebviewHostTarget(port, { attempts: 40, delayMs: 500, excludeIds: excluded });
    const title = await ui.evalInWebviewDoc(connected.client, 'document.title').catch(() => '');
    if (title === 'KarkeDikha') web = connected.client;
    else { excluded.push(connected.targetId); await connected.client.close().catch(() => {}); await sleep(1500); }
  }
  if (!web) throw new Error('chat webview target never mounted');
  await ui.waitForWebviewContentMounted(web, { timeoutMs: 45000, readyElementId: 'send-btn' });
  await ui.instrumentWebviewPostMessage(web);
  await sleep(12000); // Core connect + workspace restoration

  const rows = await ui.evalInWebviewDoc(web, `Array.from(document.querySelectorAll('#conversations-list .conversation-item')).map((n) => ({ id: n.dataset.convId, text: n.textContent.trim().slice(0, 60), active: n.classList.contains('active') }))`);
  log(`History items: ${JSON.stringify(rows)}`);
  const before = await ui.evalInWebviewDoc(web, `({ bubbles: document.querySelectorAll('#messages .bubble').length, text: document.querySelector('#messages')?.textContent.slice(0, 120) })`);
  log(`Transcript before click: ${JSON.stringify(before)}`);
  if (process.argv.includes('--newchat')) {
    await ui.evalInWebviewDoc(web, `document.getElementById('new-conversation-btn').click()`);
    await sleep(4000);
    log('Clicked New chat first');
  }
  const target = rows.filter((r) => !r.active)[clickIndex - 1] ?? rows[clickIndex];
  if (!target) throw new Error('no History item to click');
  await ui.evalInWebviewDoc(web, `document.getElementById('history-toggle').click()`);
  await sleep(500);
  const mark = (await ui.readInstrumentedInboundMessages(web))?.length ?? 0;
  if (process.argv.includes('--mouse')) {
    // A physical pointer click goes through hit-testing: report what element actually receives it.
    const hit = await ui.evalInWebviewDoc(web, `(() => {
      const item = document.querySelector('#conversations-list .conversation-item[data-conv-id="${target.id}"]');
      item.scrollIntoView({ block: 'center' });
      const r = item.getBoundingClientRect();
      const x = r.left + Math.min(40, r.width / 2), y = r.top + r.height / 2;
      const top = document.elementFromPoint(x, y);
      const frame = window.document.defaultView.frameElement ? null : null;
      return { x, y, rect: { l: r.left, t: r.top, w: r.width, h: r.height }, topTag: top && (top.tagName + '#' + top.id + '.' + top.className), itemReceives: !!(top && item.contains(top)) };
    })()`);
    log(`Hit test at item centre: ${JSON.stringify(hit)}`);
    const off = await web.Runtime.evaluate({ expression: `(() => { const f = document.getElementById('active-frame').getBoundingClientRect(); return { l: f.left, t: f.top }; })()`, returnByValue: true });
    const { l, t } = off.result.value;
    for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) {
      await web.Input.dispatchMouseEvent({ type, x: l + hit.x, y: t + hit.y, button: 'left', clickCount: 1 });
    }
  } else {
    await ui.evalInWebviewDoc(web, `document.querySelector('#conversations-list .conversation-item[data-conv-id="${target.id}"]').click()`);
  }
  log(`Clicked ${target.id} (${target.text})`);
  await sleep(8000);
  const out = (await ui.readInstrumentedPostedMessages(web)) ?? [];
  const inbound = ((await ui.readInstrumentedInboundMessages(web)) ?? []).slice(mark);
  log(`webview -> host: ${JSON.stringify(out.filter((m) => m.type === 'selectConversation'))}`);
  log(`host -> webview after click: ${JSON.stringify(inbound.map((m) => ({ type: m.type, id: m.id, messages: Array.isArray(m.messages) ? m.messages.length : undefined, epoch: m.epoch, message: m.message })))}`);
  const after = await ui.evalInWebviewDoc(web, `({ bubbles: document.querySelectorAll('#messages .bubble').length, text: document.querySelector('#messages')?.textContent.slice(0, 160), drawerHidden: document.getElementById('history-drawer').hidden, cards: document.querySelectorAll('#messages .task-result, #messages [data-task-result]').length })`);
  log(`State after click: ${JSON.stringify(after)}`);
  const ok = after.bubbles > 0 && after.drawerHidden === true;
  log(ok ? 'PASS: transcript restored and drawer closed' : 'FAIL: History click did not restore the transcript / close the drawer');
  process.exitCode = ok ? 0 : 1;
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  terminatePlainHost(child);
}
