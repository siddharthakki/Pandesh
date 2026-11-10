/**
 * The v2 window's reading of a navigate_to target (core/shared/uiDestinations.ts). Only real views, spaces, the System
 * menu and the two composer menus are accepted; anything else is refused, so the window never pretends to open it.
 */
/** The v2 views and spaces navigate_to may open (a subset of App's View and Workspaces' SpaceId). */
export type V2View = 'chat' | 'board' | 'team' | 'connections' | 'tools' | 'software' | 'processes' | 'brain' | 'radar' | 'revenue';
export type V2Space = 'projects' | 'wish' | 'social' | 'media' | 'automations';

export type V2Action =
  | { kind: 'view'; view: V2View; toolsTab?: 'connectors' }
  | { kind: 'space'; space: V2Space }
  | { kind: 'menu' }
  | { kind: 'focus'; id: 'v2-permission-mode' | 'v2-model' }
  | { kind: 'unknown'; detail: string };

const VIEWS: ReadonlySet<string> = new Set(['chat', 'board', 'team', 'connections', 'tools', 'software', 'processes', 'brain', 'radar', 'revenue']);
const SPACES: ReadonlySet<string> = new Set(['projects', 'wish', 'social', 'media', 'automations']);

export function parseV2Target(target: string): V2Action {
  const [kind, rest = ''] = String(target ?? '').split(':');
  if (kind === 'view') {
    const [view, tab] = rest.split('#');
    if (!VIEWS.has(view)) return { kind: 'unknown', detail: `v2 has no view "${view}"` };
    return tab === 'connectors' && view === 'tools' ? { kind: 'view', view: 'tools', toolsTab: 'connectors' } : { kind: 'view', view: view as V2View };
  }
  if (kind === 'space') return SPACES.has(rest) ? { kind: 'space', space: rest as V2Space } : { kind: 'unknown', detail: `v2 has no space "${rest}"` };
  if (kind === 'menu' && rest === 'system') return { kind: 'menu' };
  if (kind === 'focus' && (rest === 'permission' || rest === 'model')) return { kind: 'focus', id: rest === 'permission' ? 'v2-permission-mode' : 'v2-model' };
  return { kind: 'unknown', detail: `v2 cannot open "${target}"` };
}
