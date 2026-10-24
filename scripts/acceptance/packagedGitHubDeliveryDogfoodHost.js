'use strict';
const fs = require('fs');
const path = require('path');
const vscode = require('vscode');

function status(patch) {
  const file = process.env.OA_M17_PACKAGED_STATUS;
  const current = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : { events: [] };
  const event = { at: new Date().toISOString(), ...patch };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ ...current, ...event, events: [...current.events, event] }, null, 2));
}

async function run() {
  const taskId = process.env.OA_M17_PACKAGED_TASK_ID;
  const done = process.env.OA_M17_PACKAGED_DONE;
  try {
    if (!taskId || !done || !process.env.OA_M17_PACKAGED_STATUS) throw new Error('packaged GitHub delivery host environment is incomplete');
    const extension = vscode.extensions.getExtension('ollama-agent.ollama-agent');
    if (!extension) throw new Error('packaged KarkeDikha extension was not found');
    await extension.activate();
    status({ phase: 'activated', taskId });
    await vscode.commands.executeCommand('ollama-agent.focus');
    status({ phase: 'focused', taskId });
    const deadline = Date.now() + 180000;
    while (Date.now() < deadline && !fs.existsSync(done)) await new Promise(resolve => setTimeout(resolve, 250));
    if (!fs.existsSync(done)) throw new Error('timed out waiting for packaged dogfood driver');
    status({ phase: 'done', taskId });
  } catch (error) {
    status({
      phase: 'host_exception',
      taskId,
      exception: {
        name: error && error.name,
        message: error && error.message ? error.message : String(error),
        stack: error && error.stack,
      },
    });
    throw error;
  } finally {
    status({ phase: 'host_finally', taskId });
  }
}

module.exports = { run };
