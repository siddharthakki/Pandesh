import type { CoreClient } from './CoreClient';
import type { ProjectRecord } from '../../core/shared/wireTypes';

/** Finds an existing project by exact (case-insensitive) name, or creates one. Used to give chat-created stories a sensible project home without duplicating a project on every call. */
export async function getOrCreateProjectByName(client: CoreClient, name: string): Promise<ProjectRecord> {
  const trimmed = name.trim() || 'Workspace';
  const existing = await client.request<{ projects: ProjectRecord[] }>('/v1/projects', { query: { limit: 200 } });
  const match = existing.projects.find((p) => p.name.toLowerCase() === trimmed.toLowerCase());
  if (match) return match;
  return client.request<ProjectRecord>('/v1/projects', { method: 'POST', body: { name: trimmed } });
}
