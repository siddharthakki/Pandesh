import * as crypto from 'crypto';
import * as vscode from 'vscode';
import { Logger } from '../services/Logger';
import { CoreManager } from '../core-client/CoreManager';
import { CoreApiError } from '../core-client/CoreClient';
import type { ProjectRecord, StoryRecord, StoryStatus, StoryType } from '../../core/shared/wireTypes';
import { STORY_TYPES } from '../../core/shared/wireTypes';

export const SHOW_LOCAL_BOARD_COMMAND = 'ollama-agent.showLocalBoard';

export interface EngineeringBoardProvider {
  boardSnapshot(): Promise<unknown>;
  sync(showMessage?: boolean): Promise<unknown>;
}

interface BoardCard {
  id: string;
  title: string;
  status: string;
  kind: string;
  points?: number;
  owner?: string;
  progress?: number;
  externalRef?: string;
  blockedReason?: string;
  source: 'core' | 'engineering';
  projectId?: string;
  projectName?: string;
  revision?: number;
  archived?: boolean;
}

type ActiveFilter = 'active' | 'history';

interface BoardSnapshot {
  generatedAt: string;
  connection: { state: string; detail?: string };
  projects: ProjectRecord[];
  selectedProjectId: 'all' | string;
  activeFilter: ActiveFilter;
  cards: BoardCard[];
  engineeringAvailable: boolean;
  engineeringError?: string;
  /** Present only when GitHub Sync is disabled; explains why (no workspace/git, no origin, or a transient GitHub error) without ever affecting Board availability itself. */
  githubSyncDisabledReason?: string;
}

/**
 * Global Board webview: a thin, refresh-on-change client of the KarkeDikha
 * Core (M31). Project/story data is fetched from the Core on every
 * render — this panel holds no authoritative Board state of its own, only
 * UI selection state (which project/filter is currently shown). M37
 * engineering details are a Core projection layered onto those same Core
 * story cards; this panel never merges a second JSON-backed board.
 */
export class LocalBoardPanel implements vscode.Disposable {
  private static current?: LocalBoardPanel;
  private readonly panel: vscode.WebviewPanel;
  private disposed = false;
  private selectedProjectId: 'all' | string = 'all';
  private activeFilter: ActiveFilter = 'active';
  private refreshTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly disposables: vscode.Disposable[] = [];
  private pendingActionIds = new Set<string>();

  static async show(
    context: vscode.ExtensionContext,
    storageRoot: string,
    provider?: EngineeringBoardProvider,
    coreManager?: CoreManager,
  ): Promise<LocalBoardPanel> {
    if (this.current) {
      this.current.panel.reveal(vscode.ViewColumn.One);
      await this.current.refresh();
      return this.current;
    }
    const panel = vscode.window.createWebviewPanel(
      'ollama-agent.localBoard',
      'KarkeDikha Board',
      vscode.ViewColumn.One,
      { enableScripts: true, retainContextWhenHidden: true },
    );
    const instance = new LocalBoardPanel(panel, context, coreManager, provider);
    this.current = instance;
    context.subscriptions.push(instance);
    await instance.refresh();
    return instance;
  }

  private constructor(
    panel: vscode.WebviewPanel,
    private readonly context: vscode.ExtensionContext,
    private readonly coreManager: CoreManager | undefined,
    private readonly provider?: EngineeringBoardProvider,
  ) {
    this.panel = panel;
    panel.onDidDispose(() => this.dispose(), undefined, context.subscriptions);
    panel.webview.onDidReceiveMessage(message => void this.handleMessage(message), undefined, context.subscriptions);

    if (coreManager) {
      this.disposables.push(coreManager.onStatusChange(() => this.scheduleRefresh()));
      this.disposables.push(coreManager.onStoryEvent(() => this.scheduleRefresh()));
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
    for (const d of this.disposables) d.dispose();
    if (LocalBoardPanel.current === this) LocalBoardPanel.current = undefined;
  }

  /** Coalesces bursts of live Core events (or reconnect status changes) into a single re-render instead of one per event. */
  private scheduleRefresh(): void {
    if (this.refreshTimer) return;
    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = undefined;
      void this.refresh();
    }, 150);
  }

  private client() {
    return this.coreManager?.getClient();
  }

  /**
   * De-dupes rapid repeated clicks of the same mutating action (e.g. a
   * double-click on "Archive" before the resulting re-render swaps the DOM
   * out from under it) into a single in-flight mutation. Keyed by
   * action-type + target id so distinct actions/targets are never blocked by
   * each other.
   */
  private async guardDuplicateAction(key: string, fn: () => Promise<void>): Promise<void> {
    if (this.pendingActionIds.has(key)) return;
    this.pendingActionIds.add(key);
    try {
      await fn();
    } finally {
      this.pendingActionIds.delete(key);
    }
  }

  private async handleMessage(message: unknown): Promise<void> {
    if (!message || typeof message !== 'object') return;
    const msg = message as Record<string, unknown>;
    const type = String(msg.type ?? '');
    const actionKey = `${type}:${msg.storyId ?? msg.projectId ?? ''}`;

    try {
      switch (type) {
        case 'refreshBoard':
          await this.refresh();
          break;
        case 'syncBoard':
          await this.guardDuplicateAction(actionKey, async () => {
            if (this.provider) {
              try {
                await this.provider.sync(false);
              } catch (error) {
                vscode.window.showErrorMessage(`Board synchronization failed: ${error instanceof Error ? error.message : String(error)}`);
              }
              await this.refresh();
            }
          });
          break;
        case 'setProjectFilter':
          this.selectedProjectId = String(msg.projectId ?? 'all');
          await this.refresh();
          break;
        case 'setActiveFilter':
          this.activeFilter = msg.activeFilter === 'history' ? 'history' : 'active';
          await this.refresh();
          break;
        case 'createProject':
          await this.guardDuplicateAction('createProject', () => this.createProject());
          break;
        case 'archiveProject':
          await this.guardDuplicateAction(actionKey, () =>
            this.mutate(() => this.client()!.request(`/v1/projects/${msg.projectId}/archive`, { method: 'POST' })),
          );
          break;
        case 'createStory':
          await this.guardDuplicateAction('createStory', () => this.createStory());
          break;
        case 'editStory':
          await this.guardDuplicateAction(actionKey, () => this.editStory(String(msg.storyId ?? '')));
          break;
        case 'transitionStory':
          await this.guardDuplicateAction(actionKey, () =>
            this.mutate(() =>
              this.client()!.request(`/v1/stories/${msg.storyId}/transition`, {
                method: 'POST',
                body: { toStatus: msg.toStatus },
              }),
            ),
          );
          break;
        case 'archiveStory':
          await this.guardDuplicateAction(actionKey, () =>
            this.mutate(() => this.client()!.request(`/v1/stories/${msg.storyId}/archive`, { method: 'POST' })),
          );
          break;
        case 'addComment':
          await this.guardDuplicateAction(actionKey, () => this.addComment(String(msg.storyId ?? '')));
          break;
        case 'restartCore':
          await this.guardDuplicateAction('restartCore', async () => {
            await vscode.commands.executeCommand('ollama-agent.restartKarkeDikhaCore');
            await this.refresh();
          });
          break;
        default:
          break;
      }
    } catch (error) {
      this.reportActionError(error);
      await this.refresh();
    }
  }

  private async mutate(fn: () => Promise<unknown>): Promise<void> {
    if (!this.client()) {
      vscode.window.showWarningMessage('KarkeDikha Core is not connected. Try again once it reconnects.');
      return;
    }
    await fn();
    await this.refresh();
  }

  private reportActionError(error: unknown): void {
    if (error instanceof CoreApiError) {
      vscode.window.showErrorMessage(`Board action failed: ${error.message}`);
    } else {
      vscode.window.showErrorMessage(`Board action failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private async createProject(): Promise<void> {
    const client = this.client();
    if (!client) {
      vscode.window.showWarningMessage('KarkeDikha Core is not connected.');
      return;
    }
    const name = await vscode.window.showInputBox({ prompt: 'New project name', placeHolder: 'e.g. JUGAAD' });
    if (!name?.trim()) return;
    await this.mutate(() => client.request('/v1/projects', { method: 'POST', body: { name: name.trim() } }));
  }

  private async createStory(): Promise<void> {
    const client = this.client();
    if (!client) {
      vscode.window.showWarningMessage('KarkeDikha Core is not connected.');
      return;
    }
    let projectId = this.selectedProjectId !== 'all' ? this.selectedProjectId : undefined;
    if (!projectId) {
      const snapshot = await client.fetchBoardSnapshot();
      const pick = await vscode.window.showQuickPick(
        snapshot.projects.map((p) => ({ label: p.name, id: p.id })),
        { placeHolder: 'Which project is this story for?' },
      );
      if (!pick) return;
      projectId = pick.id;
    }
    const title = await vscode.window.showInputBox({ prompt: 'Story title' });
    if (!title?.trim()) return;
    const storyType = await vscode.window.showQuickPick([...STORY_TYPES], { placeHolder: 'Story type' });
    if (!storyType) return;
    await this.mutate(() =>
      client.request('/v1/stories', { method: 'POST', body: { projectId, title: title.trim(), storyType: storyType as StoryType } }),
    );
  }

  private async editStory(storyId: string): Promise<void> {
    const client = this.client();
    if (!client || !storyId) return;
    const current = await client.request<StoryRecord>(`/v1/stories/${storyId}`);
    const title = await vscode.window.showInputBox({ prompt: 'Edit story title', value: current.title });
    if (!title?.trim() || title.trim() === current.title) return;
    await this.mutate(() => client.request(`/v1/stories/${storyId}`, { method: 'PATCH', body: { title: title.trim(), expectedRevision: current.revision } }));
  }

  private async addComment(storyId: string): Promise<void> {
    const client = this.client();
    if (!client || !storyId) return;
    const body = await vscode.window.showInputBox({ prompt: 'Comment' });
    if (!body?.trim()) return;
    await this.mutate(() => client.request(`/v1/stories/${storyId}/comments`, { method: 'POST', body: { body: body.trim() } }));
  }

  private async refresh(): Promise<void> {
    const snapshot = await this.snapshot();
    this.panel.webview.html = renderBoardHtml(snapshot, this.panel.webview.cspSource);
  }

  private async snapshot(): Promise<BoardSnapshot> {
    const connectionStatus = this.coreManager?.getStatus() ?? { state: 'unavailable' as const };
    const client = this.client();

    let projects: ProjectRecord[] = [];
    let cards: BoardCard[] = [];

    if (client) {
      try {
        const board = await client.fetchBoardSnapshot(this.selectedProjectId !== 'all' ? this.selectedProjectId : undefined);
        projects = board.projects;
        const projectNameById = new Map(projects.map((p) => [p.id, p.name]));
        const wantArchived = this.activeFilter === 'history';
        cards = board.stories
          .filter((s) => Boolean(s.archivedAt) === wantArchived)
          .map((s) => storyToCard(s, projectNameById.get(s.projectId)));
      } catch (error) {
        Logger.warn('[Board] failed to fetch Core board snapshot:', error);
      }
    }

    // GitHub Sync is a capability layered on top of the Board, never a precondition for it: the
    // Board above is already fully populated from the Core regardless of workspace/Git/GitHub
    // state. This section only ever narrows what the "Sync GitHub" button can do, and always
    // explains why when it can't — it never turns into a "Board unavailable" condition.
    let engineeringAvailable = false;
    let engineeringError: string | undefined;
    let githubSyncDisabledReason: string | undefined;
    if (this.provider) {
      try {
        const raw = (await this.provider.boardSnapshot()) as {
          assignments?: Array<{ storyId: string; workerId: string; state: string }>;
          ci?: Array<{ storyId: string; conclusion: string; runId: string }>;
        };
        const assignments = new Map((raw.assignments ?? []).map(item => [item.storyId, item]));
        const ci = new Map((raw.ci ?? []).map(item => [item.storyId, item]));
        cards = cards.map(card => {
          const assignment = assignments.get(card.id);
          const incident = ci.get(card.id);
          return assignment || incident ? {
            ...card,
            owner: assignment?.workerId ?? card.owner,
            blockedReason: incident && incident.conclusion !== 'success'
              ? `CI incident ${incident.runId}: ${incident.conclusion}`
              : card.blockedReason,
          } : card;
        });
        engineeringAvailable = true;
      } catch (error) {
        engineeringError = error instanceof Error ? error.message : String(error);
        githubSyncDisabledReason = engineeringError;
        Logger.warn('[LocalBoard] Engineering snapshot unavailable:', error);
      }
    } else {
      githubSyncDisabledReason = 'GitHub Sync requires an open workspace with an Engineering Organization provisioned.';
    }

    return {
      generatedAt: new Date().toISOString(),
      connection: { state: connectionStatus.state, detail: connectionStatus.detail },
      projects,
      selectedProjectId: this.selectedProjectId,
      activeFilter: this.activeFilter,
      cards: dedupeCards(cards),
      engineeringAvailable,
      engineeringError,
      githubSyncDisabledReason,
    };
  }
}

function storyToCard(story: StoryRecord, projectName: string | undefined): BoardCard {
  return {
    id: story.id,
    title: story.title,
    status: story.status,
    kind: story.storyType,
    projectId: story.projectId,
    projectName,
    revision: story.revision,
    archived: Boolean(story.archivedAt),
    source: 'core',
  };
}

function dedupeCards(cards: BoardCard[]): BoardCard[] {
  const byId = new Map<string, BoardCard>();
  for (const card of cards) byId.set(`${card.source}:${card.id}`, card);
  return [...byId.values()];
}

const STORY_STATUS_OPTIONS: StoryStatus[] = [
  'inbox',
  'discovery',
  'ready',
  'assigned',
  'planning',
  'proposal_approval',
  'implementing',
  'review',
  'validation',
  'delivery_approval',
  'merge_queue',
  'done',
  'blocked',
  'failed',
  'cancelled',
  'deferred',
];

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch] ?? ch);
}

function connectionBanner(connection: BoardSnapshot['connection']): string {
  switch (connection.state) {
    case 'connected':
      return '';
    case 'starting':
      return '<div class="banner info">Starting KarkeDikha Core…</div>';
    case 'reconnecting':
      return `<div class="banner warn">Reconnecting to KarkeDikha Core${connection.detail ? ' — ' + escapeHtml(connection.detail) : ''}…</div>`;
    case 'incompatible':
      return `<div class="banner error">KarkeDikha Core version is incompatible with this extension. <button id="restartCore" data-testid="restart-core-button">Restart Core</button></div>`;
    case 'authentication_failed':
      return `<div class="banner error">Could not authenticate with KarkeDikha Core. ${escapeHtml(connection.detail ?? '')}</div>`;
    case 'database_failed':
      return `<div class="banner error">KarkeDikha Core database failed to start: ${escapeHtml(connection.detail ?? 'see Core logs')}</div>`;
    default:
      return `<div class="banner error">KarkeDikha Core is unavailable. ${escapeHtml(connection.detail ?? '')} <button id="restartCore" data-testid="restart-core-button">Restart Core</button></div>`;
  }
}

/**
 * A connection-state indicator that is always rendered (unlike
 * connectionBanner(), which is empty when connected) so "Core is Connected"
 * is a positive, directly assertable visible UI state rather than merely the
 * absence of an error banner.
 */
function connectionStateChip(connection: BoardSnapshot['connection']): string {
  const labels: Record<string, string> = {
    connected: 'Connected',
    starting: 'Starting…',
    reconnecting: 'Reconnecting…',
    incompatible: 'Incompatible',
    authentication_failed: 'Authentication Failed',
    database_failed: 'Database Failed',
    unavailable: 'Unavailable',
  };
  const label = labels[connection.state] ?? connection.state;
  return `<span id="connectionState" class="chip conn-${escapeHtml(connection.state)}" data-testid="connection-state" data-state="${escapeHtml(connection.state)}">${escapeHtml(label)}</span>`;
}

function renderBoardHtml(snapshot: BoardSnapshot, cspSource: string): string {
  const nonce = crypto.randomBytes(16).toString('hex');
  const serialized = JSON.stringify({
    cards: snapshot.cards,
    projects: snapshot.projects,
    selectedProjectId: snapshot.selectedProjectId,
    activeFilter: snapshot.activeFilter,
    statusOptions: STORY_STATUS_OPTIONS,
    githubSyncDisabledReason: snapshot.githubSyncDisabledReason ?? null,
  }).replace(/</g, '\\u003c');

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${nonce}' ${cspSource}; script-src 'nonce-${nonce}';">
<title>KarkeDikha Board</title>
<style nonce="${nonce}">
:root{color-scheme:light dark}body{font:13px var(--vscode-font-family);color:var(--vscode-foreground);background:var(--vscode-editor-background);margin:0;padding:16px}
.toolbar{display:flex;align-items:center;gap:8px;margin-bottom:14px;flex-wrap:wrap}.toolbar h1{font-size:18px;margin:0 auto 0 0}
.toolbar button,.toolbar select{background:var(--vscode-button-background);color:var(--vscode-button-foreground);border:0;border-radius:4px;padding:7px 11px;cursor:pointer}
.toolbar button.secondary,.toolbar select{background:var(--vscode-dropdown-background);color:var(--vscode-dropdown-foreground);border:1px solid var(--vscode-dropdown-border)}
#connectionState.chip{font-weight:600}#connectionState.conn-connected{background:var(--vscode-testing-iconPassed,#2ea043);color:#fff}
#connectionState.conn-reconnecting,#connectionState.conn-starting{background:var(--vscode-editorWarning-foreground,#cca700);color:#000}
#connectionState.conn-incompatible,#connectionState.conn-authentication_failed,#connectionState.conn-database_failed,#connectionState.conn-unavailable{background:var(--vscode-errorForeground,#f14c4c);color:#fff}
.meta{opacity:.72;margin-bottom:12px}
.banner{border-radius:6px;padding:8px 12px;margin-bottom:10px}
.banner.info{background:var(--vscode-editorInfo-background,transparent);border:1px solid var(--vscode-editorInfo-border,var(--vscode-panel-border))}
.banner.warn{background:var(--vscode-editorWarning-background,transparent);border:1px solid var(--vscode-editorWarning-border,var(--vscode-panel-border));color:var(--vscode-editorWarning-foreground)}
.banner.error{background:var(--vscode-editorError-background,transparent);border:1px solid var(--vscode-editorError-border,var(--vscode-panel-border));color:var(--vscode-errorForeground)}
.board{display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:10px;align-items:start;overflow:auto;padding-bottom:12px}
.card{background:var(--vscode-editorWidget-background);border:1px solid var(--vscode-widget-border);border-radius:6px;padding:9px;display:flex;flex-direction:column;gap:6px}
.title{font-weight:600}.chips{display:flex;gap:5px;flex-wrap:wrap}.chip{font-size:11px;padding:2px 6px;border-radius:999px;background:var(--vscode-badge-background);color:var(--vscode-badge-foreground)}
.blocked{color:var(--vscode-errorForeground)}.empty{opacity:.55;padding:10px}.warning{color:var(--vscode-editorWarning-foreground);margin-bottom:10px}
.card-actions{display:flex;gap:6px;flex-wrap:wrap;align-items:center}
.card-actions select,.card-actions button{font-size:11px;padding:3px 6px}
</style>
</head>
<body>
${connectionBanner(snapshot.connection)}
<div class="toolbar">
  <h1>KarkeDikha Board</h1>
  ${connectionStateChip(snapshot.connection)}
  <select id="projectFilter" data-testid="project-filter"></select>
  <select id="activeFilter" data-testid="active-filter"><option value="active">Active</option><option value="history">History</option></select>
  <button id="newProject" class="secondary" data-testid="new-project-button">New Project</button>
  <button id="newStory" data-testid="new-story-button">New Story</button>
  <button id="refresh" class="secondary" data-testid="refresh-button">Refresh</button>
  <button id="sync" class="secondary" data-testid="sync-github-button">Sync GitHub</button>
</div>
<div id="githubSyncNote" class="warning"></div>
<div id="warning" class="warning"></div><div id="meta" class="meta"></div><main id="board" class="board"></main>
<script nonce="${nonce}">
const vscode = acquireVsCodeApi();
const data = ${serialized};

const projectFilter = document.getElementById('projectFilter');
projectFilter.innerHTML = '<option value="all">All Projects</option>' + data.projects.map(p => '<option value="'+p.id+'"'+(p.id===data.selectedProjectId?' selected':'')+'>'+escapeHtml(p.name)+'</option>').join('');
projectFilter.addEventListener('change', () => vscode.postMessage({ type: 'setProjectFilter', projectId: projectFilter.value }));

const activeFilter = document.getElementById('activeFilter');
activeFilter.value = data.activeFilter;
activeFilter.addEventListener('change', () => vscode.postMessage({ type: 'setActiveFilter', activeFilter: activeFilter.value }));

document.getElementById('refresh').addEventListener('click', () => vscode.postMessage({ type: 'refreshBoard' }));
const syncBtn = document.getElementById('sync');
syncBtn.addEventListener('click', () => vscode.postMessage({ type: 'syncBoard' }));
if (data.githubSyncDisabledReason) {
  syncBtn.disabled = true;
  syncBtn.title = data.githubSyncDisabledReason;
  document.getElementById('githubSyncNote').textContent = 'GitHub Sync disabled: ' + data.githubSyncDisabledReason;
}
document.getElementById('newProject').addEventListener('click', () => vscode.postMessage({ type: 'createProject' }));
document.getElementById('newStory').addEventListener('click', () => vscode.postMessage({ type: 'createStory' }));
const restartBtn = document.getElementById('restartCore');
if (restartBtn) restartBtn.addEventListener('click', () => vscode.postMessage({ type: 'restartCore' }));

const board = document.getElementById('board');
document.getElementById('meta').textContent = data.cards.length + ' card(s)';
if (!data.cards.length) board.innerHTML = '<div class="empty">No cards for this filter.</div>';
for (const card of data.cards) {
  const el = document.createElement('article');
  el.className = 'card';
  el.dataset.testid = 'board-card';
  el.dataset.storyId = card.id;
  el.dataset.status = card.status;
  el.dataset.source = card.source;
  const chips = [card.projectName, card.kind, card.status, card.points ? card.points + ' pt' : '', card.owner || '', card.source]
    .filter(Boolean).map(v => '<span class="chip">' + escapeHtml(String(v)) + '</span>').join('');
  el.innerHTML = '<div class="title" data-testid="board-card-title">' + escapeHtml(card.title) + '</div><div class="chips">' + chips + '</div>'
    + (typeof card.progress === 'number' ? '<div class="meta">' + card.progress + '% complete</div>' : '')
    + (card.blockedReason ? '<div class="blocked">' + escapeHtml(card.blockedReason) + '</div>' : '');

  if (card.source === 'core') {
    const actions = document.createElement('div');
    actions.className = 'card-actions';
    if (!card.archived) {
      const select = document.createElement('select');
      select.dataset.testid = 'transition-select';
      select.dataset.storyId = card.id;
      select.innerHTML = data.statusOptions.map(s => '<option value="'+s+'"'+(s===card.status?' selected':'')+'>'+s+'</option>').join('');
      select.addEventListener('change', () => vscode.postMessage({ type: 'transitionStory', storyId: card.id, toStatus: select.value }));
      actions.appendChild(select);

      const archiveBtn = document.createElement('button');
      archiveBtn.textContent = 'Archive';
      archiveBtn.dataset.testid = 'archive-story-button';
      archiveBtn.dataset.storyId = card.id;
      archiveBtn.addEventListener('click', () => vscode.postMessage({ type: 'archiveStory', storyId: card.id }));
      actions.appendChild(archiveBtn);

      const editBtn = document.createElement('button');
      editBtn.textContent = 'Edit';
      editBtn.dataset.testid = 'edit-story-button';
      editBtn.dataset.storyId = card.id;
      editBtn.addEventListener('click', () => vscode.postMessage({ type: 'editStory', storyId: card.id }));
      actions.appendChild(editBtn);
    }
    const commentBtn = document.createElement('button');
    commentBtn.textContent = 'Comment';
    commentBtn.dataset.testid = 'comment-story-button';
    commentBtn.dataset.storyId = card.id;
    commentBtn.addEventListener('click', () => vscode.postMessage({ type: 'addComment', storyId: card.id }));
    actions.appendChild(commentBtn);
    el.appendChild(actions);
  }
  board.appendChild(el);
}

function escapeHtml(value) { return String(value).replace(/[&<>"']/g, ch => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch])); }
</script>
</body></html>`;
}
