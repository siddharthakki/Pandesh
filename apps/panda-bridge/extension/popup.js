const $ = (id) => document.getElementById(id);
const send = (message) => new Promise((resolve) => chrome.runtime.sendMessage(message, (r) => resolve(chrome.runtime.lastError ? { ok: false, message: chrome.runtime.lastError.message } : (r || { ok: false, message: 'no answer' }))));

function say(text, isError) { const m = $('msg'); m.textContent = text || ''; m.className = isError ? 'err' : 'muted'; }

async function refresh() {
  const s = await send({ op: 'state' });
  const paired = s.ok && s.data.paired;
  $('unpaired').hidden = paired;
  $('paired').hidden = !paired;
  $('tasksSection').hidden = !paired;
  if (!paired) return;
  $('label').textContent = s.data.label || 'this browser';
  $('mode').checked = s.data.pandaMode;
  $('badge').textContent = s.data.pandaMode ? 'ON' : 'OFF';
  $('badge').className = 'badge' + (s.data.pandaMode ? ' on' : '');

  const st = await send({ op: 'status' });
  $('core').textContent = st.ok ? `Pandesh is reachable · ${st.data.executors} executor(s) available` : (st.message || 'Pandesh is not reachable.');
  if (!st.ok && st.code === 'pairing_revoked') return refresh();

  const t = await send({ op: 'tasks' });
  const list = $('tasks');
  list.replaceChildren();
  if (t.ok && t.data.tasks.length === 0) list.textContent = 'No tasks yet.';
  for (const task of t.ok ? t.data.tasks.slice(0, 6) : []) {
    const row = document.createElement('div');
    row.className = 'task';
    const chip = document.createElement('span');
    chip.className = 'chip';
    chip.textContent = task.status.replace(/_/g, ' ');
    const text = document.createElement('span');
    text.textContent = ' ' + task.instruction.replace(/\s+/g, ' ').slice(0, 60);
    row.append(chip, text);
    if (task.conversationId) {
      const open = document.createElement('button');
      open.textContent = 'Open in Pandesh';
      open.style.marginLeft = '8px';
      open.onclick = async () => { const r = await send({ op: 'open', conversationId: task.conversationId }); if (!r.ok) say(r.message, true); };
      row.append(document.createElement('br'), open);
    }
    list.append(row);
  }
}

$('pair').onclick = async () => {
  say('Pairing…');
  const r = await send({ op: 'pair', code: $('code').value, label: 'Chrome on ' + (navigator.platform || 'PC') });
  say(r.ok ? 'Paired.' : (r.message || 'Pairing failed.'), !r.ok);
  $('code').value = '';
  await refresh();
};
$('unpair').onclick = async () => {
  const r = await send({ op: 'unpair' });
  say(r.ok && r.data.revokedInPandesh ? 'Unpaired. Pandesh no longer accepts this browser.' : 'Unpaired here. Pandesh could not be reached to revoke it: revoke this browser in Pandesh too.', !(r.ok && r.data.revokedInPandesh));
  await refresh();
};
$('mode').onchange = async (e) => { await send({ op: 'setPandaMode', enabled: e.target.checked }); await refresh(); };

refresh();
