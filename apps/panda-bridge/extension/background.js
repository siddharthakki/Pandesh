// Pandesh Panda Bridge — service worker.
// The only component that talks to the native host. The page (content script) and the popup ask it; it adds the pairing
// token, which therefore never reaches the web page.
const HOST = 'com.pandesh.panda_bridge';
const STORE = 'pandaBridge';

async function load() {
  const o = await chrome.storage.local.get(STORE);
  return o[STORE] || { paired: false, pandaMode: false };
}
async function save(patch) {
  const next = { ...(await load()), ...patch };
  await chrome.storage.local.set({ [STORE]: next });
  return next;
}

function nativeCall(message) {
  return new Promise((resolve) => {
    chrome.runtime.sendNativeMessage(HOST, { id: crypto.randomUUID(), ...message }, (reply) => {
      const err = chrome.runtime.lastError;
      if (err) resolve({ ok: false, code: 'host_unavailable', message: `The Pandesh native host is not installed or cannot start (${err.message}).` });
      else resolve(reply || { ok: false, code: 'no_reply', message: 'The Pandesh native host did not answer.' });
    });
  });
}

const TOKEN_OPS = new Set(['status', 'executors', 'submit', 'tasks', 'task', 'dispatch', 'pause', 'resume', 'cancel']);

async function handle(msg) {
  const state = await load();
  switch (msg.op) {
    case 'state':
      return { ok: true, data: { paired: state.paired, label: state.label || null, pandaMode: state.paired && state.pandaMode } };
    case 'setPandaMode': {
      // Panda Mode needs a pairing: without one there is nowhere to send, so it must never swallow a prompt.
      const enabled = Boolean(msg.enabled) && state.paired;
      const next = await save({ pandaMode: enabled });
      return { ok: true, data: { pandaMode: next.pandaMode } };
    }
    case 'pair': {
      const reply = await nativeCall({ op: 'pair', code: String(msg.code || '').trim(), label: msg.label || 'Chrome', extensionId: chrome.runtime.id });
      if (!reply.ok) return reply;
      await save({ paired: true, token: reply.data.token, pairingId: reply.data.pairingId, label: reply.data.label, pandaMode: false });
      return { ok: true, data: { paired: true, label: reply.data.label } };
    }
    case 'unpair': {
      let revoked = false;
      if (state.token) revoked = (await nativeCall({ op: 'unpair', token: state.token })).ok;
      await chrome.storage.local.set({ [STORE]: { paired: false, pandaMode: false } });
      return { ok: true, data: { paired: false, revokedInPandesh: revoked } };
    }
    case 'open':
      return nativeCall({ op: 'open', conversationId: msg.conversationId });
    default: {
      if (!TOKEN_OPS.has(msg.op)) return { ok: false, code: 'unknown_operation', message: `unknown operation ${msg.op}` };
      if (!state.paired || !state.token) return { ok: false, code: 'not_paired', message: 'Pair this browser with Pandesh first.' };
      const { op, ...rest } = msg;
      const reply = await nativeCall({ ...rest, op, token: state.token });
      if (!reply.ok && reply.status === 401) {
        // Revoked in Pandesh: forget it here too so nothing is intercepted any more.
        await chrome.storage.local.set({ [STORE]: { paired: false, pandaMode: false } });
        return { ...reply, code: 'pairing_revoked', message: 'This browser was unpaired in Pandesh. Pair it again to continue.' };
      }
      return reply;
    }
  }
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  // Only this extension's own content script and popup may ask; there is no externally_connectable, so web pages cannot.
  if (sender.id !== chrome.runtime.id || !msg || typeof msg.op !== 'string') return false;
  handle(msg).then(sendResponse, (e) => sendResponse({ ok: false, code: 'error', message: String(e && e.message || e) }));
  return true;
});
