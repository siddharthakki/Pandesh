import * as crypto from 'crypto';
import * as vscode from 'vscode';
import { PersistentOperationsReader } from '../observability/PersistentOperationsReader';
import { OperationsSnapshot } from '../observability/OperationsService';

export class OperationsPanel implements vscode.WebviewViewProvider, vscode.Disposable {
  static readonly viewType = 'ollama-agent.operationsView';

  private view?: vscode.WebviewView;
  private readonly reader: PersistentOperationsReader;
  private refreshTimer?: NodeJS.Timeout;
  private disposed = false;

  constructor(private readonly workspaceRoot: string) {
    this.reader = new PersistentOperationsReader(workspaceRoot);
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = { enableScripts: true };
    view.webview.html = this.html(view.webview);
    view.webview.onDidReceiveMessage(message => {
      if (isMessage(message, 'refresh')) void this.refresh();
      if (isMessage(message, 'openTask') && typeof message['taskId'] === 'string') {
        void vscode.commands.executeCommand('ollama-agent.openChat');
      }
    });
    view.onDidChangeVisibility(() => {
      if (view.visible) {
        void this.refresh();
        this.startRefresh();
      } else {
        this.stopRefresh();
      }
    });
    void this.refresh();
    this.startRefresh();
  }

  async refresh(): Promise<void> {
    if (this.disposed || !this.view) return;
    try {
      const snapshot = await this.reader.read();
      await this.view.webview.postMessage({ type: 'snapshot', snapshot });
    } catch (error) {
      await this.view.webview.postMessage({
        type: 'error',
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  dispose(): void {
    this.disposed = true;
    this.stopRefresh();
    this.view = undefined;
  }

  private startRefresh(): void {
    this.stopRefresh();
    this.refreshTimer = setInterval(() => void this.refresh(), 5_000);
  }

  private stopRefresh(): void {
    if (this.refreshTimer) clearInterval(this.refreshTimer);
    this.refreshTimer = undefined;
  }

  private html(webview: vscode.Webview): string {
    const nonce = crypto.randomBytes(16).toString('hex');
    const initial = escapeForScript(JSON.stringify(emptySnapshot()));
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}';">
<title>Operations</title>
<style nonce="${nonce}">
:root{color-scheme:light dark}body{font:12px var(--vscode-font-family);margin:0;color:var(--vscode-foreground);background:var(--vscode-sideBar-background)}
header{display:flex;align-items:center;justify-content:space-between;padding:10px;border-bottom:1px solid var(--vscode-panel-border)}button{font:inherit;color:var(--vscode-button-foreground);background:var(--vscode-button-background);border:0;padding:5px 9px;cursor:pointer}
.grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:6px;padding:8px}.metric{padding:8px;background:var(--vscode-editorWidget-background);border:1px solid var(--vscode-panel-border)}.value{font-size:20px;font-weight:700}.label{opacity:.75}
section{padding:0 8px 10px}h3{font-size:11px;text-transform:uppercase;letter-spacing:.08em;opacity:.75}.row{padding:7px;border:1px solid var(--vscode-panel-border);margin-bottom:5px;background:var(--vscode-editorWidget-background)}.row button{background:none;color:var(--vscode-textLink-foreground);padding:0;text-align:left}.meta{opacity:.7;margin-top:3px}.badge{float:right;padding:1px 5px;border-radius:8px;background:var(--vscode-badge-background);color:var(--vscode-badge-foreground)}.blocked{color:var(--vscode-errorForeground)}.error{padding:8px;color:var(--vscode-errorForeground)}.empty{opacity:.65;padding:8px 0}
</style>
</head>
<body>
<header><strong>Operations</strong><button id="refresh">Refresh</button></header>
<div id="error" class="error"></div><div id="metrics" class="grid"></div>
<section><h3>Recent tasks</h3><div id="tasks"></div></section>
<section><h3>Retained worktrees</h3><div id="worktrees"></div></section>
<section><h3>Recent events</h3><div id="events"></div></section>
<script nonce="${nonce}">
const vscode=acquireVsCodeApi();let state=${initial};
const esc=v=>String(v??'').replace(/[&<>\"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','\"':'&quot;'}[c]));
function render(s){state=s;document.getElementById('error').textContent='';const t=s.totals;
document.getElementById('metrics').innerHTML=[['Tasks',t.tasks],['Running',t.running],['Blocked',t.blocked],['Worktrees',t.retainedWorktrees]].map(x=>'<div class="metric"><div class="value">'+esc(x[1])+'</div><div class="label">'+esc(x[0])+'</div></div>').join('');
document.getElementById('tasks').innerHTML=s.tasks.length?s.tasks.slice(0,20).map(x=>'<div class="row '+(x.phase==='blocked'?'blocked':'')+'"><span class="badge">'+esc(x.phase)+'</span><button data-task="'+esc(x.taskId)+'">'+esc(x.title)+'</button><div class="meta">'+esc(x.model)+' · tools '+esc(x.usage.toolCalls)+' · model '+esc(x.usage.modelCalls)+'</div></div>').join(''):'<div class="empty">No persisted tasks.</div>';
document.getElementById('worktrees').innerHTML=s.worktrees.length?s.worktrees.map(x=>'<div class="row"><span class="badge">'+esc(x.status)+'</span>'+esc(x.taskId)+'<div class="meta">'+esc(x.branch)+' · '+esc(x.allowedPaths.join(', '))+'</div></div>').join(''):'<div class="empty">No retained worktrees.</div>';
document.getElementById('events').innerHTML=s.observations.recentEvents.length?s.observations.recentEvents.slice(-15).reverse().map(x=>'<div class="row"><span class="badge">'+esc(x.level)+'</span>'+esc(x.category+'.'+x.name)+'<div class="meta">'+esc(x.timestamp)+'</div></div>').join(''):'<div class="empty">No observations recorded.</div>';}
document.getElementById('refresh').onclick=()=>vscode.postMessage({type:'refresh'});document.getElementById('tasks').onclick=e=>{const b=e.target.closest('[data-task]');if(b)vscode.postMessage({type:'openTask',taskId:b.dataset.task});};
window.addEventListener('message',e=>{if(e.data.type==='snapshot')render(e.data.snapshot);if(e.data.type==='error')document.getElementById('error').textContent=e.data.message;});render(state);
</script>
</body></html>`;
  }
}

function isMessage(value: unknown, type: string): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value) && (value as Record<string, unknown>)['type'] === type);
}

function escapeForScript(value: string): string {
  return value.replace(/</g, '\\u003c').replace(/>/g, '\\u003e').replace(/&/g, '\\u0026');
}

function emptySnapshot(): OperationsSnapshot {
  return {
    schemaVersion: 1,
    generatedAt: new Date(0).toISOString(),
    totals: { tasks: 0, running: 0, blocked: 0, completed: 0, retainedWorktrees: 0 },
    activity: { readOnlyBatchActive: false, writeBatchActive: false, integrationsActive: 0, sandboxesActive: 0, rpcServicesActive: 0, mcpRegistriesActive: 0 },
    tasks: [],
    worktrees: [],
    observations: { schemaVersion: 1, generatedAt: new Date(0).toISOString(), eventCount: 0, counters: {}, recentEvents: [] },
  };
}
