export type MemoryScope = 'user' | 'project' | 'repository' | 'task' | 'agent' | 'operational';
export type MemorySensitivity = 'public' | 'internal' | 'confidential' | 'restricted';

export interface MemoryProvenance {
  source: string;
  taskId?: string;
  eventId?: string;
  createdBy: 'user' | 'agent' | 'system';
}

export interface MemoryRecord {
  id: string;
  scope: MemoryScope;
  key: string;
  value: string;
  tags: string[];
  confidence: number;
  sensitivity: MemorySensitivity;
  provenance: MemoryProvenance;
  createdAt: string;
  updatedAt: string;
  expiresAt?: string;
  pinned: boolean;
  supersedes?: string[];
}

export interface MemorySearchRequest {
  query: string;
  scopes?: MemoryScope[];
  tags?: string[];
  maximumSensitivity?: MemorySensitivity;
  limit?: number;
  now?: string;
}

export interface MemorySearchResult {
  score: number;
  record: MemoryRecord;
}
