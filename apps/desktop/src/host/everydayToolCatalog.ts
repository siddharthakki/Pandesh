import type { EverydayToolCatalogEntry } from '../ipc';
import type { ConnectorStatus } from '../../../../core/shared/wireTypes';

const CONNECTOR_CATALOG_ID: Record<ConnectorStatus['id'], string> = {
  gmail: 'gmail',
  google_calendar: 'calendar',
  whatsapp: 'whatsapp',
  printer: 'printer',
};

/** `ConnectorState` -> catalog `availability` + human detail. Truthful:
 * `connected` is the only state that renders `available` (requirement #7 —
 * "Not connected" until a real provider/device probe succeeds). */
function connectorEntry(status: ConnectorStatus): EverydayToolCatalogEntry {
  const availability: EverydayToolCatalogEntry['availability'] = status.state === 'connected' ? 'available' : 'not_connected';
  const detail = status.state === 'connected'
    ? `Connected. ${status.reason ?? ''}`.trim()
    : status.reason ?? `${status.label}: ${status.state.replace(/_/g, ' ')}.`;
  return {
    id: CONNECTOR_CATALOG_ID[status.id],
    label: status.id === 'google_calendar' ? 'Calendar / Appointments' : status.label,
    availability,
    detail,
    connectorState: status.state,
    permissions: status.permissions,
  };
}

/**
 * Tools tab catalog — single source for live refresh and empty/offline snapshots.
 * `connectorStatuses` (from `CoreClient.listConnectors()`) overrides the four
 * governed connector entries with Core's live state; omitted (Core
 * unreachable, or an offline/empty snapshot) falls back to the honest static
 * `not_connected` defaults below — never a fabricated `available`.
 */
export function everydayToolCatalog(connectorStatuses?: ConnectorStatus[]): EverydayToolCatalogEntry[] {
  const live = new Map((connectorStatuses ?? []).map((status) => [status.id, connectorEntry(status)]));
  return [
    { id: 'notes', label: 'Notes', availability: 'available', detail: 'Create, find, edit, and delete notes in Core.' },
    { id: 'reminders', label: 'Reminders', availability: 'available', detail: 'Create, list, complete, and cancel reminders in Core.' },
    {
      id: 'desktop-alerts',
      label: 'Desktop Alerts',
      availability: 'available',
      detail: 'Scheduled notifications while Jarvis is running (including tray).',
    },
    {
      id: 'command-queue',
      label: 'Command Queue',
      availability: 'available',
      detail: 'Durable waiting commands with fresh confirmation before each run.',
    },
    {
      id: 'web-research',
      label: 'Governed Web Research',
      availability: process.env.KARKEDIKHA_SEARXNG_URL?.trim() ? 'available' : 'not_connected',
      detail: process.env.KARKEDIKHA_SEARXNG_URL?.trim()
        ? 'Core-owned bounded research with explicit network approval and cited sources.'
        : 'Set KARKEDIKHA_SEARXNG_URL for the Core service to enable governed web research.',
    },
    {
      id: 'pc-health',
      label: 'PC Health',
      availability: 'available',
      detail: 'Read-only CPU, memory, GPU, and selected-workspace disk telemetry.',
    },
    live.get('google_calendar') ?? { id: 'calendar', label: 'Calendar / Appointments', availability: 'not_connected', detail: 'Integration follows this tools slice.' },
    live.get('gmail') ?? { id: 'gmail', label: 'Gmail', availability: 'not_connected', detail: 'Integration follows this tools slice.' },
    live.get('whatsapp') ?? { id: 'whatsapp', label: 'WhatsApp', availability: 'not_connected', detail: 'Integration follows this tools slice.' },
    live.get('printer') ?? { id: 'printer', label: 'Printer', availability: 'not_connected', detail: 'Integration follows this tools slice.' },
    { id: 'weather', label: 'Weather', availability: 'not_connected', detail: 'Planned integration; not connected.' },
    { id: 'news', label: 'News', availability: 'not_connected', detail: 'Planned integration; not connected.' },
    {
      id: 'image-generation-studio',
      label: 'Image Generation Studio',
      availability: 'available',
      detail:
        'Jarvis → Core → Studio (:8989) → ComfyUI (:8188). Governed still-image generation with an exact pre-generation approval and a verified artifact gallery — open the Artifacts tab, or ask in chat ("generate an image of…").',
    },
    {
      id: 'pc-health-storage',
      label: 'Storage Advisor',
      availability: 'not_connected',
      detail:
        'Planned: fixed-drive low-space monitor and bounded storage scan. Cleanup remains a later governed capability.',
    },
  ];
}
