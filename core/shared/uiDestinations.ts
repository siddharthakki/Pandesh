/**
 * The places in Pandesh's own window that the assistant may open with `navigate_to`, per interface. This list is the
 * only source of destinations: a place missing here is not offered to the model and cannot be "opened". Each target is
 * an instruction for the window's own navigation (its view switch); each `where` is the same place in words, for the
 * user to find it again. Pandesh has one interface (v2); the Classic interface was retired.
 *
 * Kept free of Node APIs: Core, the desktop host and the renderer read it.
 */
export type UiSurface = 'v2';

export interface UiDestination {
  id: string;
  label: string;
  /** Words people use for it, to suggest the nearest real place for a request that has none. */
  keywords: readonly string[];
  targets: Partial<Record<UiSurface, string>>;
  where: Partial<Record<UiSurface, string>>;
}

export const UI_DESTINATIONS: readonly UiDestination[] = [
  { id: 'home', label: 'Home and chats', keywords: ['home', 'chat', 'chats', 'conversation', 'start'],
    targets: { v2: 'view:chat' }, where: { v2: 'Pandesh (top of the left rail)' } },
  { id: 'google_setup', label: 'Google account setup (Gmail, Calendar)', keywords: ['google', 'gmail', 'calendar', 'oauth', 'credentials', 'client', 'account', 'sign in', 'email'],
    targets: { v2: 'view:connections' },
    where: { v2: 'System (bottom of the left rail) → Connections' } },
  { id: 'connected_services', label: 'Connected services and their status', keywords: ['connected', 'services', 'connectors', 'connections', 'integrations', 'accounts', 'status'],
    targets: { v2: 'view:tools#connectors' },
    where: { v2: 'System → Tools & Skills → Connectors' } },
  { id: 'settings', label: 'Settings', keywords: ['settings', 'preferences', 'options', 'setup', 'configure', 'theme'],
    targets: { v2: 'menu:system' },
    where: { v2: 'System (bottom of the left rail): Connections, Phone, Automations, Tools & Skills, Processes, Software & Services, About & diagnostics, theme' } },
  { id: 'permission_mode', label: 'Permission mode (Ask / Auto / Plan only)', keywords: ['permission', 'permissions', 'mode', 'auto', 'ask', 'plan', 'approvals', 'approve'],
    targets: { v2: 'focus:permission' },
    where: { v2: 'the permission menu under the message box' } },
  { id: 'model_menu', label: 'Model choice', keywords: ['model', 'models', 'llm', 'gemma', 'qwen', 'ollama'],
    targets: { v2: 'focus:model' },
    where: { v2: 'the model menu under the message box' } },
  { id: 'tasks', label: 'Tasks and their real status', keywords: ['tasks', 'board', 'missions', 'running', 'status', 'jobs'],
    targets: { v2: 'view:board' }, where: { v2: 'Board (left rail)' } },
  { id: 'software_discovery', label: 'Software & Services (Software Discovery)', keywords: ['software', 'discovery', 'installed', 'updates', 'ports', 'services', 'versions', 'programs'],
    targets: { v2: 'view:software' }, where: { v2: 'System → Software & Services' } },
  { id: 'projects', label: 'Projects', keywords: ['projects', 'project', 'repositories', 'stories'],
    targets: { v2: 'space:projects' }, where: { v2: 'Spaces (left rail) → Projects' } },
  { id: 'team', label: 'Team (specialist agents)', keywords: ['team', 'agents', 'specialists'],
    targets: { v2: 'view:team' }, where: { v2: 'Team (left rail)' } },
  { id: 'tools_skills', label: 'Tools & Skills', keywords: ['tools', 'skills', 'capabilities', 'mcp'],
    targets: { v2: 'view:tools' }, where: { v2: 'System → Tools & Skills' } },
  { id: 'processes', label: 'Processes Pandesh started', keywords: ['processes', 'process', 'programs running'],
    targets: { v2: 'view:processes' }, where: { v2: 'System → Processes' } },
  { id: 'second_brain', label: 'Second Brain (memories, notes, documents; notes are on its Notes tab)', keywords: ['brain', 'memory', 'memories', 'notes', 'documents', 'knowledge'],
    targets: { v2: 'view:brain' }, where: { v2: 'Spaces → Second Brain' } },
  { id: 'automations', label: 'Automations (routines, daily brief, reminders and timers, command queue)', keywords: ['automations', 'routines', 'schedule', 'brief', 'queue', 'reminders', 'reminder', 'timers', 'timer'],
    targets: { v2: 'space:automations' }, where: { v2: 'System → Automations' } },
  { id: 'media_studio', label: 'Media Studio', keywords: ['media', 'images', 'image', 'studio', 'pictures'],
    targets: { v2: 'space:media' }, where: { v2: 'Spaces → Media Studio' } },
  { id: 'social_studio', label: 'Social Studio', keywords: ['social', 'posts', 'drafts'],
    targets: { v2: 'space:social' }, where: { v2: 'Spaces → Social Studio' } },
  { id: 'wish_to_reality', label: 'Wish to Reality', keywords: ['wish', 'goals', 'offers'],
    targets: { v2: 'space:wish' }, where: { v2: 'Spaces → Wish to Reality' } },
  { id: 'ai_radar', label: 'AI Radar', keywords: ['radar', 'releases', 'advisories', 'news'],
    targets: { v2: 'view:radar' }, where: { v2: 'Spaces → AI Radar' } },
  { id: 'revenue', label: 'Revenue', keywords: ['revenue', 'leads', 'sales', 'money'],
    targets: { v2: 'view:revenue' }, where: { v2: 'Spaces → Revenue' } },
  { id: 'cloud_providers', label: 'Free cloud providers', keywords: ['cloud', 'providers', 'openrouter', 'api key'],
    targets: { v2: 'view:connections' }, where: { v2: 'System → Connections → Free cloud models (then pick the model in the model menu under the message box)' } },
  { id: 'chats', label: 'All chats (search, rename, pin, archive, export)', keywords: ['chats', 'history', 'conversations', 'archive', 'archived', 'export', 'rename', 'pin'],
    targets: { v2: 'view:chat' }, where: { v2: 'Pandesh (top of the left rail) → the chats button at the top left of the chat' } },
  { id: 'diagnostics', label: 'About & diagnostics (version, update, diagnostics, this PC)', keywords: ['about', 'version', 'build', 'update', 'diagnostics', 'hardware', 'gpu', 'health'],
    targets: { v2: 'view:about' }, where: { v2: 'System → About & diagnostics' } },
];

/** The window's interface. A request from an older window that still says `classic` gets the only interface there is. */
export function parseUiSurface(value: unknown): UiSurface | undefined {
  return value === 'v2' || value === 'classic' ? 'v2' : undefined;
}

/** The destinations that really exist in this interface. */
export function destinationsFor(surface: UiSurface): UiDestination[] {
  return UI_DESTINATIONS.filter((d) => Boolean(d.targets[surface]));
}

export function destinationById(id: string): UiDestination | undefined {
  return UI_DESTINATIONS.find((d) => d.id === id);
}

/** Real places in this interface whose words overlap the request, best first (for "that does not exist; nearest is …"). */
export function nearestDestinations(request: string, surface: UiSurface, limit = 2): UiDestination[] {
  const words = new Set(String(request ?? '').toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 2));
  return destinationsFor(surface)
    .map((d) => ({ d, score: [...d.keywords, ...d.label.toLowerCase().split(/[^a-z0-9]+/)].filter((k) => k.split(' ').every((w) => words.has(w))).length }))
    .filter(({ score }) => score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map(({ d }) => d);
}
